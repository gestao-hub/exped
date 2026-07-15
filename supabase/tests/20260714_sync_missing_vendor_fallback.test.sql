begin;

select plan(16);

select has_function(
  'public', 'null_missing_vendedor_id', array[]::text[],
  'funcao de fallback existe'
);

select trigger_is(
  'public', 'pedidos', 'pedidos_null_missing_vendedor',
  'public', 'null_missing_vendedor_id',
  'trigger instalado em pedidos'
);

select trigger_is(
  'public', 'ordens_servico', 'ordens_servico_null_missing_vendedor',
  'public', 'null_missing_vendedor_id',
  'trigger instalado em OS'
);

select is(
  (
    select p.prosecdef
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'null_missing_vendedor_id'
      and p.pronargs = 0
  ),
  true,
  'funcao usa SECURITY DEFINER'
);

select is(
  (
    select p.proconfig
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'null_missing_vendedor_id'
      and p.pronargs = 0
  ),
  array['search_path=""']::text[],
  'funcao fixa search_path vazio'
);

select is(
  (
    select count(*)::integer
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    cross join lateral aclexplode(
      coalesce(p.proacl, acldefault('f', p.proowner))
    ) acl
    where n.nspname = 'public'
      and p.proname = 'null_missing_vendedor_id'
      and p.pronargs = 0
      and acl.privilege_type = 'EXECUTE'
      and acl.grantee in (
        0,
        (select oid from pg_catalog.pg_roles where rolname = 'anon'),
        (select oid from pg_catalog.pg_roles where rolname = 'authenticated')
      )
  ),
  0,
  'PUBLIC, anon e authenticated nao executam a funcao'
);

select throws_ok(
  $$
    insert into public.pedidos
      (id, empresa_id, cliente_nome, data_emissao, vendedor_id)
    values
      ('00000000-0000-0000-0000-000000004081',
       '00000000-0000-0000-0000-0000000f0001',
       'Teste pedido sem flag', current_date,
       '00000000-0000-0000-0000-00000000dead')
  $$,
  '23503',
  'insert or update on table "pedidos" violates foreign key constraint "pedidos_vendedor_id_fkey"',
  'pedido sem flag mantem erro de FK no insert'
);

select throws_ok(
  $$
    insert into public.ordens_servico
      (id, empresa_id, cliente_nome, vendedor_id)
    values
      ('00000000-0000-0000-0000-000000004082',
       '00000000-0000-0000-0000-0000000f0001',
       'Teste OS sem flag',
       '00000000-0000-0000-0000-00000000dead')
  $$,
  '23503',
  'insert or update on table "ordens_servico" violates foreign key constraint "ordens_servico_vendedor_id_fkey"',
  'OS sem flag mantem erro de FK no insert'
);

insert into public.pedidos
  (id, empresa_id, cliente_nome, data_emissao, vendedor_id)
values
  ('00000000-0000-0000-0000-000000004084',
   '00000000-0000-0000-0000-0000000f0001',
   'Teste update pedido sem flag', current_date,
   null);

select throws_ok(
  $$
    update public.pedidos
    set vendedor_id = '00000000-0000-0000-0000-00000000dead'
    where id = '00000000-0000-0000-0000-000000004084'
  $$,
  '23503',
  'insert or update on table "pedidos" violates foreign key constraint "pedidos_vendedor_id_fkey"',
  'pedido sem flag mantem erro de FK no update'
);

insert into public.ordens_servico
  (id, empresa_id, cliente_nome, vendedor_id)
values
  ('00000000-0000-0000-0000-000000004085',
   '00000000-0000-0000-0000-0000000f0001',
   'Teste update OS sem flag',
   null);

select throws_ok(
  $$
    update public.ordens_servico
    set vendedor_id = '00000000-0000-0000-0000-00000000dead'
    where id = '00000000-0000-0000-0000-000000004085'
  $$,
  '23503',
  'insert or update on table "ordens_servico" violates foreign key constraint "ordens_servico_vendedor_id_fkey"',
  'OS sem flag mantem erro de FK no update'
);

