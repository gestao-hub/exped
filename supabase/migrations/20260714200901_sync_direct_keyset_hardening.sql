-- Keyset direto em um unico statement/snapshot. Cada branch fixa a tabela e o
-- predicado de tenant; p_table nunca entra em SQL dinamico.
create or replace function public.sync_direct_changed(
  p_table text,
  p_empresa uuid,
  p_cursor timestamptz,
  p_cursor_pk text,
  p_limit integer
)
returns setof jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := greatest(least(coalesce(p_limit, 0), 500), 0);
begin
  if p_table = 'clientes' then
    return query
      select to_jsonb(row_data)
      from public.clientes row_data
      where row_data.empresa_id = p_empresa
        and (row_data.updated_at, row_data.id::text) >
          (p_cursor, coalesce(p_cursor_pk, ''))
      order by row_data.updated_at asc, row_data.id::text asc
      limit v_limit;
  elsif p_table = 'pedidos' then
    return query
      select to_jsonb(row_data)
      from public.pedidos row_data
      where row_data.empresa_id = p_empresa
        and (row_data.updated_at, row_data.id::text) >
          (p_cursor, coalesce(p_cursor_pk, ''))
      order by row_data.updated_at asc, row_data.id::text asc
      limit v_limit;
  elsif p_table = 'ordens_servico' then
    return query
      select to_jsonb(row_data)
      from public.ordens_servico row_data
      where row_data.empresa_id = p_empresa
        and (row_data.updated_at, row_data.id::text) >
          (p_cursor, coalesce(p_cursor_pk, ''))
      order by row_data.updated_at asc, row_data.id::text asc
      limit v_limit;
  elsif p_table = 'os_notificacoes' then
    return query
      select to_jsonb(row_data)
      from public.os_notificacoes row_data
      where row_data.empresa_id = p_empresa
        and (row_data.updated_at, row_data.id::text) >
          (p_cursor, coalesce(p_cursor_pk, ''))
      order by row_data.updated_at asc, row_data.id::text asc
      limit v_limit;
  elsif p_table = 'empresas' then
    return query
      select to_jsonb(row_data)
      from public.empresas row_data
      where row_data.id = p_empresa
        and (row_data.updated_at, row_data.id::text) >
          (p_cursor, coalesce(p_cursor_pk, ''))
      order by row_data.updated_at asc, row_data.id::text asc
      limit v_limit;
  elsif p_table = 'profiles' then
    return query
      select to_jsonb(row_data)
      from public.profiles row_data
      where row_data.empresa_id = p_empresa
        and (row_data.updated_at, row_data.id::text) >
          (p_cursor, coalesce(p_cursor_pk, ''))
      order by row_data.updated_at asc, row_data.id::text asc
      limit v_limit;
  elsif p_table = 'hiper_vendedor_map' then
    return query
      select to_jsonb(row_data)
      from public.hiper_vendedor_map row_data
      where row_data.empresa_id = p_empresa
        and (row_data.updated_at, row_data.hiper_usuario_id::text) >
          (p_cursor, coalesce(p_cursor_pk, ''))
      order by row_data.updated_at asc, row_data.hiper_usuario_id::text asc
      limit v_limit;
  elsif p_table = 'dispositivos' then
    return query
      select to_jsonb(row_data)
      from public.dispositivos row_data
      where row_data.empresa_id = p_empresa
        and (row_data.updated_at, row_data.id::text) >
          (p_cursor, coalesce(p_cursor_pk, ''))
      order by row_data.updated_at asc, row_data.id::text asc
      limit v_limit;
  else
    raise exception 'sync_direct_changed: tabela nao suportada %', p_table;
  end if;
end;
$$;

revoke all on function public.sync_direct_changed(
  text, uuid, timestamptz, text, integer
) from public, anon, authenticated;
grant execute on function public.sync_direct_changed(
  text, uuid, timestamptz, text, integer
) to service_role;

-- Reafirma os grants das assinaturas timestamp-only usadas por hubs antigos.
revoke all on function public.sync_children_changed(
  text, uuid, timestamptz, integer
) from public, anon, authenticated;
grant execute on function public.sync_children_changed(
  text, uuid, timestamptz, integer
) to service_role;

revoke all on function public.sync_auth_users(
  uuid, timestamptz, integer
) from public, anon, authenticated;
grant execute on function public.sync_auth_users(
  uuid, timestamptz, integer
) to service_role;
