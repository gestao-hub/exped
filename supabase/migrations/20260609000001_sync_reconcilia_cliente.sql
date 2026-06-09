-- 20260609000001_sync_reconcilia_cliente.sql
-- FIX do sync hub→nuvem travado com FK pedidos_cliente_id_fkey.
--
-- Causa: clientes importados na NUVEM ganharam ids novos para CNPJs que o HUB já
-- tinha com ids próprios. Resultado: (a) o cliente do hub não conseguia subir
-- (unique parcial em (empresa_id, cnpj_cpf)) e (b) o pedido que o aponta ficava
-- órfão na nuvem (FK pedidos_cliente_id_fkey) — quebrando o lote inteiro do push,
-- então NADA novo sincronizava.
--
-- Correção (idempotente; aplica no cloud e, via release, no hub):
-- 1) sync_push_upsert: ao gravar um CLIENTE cujo CNPJ já existe com OUTRO id,
--    devolve o cliente existente (não duplica) — destrava o lote.
-- 2) trigger em pedidos: ao gravar um PEDIDO cujo cliente_id não existe, reconcilia
--    pelo cliente_cnpj_cpf denormalizado (acha o cliente certo); se não achar, solta
--    o vínculo (cliente_id = null) preservando nome/CNPJ/endereço já no pedido.
-- (Mantém o bloco de setval da numero_mapa_seq da 0005.)

-- Índice por CNPJ/CPF só-dígitos (acelera a reconciliação por dígitos abaixo).
create index if not exists clientes_cnpj_digits_idx
  on public.clientes (empresa_id, (regexp_replace(coalesce(cnpj_cpf,''), '\D', '', 'g')));

create or replace function public.sync_push_upsert(p_table text, p_row jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_set  text;
  v_pk   text := 'id';
  v_has_empresa boolean;
  v_guard text := '';
  v_result jsonb;
  v_existing jsonb;
begin
  if p_table not in (
    'clientes','pedidos','pedido_pontos_retirada','pedido_itens',
    'ordens_servico','os_itens','os_servicos','os_notificacoes'
  ) then
    raise exception 'sync_push_upsert: tabela não permitida %', p_table;
  end if;

  -- (1) Reconciliação de CLIENTE por CNPJ: o mesmo CNPJ pode existir com id diferente
  -- (import na nuvem vs criado no hub). NÃO duplica: devolve o cliente existente (id
  -- canônico vence). Os pedidos reconciliam o vínculo pelo CNPJ (trigger abaixo).
  -- Compara por DÍGITOS (import gravou CNPJ formatado; agente manda só dígitos).
  if p_table = 'clientes' and nullif(p_row->>'cnpj_cpf','') is not null then
    select to_jsonb(c.*) into v_existing
    from public.clientes c
    where c.empresa_id = (p_row->>'empresa_id')::uuid
      and regexp_replace(coalesce(c.cnpj_cpf,''), '\D', '', 'g')
          = regexp_replace(p_row->>'cnpj_cpf', '\D', '', 'g')
      and c.id <> (p_row->>'id')::uuid
    limit 1;
    if v_existing is not null then
      return v_existing;
    end if;
  end if;

  set local exped.sync = 'on';

  select string_agg(format('%I = excluded.%I', c.column_name, c.column_name), ', ')
    into v_set
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.table_name = p_table
    and c.column_name <> v_pk
    and c.column_name in (select jsonb_object_keys(p_row));

  select exists(
    select 1 from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = p_table
      and c.column_name = 'empresa_id'
  ) into v_has_empresa;

  if v_has_empresa then
    v_guard := format(
      ' where public.%I.empresa_id = ($1->>%L)::uuid',
      p_table, 'empresa_id'
    );
  end if;

  execute format(
    'insert into public.%I select * from jsonb_populate_record(null::public.%I, $1) ' ||
    'on conflict (%I) do update set %s%s returning to_jsonb(public.%I.*)',
    p_table, p_table, v_pk, v_set, v_guard, p_table
  )
  using p_row
  into v_result;

  -- Mantém a sequence de numero_mapa à frente (fix de recorrência — ver 0005).
  if p_table = 'pedidos' and (p_row ? 'numero_mapa') and nullif(p_row->>'numero_mapa','') is not null then
    perform pg_advisory_xact_lock(hashtext('pedidos_numero_mapa_seq'));
    perform setval(
      'public.pedidos_numero_mapa_seq',
      greatest(
        (select last_value from public.pedidos_numero_mapa_seq),
        (p_row->>'numero_mapa')::bigint
      )
    );
  end if;

  return v_result;
end $$;

revoke all on function public.sync_push_upsert(text, jsonb) from public, anon, authenticated;

-- (2) Reconcilia o cliente_id do pedido ao gravar (sync OU app). Roda antes da FK.
create or replace function public.pedido_reconcilia_cliente()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.cliente_id is not null
     and not exists (select 1 from public.clientes where id = new.cliente_id) then
    if nullif(new.cliente_cnpj_cpf,'') is not null then
      -- casa por DÍGITOS (tolera formato: "026.984.799-57" vs "02698479957")
      select id into new.cliente_id
      from public.clientes
      where empresa_id = new.empresa_id
        and regexp_replace(coalesce(cnpj_cpf,''), '\D', '', 'g')
            = regexp_replace(new.cliente_cnpj_cpf, '\D', '', 'g')
      limit 1;
    else
      new.cliente_id := null;
    end if;
    -- ainda inexistente (CNPJ não casou) → solta o vínculo (dados ficam no pedido)
    if new.cliente_id is not null
       and not exists (select 1 from public.clientes where id = new.cliente_id) then
      new.cliente_id := null;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists pedidos_reconcilia_cliente on public.pedidos;
create trigger pedidos_reconcilia_cliente
  before insert or update on public.pedidos
  for each row execute function public.pedido_reconcilia_cliente();
