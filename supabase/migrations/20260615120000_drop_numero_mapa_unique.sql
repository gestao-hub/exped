-- 20260615120000_drop_numero_mapa_unique.sql
-- numero_mapa é o "Nº" de EXIBIÇÃO do pedido — NÃO é usado como chave de busca em
-- lugar nenhum (confirmado: só SELECT/ordenação na UI). A UNIQUE global, somada às
-- DUAS sequências independentes (hub e nuvem), causava colisão que TRAVAVA o sync nos
-- dois sentidos:
--   - PUSH: a anti-colisão renumerava o pedido na nuvem (nextval) → divergência hub×nuvem.
--   - PULL: o INSERT no hub batia na UNIQUE (mesmo Nº, id diferente) → o lote abortava e
--           os filhos (pontos/itens) caíam em FK (pai não inserido). Sync parado.
-- Solução (idempotente): remover a UNIQUE (Nº duplicado é cosmético e raro) e tirar a
-- renumeração/setval anti-colisão da RPC. O sync passa a só fazer upsert por id.

alter table public.pedidos drop constraint if exists pedidos_numero_mapa_key;

-- RPC sem o bloco de anti-colisão de numero_mapa (mantém a reconciliação de cliente
-- por CNPJ e o upsert escopado por empresa, exatamente como antes).
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

  -- Reconciliação de CLIENTE por CNPJ: mesmo CNPJ com id diferente (import na nuvem vs
  -- criado no hub) → devolve o existente (não duplica).
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

  -- (numero_mapa: SEM anti-colisão/setval — a UNIQUE foi removida; Nº é só exibição.)

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

  return v_result;
end $$;

revoke all on function public.sync_push_upsert(text, jsonb) from public, anon, authenticated;