set local exped.sync = 'on';

insert into public.pedidos
  (id, empresa_id, cliente_nome, data_emissao, vendedor_id)
values
  ('00000000-0000-0000-0000-000000004079',
   '00000000-0000-0000-0000-0000000f0001',
   'Teste mapa 4079', current_date,
   '00000000-0000-0000-0000-00000000dead');

select is(
  (select vendedor_id from public.pedidos where id = '00000000-0000-0000-0000-000000004079'),
  null::uuid,
  'sync de pedido converte vendedor inexistente em null'
);

insert into public.ordens_servico
  (id, empresa_id, cliente_nome, vendedor_id)
values
  ('00000000-0000-0000-0000-000000004080',
   '00000000-0000-0000-0000-0000000f0001',
   'Teste OS 4080',
   '00000000-0000-0000-0000-00000000dead');

select is(
  (select vendedor_id from public.ordens_servico where id = '00000000-0000-0000-0000-000000004080'),
  null::uuid,
  'sync de OS converte vendedor inexistente em null'
);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000004078',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'vendedor-4078@teste.local', '', now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
);

update public.profiles
set empresa_id = '00000000-0000-0000-0000-0000000f0001'
where id = '00000000-0000-0000-0000-000000004078';

insert into public.pedidos
  (id, empresa_id, cliente_nome, data_emissao, vendedor_id)
values
  ('00000000-0000-0000-0000-000000004078',
   '00000000-0000-0000-0000-0000000f0001',
   'Teste vendedor valido', current_date,
   '00000000-0000-0000-0000-000000004078');

select is(
  (select vendedor_id from public.pedidos where id = '00000000-0000-0000-0000-000000004078'),
  '00000000-0000-0000-0000-000000004078'::uuid,
  'sync de pedido preserva vendedor canonico existente'
);

insert into public.ordens_servico
  (id, empresa_id, cliente_nome, vendedor_id)
values
  ('00000000-0000-0000-0000-000000004083',
   '00000000-0000-0000-0000-0000000f0001',
   'Teste OS vendedor valido',
   '00000000-0000-0000-0000-000000004078');

select is(
  (select vendedor_id from public.ordens_servico where id = '00000000-0000-0000-0000-000000004083'),
  '00000000-0000-0000-0000-000000004078'::uuid,
  'sync de OS preserva vendedor canonico existente'
);

insert into public.empresas (id, nome, slug)
values (
  '00000000-0000-0000-0000-0000000f0002',
  'Outro tenant',
  'outro-tenant-fallback'
);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000004077',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'vendedor-outro-tenant@teste.local', '', now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
);

update public.profiles
set empresa_id = '00000000-0000-0000-0000-0000000f0002'
where id = '00000000-0000-0000-0000-000000004077';

insert into public.pedidos
  (id, empresa_id, cliente_nome, data_emissao, vendedor_id)
values
  ('00000000-0000-0000-0000-000000004076',
   '00000000-0000-0000-0000-0000000f0001',
   'Teste vendedor de outro tenant', current_date,
   '00000000-0000-0000-0000-000000004077');

select is(
  (select vendedor_id from public.pedidos where id = '00000000-0000-0000-0000-000000004076'),
  null::uuid,
  'sync de pedido nulifica vendedor existente de outro tenant'
);

insert into public.ordens_servico
  (id, empresa_id, cliente_nome, vendedor_id)
values
  ('00000000-0000-0000-0000-000000004075',
   '00000000-0000-0000-0000-0000000f0001',
   'Teste OS vendedor de outro tenant',
   '00000000-0000-0000-0000-000000004077');

select is(
  (select vendedor_id from public.ordens_servico where id = '00000000-0000-0000-0000-000000004075'),
  null::uuid,
  'sync de OS nulifica vendedor existente de outro tenant'
);

select * from finish();
rollback;
