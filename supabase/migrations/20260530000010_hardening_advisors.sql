-- 20260530000010_hardening_advisors.sql — endurece os avisos do Supabase advisor.

-- 1) search_path fixo (function_search_path_mutable)
alter function public.set_updated_at() set search_path = public;

-- 2) Funções SÓ de trigger: ninguém chama direto (o trigger roda como definer).
--    Revoga EXECUTE de todos os papéis (anon, authenticated e public).
revoke execute on function public.handle_new_user()          from anon, authenticated, public;
revoke execute on function public.set_updated_at()           from anon, authenticated, public;
revoke execute on function public.prevent_self_role_change() from anon, authenticated, public;

-- 3) Funções helper usadas pela RLS: tira de anon/public, MAS mantém authenticated
--    (as policies chamam essas funções como o usuário logado — authenticated PRECISA executar).
revoke execute on function public.current_empresa_id() from anon, public;
grant  execute on function public.current_empresa_id() to authenticated;
revoke execute on function public.is_platform_admin()  from anon, public;
grant  execute on function public.is_platform_admin()  to authenticated;
revoke execute on function public.current_user_role()  from anon, public;
grant  execute on function public.current_user_role()  to authenticated;
