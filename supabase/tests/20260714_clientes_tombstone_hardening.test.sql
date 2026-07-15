begin;

select plan(23);

select has_function(
  'public',
  'merge_clientes',
  array['uuid', 'uuid'],
  'RPC de merge de clientes existe'
);

select is(
  (
    select procedure.prosecdef
    from pg_catalog.pg_proc procedure
    where procedure.oid = to_regprocedure('public.merge_clientes(uuid,uuid)')
  ),
  false,
  'RPC de merge usa SECURITY INVOKER'
);

select is(
  (
    select procedure.proconfig
    from pg_catalog.pg_proc procedure
    where procedure.oid = to_regprocedure('public.merge_clientes(uuid,uuid)')
  ),
  array['search_path=""']::text[],
  'RPC de merge fixa search_path vazio'
);

select ok(
  not coalesce(
    has_function_privilege(
      'anon',
      to_regprocedure('public.merge_clientes(uuid,uuid)'),
      'execute'
    ),
    false
  ),
  'anon nao executa merge de clientes'
);

select ok(
  coalesce(
    has_function_privilege(
      'authenticated',
      to_regprocedure('public.merge_clientes(uuid,uuid)'),
      'execute'
    ),
    false
  ),
  'authenticated executa merge de clientes'
);

select ok(
  not coalesce(
    has_function_privilege(
      'service_role',
      to_regprocedure('public.merge_clientes(uuid,uuid)'),
      'execute'
    ),
    false
  ),
  'service_role nao recebe privilegio desnecessario no merge administrativo'
);

select ok(
  position(
    'deleted_at IS NULL' in coalesce(
      (
        select index_info.indexdef
        from pg_catalog.pg_indexes index_info
        where index_info.schemaname = 'public'
          and index_info.indexname = 'clientes_cnpj_cpf_uniq'
      ),
      ''
    )
  ) > 0,
  'unicidade de CNPJ considera somente clientes ativos'
);

select ok(
  position(
    'regexp_replace' in lower(coalesce(
      (
        select index_info.indexdef
        from pg_catalog.pg_indexes index_info
        where index_info.schemaname = 'public'
          and index_info.indexname = 'clientes_cnpj_cpf_uniq'
      ),
      ''
    ))
  ) > 0,
  'unicidade de CNPJ compara somente os digitos do documento'
);

select is(
  (
    select count(*)::integer
    from pg_catalog.pg_policies policy
    where policy.schemaname = 'public'
      and policy.tablename = 'clientes'
      and policy.policyname = 'clientes_admin_delete'
  ),
  0,
  'RLS nao permite DELETE fisico de cliente autenticado'
);

insert into public.empresas (id, nome, slug)
values
  ('a1000000-0000-4000-8000-000000000001', 'Tombstone A', 'tombstone-a-20260714'),
  ('a1000000-0000-4000-8000-000000000002', 'Tombstone B', 'tombstone-b-20260714');

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
select
  id,
  '00000000-0000-0000-0000-000000000000'::uuid,
  'authenticated',
  'authenticated',
  email,
  '',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
from (values
  ('a1000000-0000-4000-8000-000000000011'::uuid, 'admin-a-tombstone@teste.local'),
  ('a1000000-0000-4000-8000-000000000012'::uuid, 'vendedor-a-tombstone@teste.local')
) as users(id, email);

update public.profiles
set empresa_id = 'a1000000-0000-4000-8000-000000000001',
    role = case id
      when 'a1000000-0000-4000-8000-000000000011'
        then 'admin'::public.user_role
      else 'vendedor'::public.user_role
    end
where id in (
  'a1000000-0000-4000-8000-000000000011',
  'a1000000-0000-4000-8000-000000000012'
);

insert into public.clientes (id, empresa_id, nome, cnpj_cpf, deleted_at)
values
  (
    'a1000000-0000-4000-8000-000000000101',
    'a1000000-0000-4000-8000-000000000001',
    'Origem A',
    '11.111.111/0001-11',
    null
  ),
  (
    'a1000000-0000-4000-8000-000000000102',
    'a1000000-0000-4000-8000-000000000001',
    'Destino A',
    '22.222.222/0001-22',
    null
  ),
  (
    'a1000000-0000-4000-8000-000000000103',
    'a1000000-0000-4000-8000-000000000002',
    'Destino B',
    '33.333.333/0001-33',
    null
  ),
  (
    'a1000000-0000-4000-8000-000000000104',
    'a1000000-0000-4000-8000-000000000001',
    'Probe de delete',
    '44.444.444/0001-44',
    null
  ),
  (
    'a1000000-0000-4000-8000-000000000105',
    'a1000000-0000-4000-8000-000000000001',
    'Tombstone sync atomico',
    '55.555.555/0001-55',
    '2026-07-14T20:00:00Z'
  ),
  (
    'a1000000-0000-4000-8000-000000000106',
    'a1000000-0000-4000-8000-000000000001',
    'Tombstone sync legado',
    '66.666.666/0001-66',
    '2026-07-14T20:00:00Z'
  );

insert into public.pedidos (id, empresa_id, cliente_nome, cliente_id, deleted_at)
values
  (
    'a1000000-0000-4000-8000-000000000201',
    'a1000000-0000-4000-8000-000000000001',
    'Pedido ativo da origem',
    'a1000000-0000-4000-8000-000000000101',
    null
  ),
  (
    'a1000000-0000-4000-8000-000000000202',
    'a1000000-0000-4000-8000-000000000001',
    'Pedido tombstonado da origem',
    'a1000000-0000-4000-8000-000000000101',
    '2026-07-14T20:00:00Z'
  ),
  (
    'a1000000-0000-4000-8000-000000000203',
    'a1000000-0000-4000-8000-000000000001',
    'Pedido do probe de delete',
    'a1000000-0000-4000-8000-000000000104',
    null
  );

