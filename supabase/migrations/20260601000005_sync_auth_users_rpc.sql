-- 20260601000005_sync_auth_users_rpc.sql — leitura segura de auth.users p/ o sync de login
-- O PostgREST da nuvem NÃO expõe o schema `auth` (e expô-lo vazaria os hashes de senha). Em vez
-- disso, uma função SECURITY DEFINER no schema public lê auth.users por dentro, escopada na empresa,
-- e devolve só as colunas que o GoTrue local precisa (incl. encrypted_password p/ login offline).
-- Exposta via PostgREST como RPC (a FUNÇÃO, não a tabela auth). Só service_role executa.
create or replace function public.sync_auth_users(p_empresa uuid, p_cursor timestamptz, p_limit int)
returns setof jsonb
language sql
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
    'banned_until', u.banned_until, 'deleted_at', u.deleted_at)
  from auth.users u
  where u.id in (select p.id from public.profiles p where p.empresa_id = p_empresa)
    and u.updated_at > p_cursor
  order by u.updated_at asc
  limit p_limit
$$;

revoke all on function public.sync_auth_users(uuid, timestamptz, int) from public, anon, authenticated;
grant execute on function public.sync_auth_users(uuid, timestamptz, int) to service_role;
