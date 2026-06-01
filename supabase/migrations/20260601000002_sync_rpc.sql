-- 20260601000002_sync_rpc.sql — RPCs de apoio à API de sync (push escopado por empresa).
--
-- POR QUE RPC e não `set session_replication_role` direto via REST:
--   O supabase-js fala com PostgREST sobre um POOL de conexões. Um `set
--   session_replication_role = replica` emitido numa request NÃO persiste de forma
--   confiável pra próxima request (conexão diferente). Pra desabilitar o trigger
--   `trg_stamp_sync` EXATAMENTE em volta da gravação do resultado do merge, o toggle
--   precisa estar na MESMA transação do upsert — daí encapsular tudo num RPC com
--   `SET LOCAL session_replication_role = replica` (escopo da transação, auto-revert
--   no commit/rollback). É o "session_replication_role" do plano, feito de forma segura.
--
-- Idempotente (create or replace). SECURITY DEFINER (service_role já ignora RLS, mas
-- precisamos do privilégio de setar session_replication_role — só superuser/replication;
-- no Supabase o owner das functions tem o bastante via SET LOCAL em definer).

-- Upsert "cru": grava a linha jsonb tal-e-qual (inclusive field_updated_at/updated_at
-- mergeados), com o trigger de stamp DESLIGADO. Retorna a linha canônica resultante.
create or replace function public.sync_push_upsert(p_table text, p_row jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cols text;
  v_vals text;
  v_set  text;
  v_pk   text := 'id';
  v_result jsonb;
begin
  if p_table not in (
    'clientes','pedidos','pedido_pontos_retirada','pedido_itens',
    'ordens_servico','os_itens','os_servicos','os_notificacoes'
  ) then
    raise exception 'sync_push_upsert: tabela não permitida %', p_table;
  end if;

  -- Desliga triggers (inclui trg_stamp_sync) só nesta transação.
  set local session_replication_role = replica;

  select string_agg(quote_ident(key), ', '),
         string_agg(format('($1->>%L)', key) || '::text', ', ')
    into v_cols, v_vals
  from jsonb_object_keys(p_row) as key;

  select string_agg(format('%I = excluded.%I', key, key), ', ')
    into v_set
  from jsonb_object_keys(p_row) as key
  where key <> v_pk;

  -- Insere/atualiza usando jsonb_populate_record pra casting correto por coluna.
  execute format(
    'insert into public.%I select * from jsonb_populate_record(null::public.%I, $1) ' ||
    'on conflict (%I) do update set %s returning to_jsonb(public.%I.*)',
    p_table, p_table, v_pk, v_set, p_table
  )
  using p_row
  into v_result;

  return v_result;
end $$;

-- Verifica se um id de pai pertence à empresa (escopo de filhas no push).
-- pedido_pontos_retirada/os_* escopam pelo ancestral com empresa_id.
create or replace function public.sync_parent_in_empresa(p_table text, p_id uuid, p_empresa uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_ok boolean;
begin
  if p_table = 'pedidos' then
    select exists(select 1 from public.pedidos where id = p_id and empresa_id = p_empresa) into v_ok;
  elsif p_table = 'ordens_servico' then
    select exists(select 1 from public.ordens_servico where id = p_id and empresa_id = p_empresa) into v_ok;
  elsif p_table = 'pedido_pontos_retirada' then
    -- ancestral: ponto -> pedido.empresa_id
    select exists(
      select 1 from public.pedido_pontos_retirada pp
      join public.pedidos p on p.id = pp.pedido_id
      where pp.id = p_id and p.empresa_id = p_empresa
    ) into v_ok;
  else
    v_ok := false;
  end if;
  return coalesce(v_ok, false);
end $$;

revoke all on function public.sync_push_upsert(text, jsonb) from public, anon, authenticated;
revoke all on function public.sync_parent_in_empresa(text, uuid, uuid) from public, anon, authenticated;
