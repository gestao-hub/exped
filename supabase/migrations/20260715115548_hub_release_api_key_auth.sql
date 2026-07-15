-- Opaque Supabase secret keys cannot be decoded locally. Require an explicit,
-- role-scoped database proof before release tooling reaches Storage.
create or replace function public.assert_hub_release_access(
  p_expected_role text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_subject uuid;
begin
  if p_expected_role not in (
    'exped_hub_release_stage',
    'exped_hub_release_promote'
  ) then
    raise exception using
      errcode = '22023',
      message = 'role de release invalida';
  end if;

  v_subject := private.hub_release_subject(p_expected_role);
  return pg_catalog.jsonb_build_object(
    'role', p_expected_role,
    'subject', v_subject
  );
end;
$$;

revoke all on function public.assert_hub_release_access(text) from public;
revoke all on function public.assert_hub_release_access(text)
  from anon, authenticated, service_role,
    exped_hub_release_stage, exped_hub_release_promote;
grant execute on function public.assert_hub_release_access(text)
  to exped_hub_release_stage, exped_hub_release_promote;
