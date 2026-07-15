-- Keyset aditivo para clientes novos. As assinaturas antigas permanecem para
-- hubs que ainda enviam somente o timestamp.
create or replace function public.sync_children_changed(
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
  if p_table = 'pedido_pontos_retirada' then
    return query
      select to_jsonb(c)
      from public.pedido_pontos_retirada c
      join public.pedidos p on p.id = c.pedido_id
      where p.empresa_id = p_empresa
        and (c.updated_at, c.id::text) > (p_cursor, coalesce(p_cursor_pk, ''))
      order by c.updated_at asc, c.id::text asc
      limit v_limit;
  elsif p_table = 'pedido_itens' then
    return query
      select to_jsonb(c)
      from public.pedido_itens c
      join public.pedido_pontos_retirada pr on pr.id = c.ponto_retirada_id
      join public.pedidos p on p.id = pr.pedido_id
      where p.empresa_id = p_empresa
        and (c.updated_at, c.id::text) > (p_cursor, coalesce(p_cursor_pk, ''))
      order by c.updated_at asc, c.id::text asc
      limit v_limit;
  elsif p_table = 'os_itens' then
    return query
      select to_jsonb(c)
      from public.os_itens c
      join public.ordens_servico o on o.id = c.os_id
      where o.empresa_id = p_empresa
        and (c.updated_at, c.id::text) > (p_cursor, coalesce(p_cursor_pk, ''))
      order by c.updated_at asc, c.id::text asc
      limit v_limit;
  elsif p_table = 'os_servicos' then
    return query
      select to_jsonb(c)
      from public.os_servicos c
      join public.ordens_servico o on o.id = c.os_id
      where o.empresa_id = p_empresa
        and (c.updated_at, c.id::text) > (p_cursor, coalesce(p_cursor_pk, ''))
      order by c.updated_at asc, c.id::text asc
      limit v_limit;
  else
    raise exception 'sync_children_changed: tabela nao suportada %', p_table;
  end if;
end;
$$;

revoke all on function public.sync_children_changed(
  text, uuid, timestamptz, text, integer
) from public, anon, authenticated;
grant execute on function public.sync_children_changed(
  text, uuid, timestamptz, text, integer
) to service_role;

create or replace function public.sync_auth_users(
  p_empresa uuid,
  p_cursor timestamptz,
  p_cursor_pk text,
  p_limit integer
)
returns setof jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', u.id, 'email', u.email, 'encrypted_password', u.encrypted_password,
    'email_confirmed_at', u.email_confirmed_at, 'raw_user_meta_data', u.raw_user_meta_data,
    'raw_app_meta_data', u.raw_app_meta_data, 'aud', u.aud, 'role', u.role,
    'created_at', u.created_at, 'updated_at', u.updated_at, 'instance_id', u.instance_id,
    'phone', u.phone, 'confirmed_at', u.confirmed_at, 'last_sign_in_at', u.last_sign_in_at,
    'is_sso_user', u.is_sso_user, 'is_anonymous', u.is_anonymous,
    'banned_until', u.banned_until, 'deleted_at', u.deleted_at
  )
  from auth.users u
  where exists (
    select 1
    from public.profiles p
    where p.id = u.id
      and p.empresa_id = p_empresa
  )
    and (u.updated_at, u.id::text) > (p_cursor, coalesce(p_cursor_pk, ''))
  order by u.updated_at asc, u.id::text asc
  limit greatest(least(coalesce(p_limit, 0), 500), 0)
$$;

revoke all on function public.sync_auth_users(
  uuid, timestamptz, text, integer
) from public, anon, authenticated;
grant execute on function public.sync_auth_users(
  uuid, timestamptz, text, integer
) to service_role;

-- Um UUID existente só é vendedor válido quando pertence ao mesmo tenant da linha.
create or replace function public.null_missing_vendedor_id()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_setting('exped.sync', true) = 'on'
     and new.vendedor_id is not null
     and not exists (
       select 1
       from public.profiles p
       where p.id = new.vendedor_id
         and p.empresa_id = new.empresa_id
     ) then
    new.vendedor_id := null;
  end if;

  return new;
end;
$$;

revoke all on function public.null_missing_vendedor_id()
from public, anon, authenticated;
