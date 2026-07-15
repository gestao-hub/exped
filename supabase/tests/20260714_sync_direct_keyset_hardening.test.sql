begin;

select plan(20);

select has_function(
  'public',
  'sync_direct_changed',
  array['text', 'uuid', 'timestamp with time zone', 'text', 'integer'],
  'RPC keyset de tabelas diretas existe'
);

select is(
  (
    select p.prosecdef
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.oid = to_regprocedure(
        'public.sync_direct_changed(text,uuid,timestamp with time zone,text,integer)'
      )
  ),
  true,
  'RPC direta usa SECURITY DEFINER'
);

select is(
  (
    select p.proconfig
    from pg_catalog.pg_proc p
    where p.oid = to_regprocedure(
      'public.sync_direct_changed(text,uuid,timestamp with time zone,text,integer)'
    )
  ),
  array['search_path=""']::text[],
  'RPC direta fixa search_path vazio'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.sync_direct_changed(text, uuid, timestamp with time zone, text, integer)',
    'execute'
  ),
  'anon nao executa keyset direto'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.sync_direct_changed(text, uuid, timestamp with time zone, text, integer)',
    'execute'
  ),
  'authenticated nao executa keyset direto'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.sync_direct_changed(text, uuid, timestamp with time zone, text, integer)',
    'execute'
  ),
  'service_role executa keyset direto'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.sync_children_changed(text, uuid, timestamp with time zone, integer)',
    'execute'
  ),
  'anon continua sem executar assinatura legada de filhas'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.sync_children_changed(text, uuid, timestamp with time zone, integer)',
    'execute'
  ),
  'authenticated continua sem executar assinatura legada de filhas'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.sync_children_changed(text, uuid, timestamp with time zone, integer)',
    'execute'
  ),
  'service_role executa assinatura legada de filhas'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.sync_auth_users(uuid, timestamp with time zone, integer)',
    'execute'
  ),
  'anon continua sem executar assinatura legada de auth.users'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.sync_auth_users(uuid, timestamp with time zone, integer)',
    'execute'
  ),
  'authenticated continua sem executar assinatura legada de auth.users'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.sync_auth_users(uuid, timestamp with time zone, integer)',
    'execute'
  ),
  'service_role executa assinatura legada de auth.users'
);

set local role service_role;

select lives_ok(
  $$
    select count(*)
    from public.sync_children_changed(
      'pedido_pontos_retirada',
      '00000000-0000-0000-0000-0000000f0001',
      '0001-01-01T00:00:00Z',
      1
    )
  $$,
  'service_role invoca assinatura legada de filhas'
);

select lives_ok(
  $$
    select count(*)
    from public.sync_auth_users(
      '00000000-0000-0000-0000-0000000f0001',
      '0001-01-01T00:00:00Z',
      1
    )
  $$,
  'service_role invoca assinatura legada de auth.users'
);

select lives_ok(
  $$
    select count(*)
    from public.sync_direct_changed(
      'clientes',
      '00000000-0000-0000-0000-0000000f0001',
      '0001-01-01T00:00:00Z',
      '',
      1
    )
  $$,
  'service_role invoca RPC keyset direta'
);

select lives_ok(
  $$
    select count(*)
    from unnest(array[
      'clientes',
      'pedidos',
      'ordens_servico',
      'os_notificacoes',
      'empresas',
      'profiles',
      'hiper_vendedor_map',
      'dispositivos'
    ]) as allowed(table_name)
    cross join lateral public.sync_direct_changed(
      allowed.table_name,
      '00000000-0000-0000-0000-0000000f0001',
      '0001-01-01T00:00:00Z',
      '',
      0
    )
  $$,
  'todas as branches allowlisted da RPC direta sao invocaveis'
);

reset role;
set local exped.sync = 'on';

insert into public.empresas (id, nome, slug, cor_primaria)
values (
  '00000000-0000-0000-0000-0000000f0002',
  'Tenant vizinho keyset',
  'tenant-vizinho-keyset',
  '#123456'
);

insert into public.clientes (id, empresa_id, nome, updated_at)
select
  ('13000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
  '00000000-0000-0000-0000-0000000f0001'::uuid,
  'Cliente direto ' || i,
  '2026-07-14T12:00:00.123456Z'::timestamptz
from generate_series(1, 530) as series(i);

insert into public.clientes (id, empresa_id, nome, updated_at)
select
  ('14000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
  '00000000-0000-0000-0000-0000000f0002'::uuid,
  'Cliente de outro tenant ' || i,
  '2026-07-14T12:00:00.123456Z'::timestamptz
from generate_series(1, 7) as series(i);

select is(
  array[
    (
      select count(*)
      from public.sync_direct_changed(
        'clientes',
        '00000000-0000-0000-0000-0000000f0001',
        '2026-07-14T12:00:00.123456Z',
        '',
        500
      )
    ),
    (
      select count(*)
      from public.sync_direct_changed(
        'clientes',
        '00000000-0000-0000-0000-0000000f0001',
        '2026-07-14T12:00:00.123456Z',
        '13000000-0000-0000-0000-000000000500',
        500
      )
    )
  ],
  array[500::bigint, 30::bigint],
  'keyset direto pagina 530 empates como 500 + 30'
);

select is(
  (
    select count(*)
    from public.sync_direct_changed(
      'clientes',
      '00000000-0000-0000-0000-0000000f0001',
      '2026-07-14T12:00:00.123456Z',
      '',
      999
    )
  ),
  500::bigint,
  'RPC keyset direta limita resposta a 500'
);

select is(
  (
    select count(*)
    from public.sync_direct_changed(
      'clientes',
      '00000000-0000-0000-0000-0000000f0001',
      '2026-07-14T12:00:00.123456Z',
      '',
      500
    ) as rows(row_json)
    where (row_json ->> 'empresa_id')::uuid =
      '00000000-0000-0000-0000-0000000f0002'::uuid
  ),
  0::bigint,
  'RPC keyset direta nao cruza tenant'
);

select throws_ok(
  $$
    select *
    from public.sync_direct_changed(
      'auth.users',
      '00000000-0000-0000-0000-0000000f0001',
      '0001-01-01T00:00:00Z',
      '',
      1
    )
  $$,
  'P0001',
  'sync_direct_changed: tabela nao suportada auth.users',
  'RPC keyset direta rejeita tabela fora da allowlist'
);

select * from finish();
rollback;
