begin;

select plan(14);

select has_function(
  'public',
  'sync_children_changed',
  array['text', 'uuid', 'timestamp with time zone', 'integer'],
  'RPC legado de filhas permanece disponivel'
);

select has_function(
  'public',
  'sync_auth_users',
  array['uuid', 'timestamp with time zone', 'integer'],
  'RPC legado de auth.users permanece disponivel'
);

select has_function(
  'public',
  'sync_children_changed',
  array['text', 'uuid', 'timestamp with time zone', 'text', 'integer'],
  'RPC keyset de filhas existe'
);

select has_function(
  'public',
  'sync_auth_users',
  array['uuid', 'timestamp with time zone', 'text', 'integer'],
  'RPC keyset de auth.users existe'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.sync_children_changed(text, uuid, timestamp with time zone, text, integer)',
    'execute'
  ),
  'anon nao executa pull keyset de filhas'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.sync_children_changed(text, uuid, timestamp with time zone, text, integer)',
    'execute'
  ),
  'authenticated nao executa pull keyset de filhas'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.sync_children_changed(text, uuid, timestamp with time zone, text, integer)',
    'execute'
  ),
  'service_role executa pull keyset de filhas'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.sync_auth_users(uuid, timestamp with time zone, text, integer)',
    'execute'
  ),
  'anon nao executa pull keyset de auth.users'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.sync_auth_users(uuid, timestamp with time zone, text, integer)',
    'execute'
  ),
  'authenticated nao executa pull keyset de auth.users'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.sync_auth_users(uuid, timestamp with time zone, text, integer)',
    'execute'
  ),
  'service_role executa pull keyset de auth.users'
);

set local exped.sync = 'on';

insert into public.pedidos (id, empresa_id, cliente_nome, data_emissao)
values (
  '10000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-0000000f0001',
  'Pai keyset',
  current_date
);

insert into public.pedido_pontos_retirada (
  id, pedido_id, tipo, empresa_nome, updated_at
)
select
  ('11000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
  '10000000-0000-0000-0000-000000000001'::uuid,
  'loja',
  'Keyset',
  '2026-07-14T12:00:00.123456Z'::timestamptz
from generate_series(1, 530) as series(i);

select is(
  array[
    (
      select count(*)
      from public.sync_children_changed(
        'pedido_pontos_retirada',
        '00000000-0000-0000-0000-0000000f0001',
        '2026-07-14T12:00:00.123456Z',
        '',
        500
      )
    ),
    (
      select count(*)
      from public.sync_children_changed(
        'pedido_pontos_retirada',
        '00000000-0000-0000-0000-0000000f0001',
        '2026-07-14T12:00:00.123456Z',
        '11000000-0000-0000-0000-000000000500',
        500
      )
    )
  ],
  array[500::bigint, 30::bigint],
  'filha pagina 530 empates como 500 + 30'
);

select is(
  (
    select count(*)
    from public.sync_children_changed(
      'pedido_pontos_retirada',
      '00000000-0000-0000-0000-0000000f0001',
      '2026-07-14T12:00:00.123456Z',
      '',
      999
    )
  ),
  500::bigint,
  'RPC keyset de filhas limita resposta a 500'
);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
select
  ('12000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
  '00000000-0000-0000-0000-000000000000'::uuid,
  'authenticated',
  'authenticated',
  'keyset-' || i || '@teste.local',
  '',
  '2026-07-14T11:00:00Z'::timestamptz,
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  '2026-07-14T11:00:00Z'::timestamptz,
  '2026-07-14T12:00:00.123456Z'::timestamptz
from generate_series(1, 530) as series(i);

update public.profiles
set empresa_id = '00000000-0000-0000-0000-0000000f0001'
where id::text like '12000000-0000-0000-0000-%';

select is(
  array[
    (
      select count(*)
      from public.sync_auth_users(
        '00000000-0000-0000-0000-0000000f0001',
        '2026-07-14T12:00:00.123456Z',
        '',
        500
      )
    ),
    (
      select count(*)
      from public.sync_auth_users(
        '00000000-0000-0000-0000-0000000f0001',
        '2026-07-14T12:00:00.123456Z',
        '12000000-0000-0000-0000-000000000500',
        500
      )
    )
  ],
  array[500::bigint, 30::bigint],
  'auth.users pagina 530 empates como 500 + 30'
);

select is(
  (
    select count(*)
    from public.sync_auth_users(
      '00000000-0000-0000-0000-0000000f0001',
      '2026-07-14T12:00:00.123456Z',
      '',
      999
    )
  ),
  500::bigint,
  'RPC keyset de auth.users limita resposta a 500'
);

select * from finish();
rollback;
