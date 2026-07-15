begin;

select plan(13);

select has_function(
  'public',
  'assert_hub_release_access',
  array['text'],
  'RPC de comprovacao da credencial opaca existe'
);

select is(
  (
    select p.prosecdef
    from pg_catalog.pg_proc p
    where p.oid = to_regprocedure('public.assert_hub_release_access(text)')
  ),
  true,
  'RPC usa SECURITY DEFINER'
);

select is(
  (
    select p.proconfig
    from pg_catalog.pg_proc p
    where p.oid = to_regprocedure('public.assert_hub_release_access(text)')
  ),
  array['search_path=""']::text[],
  'RPC fixa search_path vazio'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.assert_hub_release_access(text)',
    'execute'
  ),
  'anon nao comprova credencial de release'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.assert_hub_release_access(text)',
    'execute'
  ),
  'authenticated nao comprova credencial de release'
);

select ok(
  not has_function_privilege(
    'service_role',
    'public.assert_hub_release_access(text)',
    'execute'
  ),
  'service_role nao substitui a credencial dedicada'
);

select ok(
  has_function_privilege(
    'exped_hub_release_stage',
    'public.assert_hub_release_access(text)',
    'execute'
  ),
  'stage pode comprovar sua credencial'
);

select ok(
  has_function_privilege(
    'exped_hub_release_promote',
    'public.assert_hub_release_access(text)',
    'execute'
  ),
  'promocao pode comprovar sua credencial'
);

grant usage on schema extensions
  to exped_hub_release_stage, exped_hub_release_promote;

select set_config(
  'request.jwt.claims',
  '{"role":"exped_hub_release_stage","sub":"00000000-0000-0000-0000-000000000031"}',
  true
);
set local role exped_hub_release_stage;

select is(
  public.assert_hub_release_access('exped_hub_release_stage') ->> 'role',
  'exped_hub_release_stage',
  'stage comprova somente a role esperada'
);

select is(
  public.assert_hub_release_access('exped_hub_release_stage') ->> 'subject',
  '00000000-0000-0000-0000-000000000031',
  'stage preserva o subject auditavel da chave'
);

select throws_ok(
  $$
    select public.assert_hub_release_access('exped_hub_release_promote')
  $$,
  '42501',
  'somente a role exped_hub_release_promote pode executar esta operacao',
  'stage nao se apresenta como promocao'
);

select throws_ok(
  $$
    select public.assert_hub_release_access('service_role')
  $$,
  '22023',
  'role de release invalida',
  'caller nao escolhe uma role privilegiada arbitraria'
);

reset role;
select set_config(
  'request.jwt.claims',
  '{"role":"exped_hub_release_promote","sub":"00000000-0000-0000-0000-000000000032"}',
  true
);
set local role exped_hub_release_promote;

select is(
  public.assert_hub_release_access('exped_hub_release_promote') ->> 'role',
  'exped_hub_release_promote',
  'promocao comprova somente sua role dedicada'
);

select * from finish();
rollback;
