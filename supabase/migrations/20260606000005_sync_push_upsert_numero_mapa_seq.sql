-- 20260606000005_sync_push_upsert_numero_mapa_seq.sql
-- Fix de recorrência: o sync (sync_push_upsert) grava pedidos vindos do hub com
-- numero_mapa EXPLÍCITO (via jsonb_populate_record), sem avançar a sequence
-- pedidos_numero_mapa_seq. Com o tempo a sequence fica ATRÁS do max(numero_mapa)
-- e a criação de QUALQUER pedido novo (nextval) colide com numero já existente
-- (duplicate key pedidos_numero_mapa_key). Aqui a RPC passa a manter a sequence
-- à frente do maior numero_mapa inserido. (Mesma função da 0002 + bloco no fim.)
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
begin
  if p_table not in (
    'clientes','pedidos','pedido_pontos_retirada','pedido_itens',
    'ordens_servico','os_itens','os_servicos','os_notificacoes'
  ) then
    raise exception 'sync_push_upsert: tabela não permitida %', p_table;
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

  -- Mantém a sequence de numero_mapa à FRENTE dos valores gravados via sync, senão
  -- o nextval da próxima criação de pedido colide. Advisory lock (escopo da tx)
  -- serializa o read-greatest-setval contra syncs concorrentes (race-safe).
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
