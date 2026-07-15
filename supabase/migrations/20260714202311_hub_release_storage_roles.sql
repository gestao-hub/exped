-- Release credentials are split by capability. Neither role can delete
-- objects, stage cannot move the public manifest, and promotion cannot alter
-- immutable versioned artifacts.
do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_roles
    where rolname = 'exped_hub_release_stage'
  ) then
    create role exped_hub_release_stage nologin inherit;
  end if;

  if not exists (
    select 1 from pg_catalog.pg_roles
    where rolname = 'exped_hub_release_promote'
  ) then
    create role exped_hub_release_promote nologin inherit;
  end if;

  if exists (
    select 1
    from pg_catalog.pg_roles
    where rolname in (
      'exped_hub_release_stage',
      'exped_hub_release_promote'
    )
      and (
        rolcanlogin
        or rolsuper
        or rolcreatedb
        or rolcreaterole
        or rolreplication
        or rolbypassrls
        or not rolinherit
      )
  ) then
    raise exception 'hub release roles existem com atributos inseguros';
  end if;
end;
$$;

-- Supabase Storage resolves the JWT role through authenticator. Inheriting
-- anon supplies the normal Storage schema/table grants; RLS below narrows the
-- rows and operations available to each release role.
grant exped_hub_release_stage to authenticator;
grant exped_hub_release_promote to authenticator;
grant anon to exped_hub_release_stage;
grant anon to exped_hub_release_promote;
grant usage on schema storage
  to exped_hub_release_stage, exped_hub_release_promote;
grant insert on storage.objects to exped_hub_release_stage;
grant select, insert, update on storage.objects to exped_hub_release_promote;

drop policy if exists "hub_release_stage_read" on storage.objects;
drop policy if exists "hub_release_stage_insert" on storage.objects;
drop policy if exists "hub_release_promote_read" on storage.objects;
drop policy if exists "hub_release_promote_insert_manifest" on storage.objects;
drop policy if exists "hub_release_promote_update_manifest" on storage.objects;

create policy "hub_release_stage_insert"
on storage.objects
for insert
to exped_hub_release_stage
with check (
  bucket_id = 'hub-releases'
  and name ~ '^windows/[0-9]+(\.[0-9]+){0,2}\.(zip|json)$'
);

create policy "hub_release_promote_read"
on storage.objects
for select
to exped_hub_release_promote
using (
  bucket_id = 'hub-releases'
  and name = 'manifest.json'
);

create policy "hub_release_promote_insert_manifest"
on storage.objects
for insert
to exped_hub_release_promote
with check (
  bucket_id = 'hub-releases'
  and name = 'manifest.json'
);

create policy "hub_release_promote_update_manifest"
on storage.objects
for update
to exped_hub_release_promote
using (
  bucket_id = 'hub-releases'
  and name = 'manifest.json'
)
with check (
  bucket_id = 'hub-releases'
  and name = 'manifest.json'
);
