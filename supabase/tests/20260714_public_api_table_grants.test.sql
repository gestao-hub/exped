begin;

select plan(8);

create temporary table expected_public_api_tables (name text primary key) on commit drop;
insert into expected_public_api_tables (name) values
  ('cliente_enderecos'),
  ('clientes'),
  ('dispositivos'),
  ('empresas'),
  ('hiper_vendedor_map'),
  ('ordens_servico'),
  ('os_itens'),
  ('os_notificacoes'),
  ('os_servicos'),
  ('pedido_comentarios'),
  ('pedido_eventos'),
  ('pedido_itens'),
  ('pedido_logistica'),
  ('pedido_pontos_retirada'),
  ('pedidos'),
  ('profiles'),
  ('provisioning_codes');

select ok(
  not exists (
    select 1 from expected_public_api_tables expected
    where not has_table_privilege(
      'authenticated',
      pg_catalog.format('public.%I', expected.name),
      'select'
    )
  ),
  'authenticated pode ler todas as tabelas da Data API'
);

select ok(
  not exists (
    select 1 from expected_public_api_tables expected
    where not has_table_privilege(
      'authenticated',
      pg_catalog.format('public.%I', expected.name),
      'insert'
    )
  ),
  'authenticated pode inserir sujeito a RLS'
);

select ok(
  not exists (
    select 1 from expected_public_api_tables expected
    where not has_table_privilege(
      'authenticated',
      pg_catalog.format('public.%I', expected.name),
      'update'
    )
  ),
  'authenticated pode atualizar sujeito a RLS'
);

create temporary table expected_authenticated_delete_tables (name text primary key) on commit drop;
insert into expected_authenticated_delete_tables (name) values
  ('cliente_enderecos'),
  ('pedido_comentarios');

select ok(
  not exists (
    select 1 from expected_authenticated_delete_tables expected
    where not has_table_privilege(
      'authenticated',
      pg_catalog.format('public.%I', expected.name),
      'delete'
    )
  ),
  'authenticated conserva delete somente em fluxos sem tombstone'
);

select ok(
  not exists (
    select 1
    from expected_public_api_tables exposed
    where not exists (
      select 1 from expected_authenticated_delete_tables allowed
      where allowed.name = exposed.name
    )
      and has_table_privilege(
        'authenticated',
        pg_catalog.format('public.%I', exposed.name),
        'delete'
      )
  ),
  'authenticated nao recebe delete nas tabelas historicas sem fluxo de remocao'
);

select ok(
  not exists (
    select 1
    from pg_catalog.pg_policy policy
    where policy.polrelid in (
      'public.pedido_itens'::regclass,
      'public.pedido_pontos_retirada'::regclass
    )
      and policy.polcmd = 'd'
  )
  and not exists (
    select 1
    from pg_catalog.pg_policy policy
    where policy.polrelid in (
      'public.pedido_itens'::regclass,
      'public.pedido_pontos_retirada'::regclass
    )
      and policy.polcmd in ('a', 'i', 'w')
      and (
        coalesce(pg_catalog.pg_get_expr(policy.polqual, policy.polrelid), '') like '%financeiro%'
        or coalesce(pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid), '') like '%financeiro%'
      )
  ),
  'itens e pontos nao permitem hard delete e financeiro fica fora das escritas'
);

select ok(
  not exists (
    select 1 from expected_public_api_tables expected
    where not has_table_privilege(
      'service_role',
      pg_catalog.format('public.%I', expected.name),
      'select,insert,update,delete'
    )
  ),
  'service_role possui os grants necessarios para rotas internas'
);

select ok(
  not exists (
    select 1
    from expected_public_api_tables expected
    join pg_catalog.pg_class relation on relation.relname = expected.name
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relkind = 'r'
      and not relation.relrowsecurity
  ),
  'todas as tabelas expostas continuam protegidas por RLS'
);

select * from finish();
rollback;
