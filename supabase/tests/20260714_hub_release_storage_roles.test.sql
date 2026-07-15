begin;

select plan(21);

select has_role(
  'exped_hub_release_stage',
  'role dedicada de stage existe'
);

select has_role(
  'exped_hub_release_promote',
  'role dedicada de promocao existe'
);

select is(
  (
    select array[rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls]
    from pg_catalog.pg_roles
    where rolname = 'exped_hub_release_stage'
  ),
  array[false, false, false, false, false, false],
  'role de stage nao autentica nem ignora RLS'
);

select is(
  (
    select array[rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls]
    from pg_catalog.pg_roles
    where rolname = 'exped_hub_release_promote'
  ),
  array[false, false, false, false, false, false],
  'role de promocao nao autentica nem ignora RLS'
);

select ok(
  pg_has_role('authenticator', 'exped_hub_release_stage', 'MEMBER'),
  'authenticator pode assumir role de stage'
);

select ok(
  pg_has_role('authenticator', 'exped_hub_release_promote', 'MEMBER'),
  'authenticator pode assumir role de promocao'
);

select ok(
  pg_has_role('exped_hub_release_stage', 'anon', 'MEMBER'),
  'stage herda privilegios base de anon'
);

select ok(
  pg_has_role('exped_hub_release_promote', 'anon', 'MEMBER'),
  'promocao herda privilegios base de anon'
);

select is(
  (
    select count(*)::integer
    from pg_catalog.pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname like 'hub_release_%'
  ),
  5,
  'cinco policies de release protegem storage.objects'
);

select is(
  (
    select count(*)::integer
    from pg_catalog.pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname like 'hub_release_%'
      and cmd = 'DELETE'
  ),
  0,
  'nenhuma role de release recebe policy de delete'
);

insert into storage.buckets (id, name, public)
values ('hub-releases', 'hub-releases', true)
on conflict (id) do update set public = excluded.public;

-- Isola os nomes usados pelo teste mesmo quando o bucket local ja contem
-- releases. O rollback restaura qualquer metadata preexistente.
set local storage.allow_delete_query = 'true';
delete from storage.objects
where bucket_id = 'hub-releases'
  and name in (
    'manifest.json',
    'windows/0.3.20.zip',
    'windows/0.3.21.zip',
    'windows/0.3.21.json',
    'windows/0.3.22.zip'
  );
set local storage.allow_delete_query = 'false';

set local role anon;

select throws_ok(
  $$
    insert into storage.objects (bucket_id, name, metadata)
    values ('hub-releases', 'windows/0.3.20.zip', '{}'::jsonb)
  $$,
  '42501',
  'new row violates row-level security policy for table "objects"',
  'anon nao escreve no bucket de releases'
);

reset role;
set local role exped_hub_release_stage;

select lives_ok(
  $$
    insert into storage.objects (bucket_id, name, metadata)
    values (
      'hub-releases',
      'windows/0.3.21.zip',
      '{"phase":"original"}'::jsonb
    )
  $$,
  'stage insere ZIP versionado'
);

select lives_ok(
  $$
    insert into storage.objects (bucket_id, name, metadata)
    values ('hub-releases', 'windows/0.3.21.json', '{}'::jsonb)
  $$,
  'stage insere metadata versionada'
);

select throws_ok(
  $$
    insert into storage.objects (bucket_id, name, metadata)
    values ('hub-releases', 'manifest.json', '{}'::jsonb)
  $$,
  '42501',
  'new row violates row-level security policy for table "objects"',
  'stage nao insere manifest'
);

update storage.objects
set metadata = '{"phase":"changed"}'::jsonb
where bucket_id = 'hub-releases'
  and name = 'windows/0.3.21.zip';

reset role;

select is(
  (
    select metadata ->> 'phase'
    from storage.objects
    where bucket_id = 'hub-releases'
      and name = 'windows/0.3.21.zip'
  ),
  'original',
  'stage nao sobrescreve artefato versionado'
);

set local role exped_hub_release_stage;

select throws_ok(
  $$
    delete from storage.objects
    where bucket_id = 'hub-releases'
      and name = 'windows/0.3.21.zip'
  $$,
  '42501',
  'Direct deletion from storage tables is not allowed. Use the Storage API instead.',
  'stage nao remove artefato versionado'
);

reset role;
insert into storage.objects (bucket_id, name, metadata)
values (
  'hub-releases',
  'manifest.json',
  '{"phase":"original"}'::jsonb
);
set local role exped_hub_release_promote;

select throws_ok(
  $$
    insert into storage.objects (bucket_id, name, metadata)
    values (
      'hub-releases',
      'manifest.json',
      '{"phase":"candidate"}'::jsonb
    )
  $$,
  '42501',
  'new row violates row-level security policy for table "objects"',
  'promocao nao cria manifest por escrita direta'
);

select results_eq(
  $sql$
    update storage.objects
    set metadata = '{"phase":"promoted"}'::jsonb
    where bucket_id = 'hub-releases'
      and name = 'manifest.json'
    returning id
  $sql$,
  $$select null::uuid where false$$,
  'promocao nao atualiza manifest fora de object.copy'
);

reset role;
select is(
  (
    select metadata ->> 'phase'
    from storage.objects
    where bucket_id = 'hub-releases'
      and name = 'manifest.json'
  ),
  'original',
  'manifest direto permaneceu intacto'
);

set local role exped_hub_release_promote;
select throws_ok(
  $$
    insert into storage.objects (bucket_id, name, metadata)
    values ('hub-releases', 'windows/0.3.22.zip', '{}'::jsonb)
  $$,
  '42501',
  'new row violates row-level security policy for table "objects"',
  'promocao nao insere artefato versionado'
);

select throws_ok(
  $$
    delete from storage.objects
    where bucket_id = 'hub-releases'
      and name = 'manifest.json'
  $$,
  '42501',
  'Direct deletion from storage tables is not allowed. Use the Storage API instead.',
  'promocao nao remove manifest'
);

select * from finish();
rollback;