select throws_ok(
  $$
    insert into public.clientes (id, empresa_id, nome, cnpj_cpf)
    values (
      'a1000000-0000-4000-8000-000000000110',
      'a1000000-0000-4000-8000-000000000001',
      'Mesmo documento sem mascara',
      '22222222000122'
    )
  $$,
  '23505',
  'duplicate key value violates unique constraint "clientes_cnpj_cpf_uniq"',
  'cliente ativo nao duplica o mesmo documento com outra formatacao'
);

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"a1000000-0000-4000-8000-000000000012","role":"authenticated"}';

select throws_ok(
  $$
    select public.merge_clientes(
      'a1000000-0000-4000-8000-000000000101',
      'a1000000-0000-4000-8000-000000000102'
    )
  $$,
  '42501',
  'Apenas administradores podem mesclar clientes',
  'usuario nao admin nao executa merge'
);

set local request.jwt.claims =
  '{"sub":"a1000000-0000-4000-8000-000000000011","role":"authenticated"}';

select throws_ok(
  $$
    select public.merge_clientes(
      'a1000000-0000-4000-8000-000000000101',
      'a1000000-0000-4000-8000-000000000103'
    )
  $$,
  '42501',
  'Clientes ativos nao encontrados na empresa atual',
  'admin nao mescla clientes entre tenants'
);

select lives_ok(
  $$
    select public.merge_clientes(
      'a1000000-0000-4000-8000-000000000101',
      'a1000000-0000-4000-8000-000000000102'
    )
  $$,
  'admin mescla clientes ativos do proprio tenant'
);

select is(
  (
    select pedido.cliente_id
    from public.pedidos pedido
    where pedido.id = 'a1000000-0000-4000-8000-000000000201'
  ),
  'a1000000-0000-4000-8000-000000000102'::uuid,
  'merge move pedido ativo para o destino'
);

select is(
  (
    select pedido.cliente_id
    from public.pedidos pedido
    where pedido.id = 'a1000000-0000-4000-8000-000000000202'
  ),
  'a1000000-0000-4000-8000-000000000101'::uuid,
  'merge preserva vinculo do pedido tombstonado'
);

select is(
  (
    select count(*)::integer
    from public.clientes cliente
    where cliente.id = 'a1000000-0000-4000-8000-000000000101'
  ),
  1,
  'merge preserva a linha historica da origem'
);

select ok(
  (
    select cliente.deleted_at is not null
    from public.clientes cliente
    where cliente.id = 'a1000000-0000-4000-8000-000000000101'
  ),
  'merge faz soft delete da origem'
);

select ok(
  (
    select cliente.deleted_at is null
    from public.clientes cliente
    where cliente.id = 'a1000000-0000-4000-8000-000000000102'
  ),
  'merge mantem o destino ativo'
);

select throws_ok(
  $$
    delete from public.clientes
    where id = 'a1000000-0000-4000-8000-000000000104'
    returning id
  $$,
  '42501',
  'permission denied for table clientes',
  'grant bloqueia hard delete administrativo antes da RLS'
);

reset role;

select is(
  (
    select pedido.cliente_id
    from public.pedidos pedido
    where pedido.id = 'a1000000-0000-4000-8000-000000000203'
  ),
  'a1000000-0000-4000-8000-000000000104'::uuid,
  'hard delete bloqueado nao aciona ON DELETE SET NULL'
);

select lives_ok(
  $$
    insert into public.clientes (id, empresa_id, nome, cnpj_cpf)
    values (
      'a1000000-0000-4000-8000-000000000109',
      'a1000000-0000-4000-8000-000000000001',
      'Novo cadastro apos tombstone',
      '11.111.111/0001-11'
    )
  $$,
  'CNPJ de cliente tombstonado pode ser reutilizado'
);

select is(
  public.sync_merge_upsert(
    'clientes',
    'a1000000-0000-4000-8000-000000000001',
    '{
      "id":"a1000000-0000-4000-8000-000000000107",
      "empresa_id":"a1000000-0000-4000-8000-000000000001",
      "nome":"Novo sync atomico",
      "cnpj_cpf":"55.555.555/0001-55",
      "created_at":"2026-07-14T21:00:00Z",
      "updated_at":"2026-07-14T21:00:00Z",
      "field_updated_at":{"nome":"2026-07-14T21:00:00Z"},
      "deleted_at":null
    }'::jsonb
  ) ->> 'id',
  'a1000000-0000-4000-8000-000000000107',
  'sync atomico nao reconcilia com cliente tombstonado'
);

select is(
  public.sync_push_upsert(
    'clientes',
    '{
      "id":"a1000000-0000-4000-8000-000000000108",
      "empresa_id":"a1000000-0000-4000-8000-000000000001",
      "nome":"Novo sync legado",
      "cnpj_cpf":"66.666.666/0001-66",
      "created_at":"2026-07-14T21:00:00Z",
      "updated_at":"2026-07-14T21:00:00Z",
      "field_updated_at":{"nome":"2026-07-14T21:00:00Z"},
      "deleted_at":null
    }'::jsonb
  ) ->> 'id',
  'a1000000-0000-4000-8000-000000000108',
  'sync legado nao reconcilia com cliente tombstonado'
);

select * from finish();
rollback;
