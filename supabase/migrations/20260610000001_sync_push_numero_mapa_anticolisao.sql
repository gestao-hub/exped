-- 20260610000001_sync_push_numero_mapa_anticolisao.sql
-- Blindagem do sync hub→nuvem contra colisão de numero_mapa.
--
-- Causa: numero_mapa tem UNIQUE global e é gerado por DOIS lados independentes
-- (sequence local do hub + sequence da nuvem). Uma venda criada offline no hub
-- pode receber um numero que a nuvem já usou (ex.: ingest do agente ou venda
-- online). No push, o INSERT do pedido do hub viola pedidos_numero_mapa_key →
-- o lote inteiro de pedidos falha (HTTP 500) → o sync trava e NADA mais sobe.
-- (Foi o que aconteceu em 2026-06-10 com o numero_mapa=386.)
--
-- Correção (idempotente): no recebedor sync_push_upsert, ANTES do upsert, se o
-- numero_mapa que está chegando já pertence a OUTRO pedido (id diferente),
-- renumera o pedido que chega com nextval da sequence em vez de quebrar o lote.
-- O numero novo volta pro hub no retorno (to_jsonb da canônica) → o hub se
-- renumera no upsert. Mantém o bloco de cliente (0009) e o setval (0005).

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

  -- (1) Reconciliação de CLIENTE por CNPJ (ver 0009): mesmo CNPJ com id diferente
  -- (import na nuvem vs criado no hub) → devolve o existente (não duplica).
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

  -- (1.5) ANTI-COLISÃO de numero_mapa (UNIQUE global): se o numero que chega já é
  -- de OUTRO pedido, renumera o que chega com a sequence (não quebra o lote).
  if p_table = 'pedidos'
     and (p_row ? 'numero_mapa')
     and nullif(p_row->>'numero_mapa','') is not null then
    perform pg_advisory_xact_lock(hashtext('pedidos_numero_mapa_seq'));
    if exists (
      select 1 from public.pedidos
      where numero_mapa = (p_row->>'numero_mapa')::bigint
        and id <> (p_row->>'id')::uuid
    ) then
      p_row := jsonb_set(
        p_row, '{numero_mapa}',
        to_jsonb(nextval('public.pedidos_numero_mapa_seq'))
      );
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

  -- Mantém a sequence de numero_mapa à frente (ver 0005).
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
