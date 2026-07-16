-- Supabase Storage evaluates RLS writes inside testPermission(), rolls that
-- transaction back, then materializes an authorized copy with its internal
-- role. A policy may authorize the operation, but it cannot persist proof.
-- Guard the real storage.objects write instead and bind it to a one-time
-- promotion id plus the immutable candidate's backend ETag and size.

create table private.hub_release_copy_proofs (
  promotion_id uuid primary key,
  subject uuid not null,
  version text not null check (version ~ '^[0-9]+(\.[0-9]+){0,2}$'),
  source_name text not null,
  source_sha text not null check (source_sha ~ '^[a-f0-9]{40}$'),
  artifact_sha256 text not null check (artifact_sha256 ~ '^[a-f0-9]{64}$'),
  metadata_sha256 text not null check (metadata_sha256 ~ '^[a-f0-9]{64}$'),
  manifest_sha256 text not null check (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  object_version text not null check (object_version <> ''),
  object_etag text not null check (object_etag <> ''),
  object_size bigint not null check (object_size >= 0),
  observed_at timestamptz not null
);

revoke all on table private.hub_release_copy_proofs from public;
revoke all on table private.hub_release_copy_proofs
  from anon, authenticated, service_role,
    exped_hub_release_stage, exped_hub_release_promote;

create or replace function private.hub_release_manifest_write_authorized(
  p_name text,
  p_owner_id text,
  p_user_metadata jsonb
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.hub_release_promotion_state s
    where s.singleton
      and s.pending_promotion_id is not null
      and s.pending_expires_at > pg_catalog.clock_timestamp()
      and p_name = 'manifest.json'
      and p_owner_id = s.pending_subject::text
      and p_user_metadata = pg_catalog.jsonb_build_object(
        'expedRelease', pg_catalog.jsonb_build_object(
          'schemaVersion', 1,
          'kind', 'hub-release-manifest',
          'version', s.pending_version,
          'platform', 'win32',
          'sourceSha', s.pending_source_sha,
          'artifactSha256', s.pending_artifact_sha256,
          'manifestSha256', s.pending_manifest_sha256,
          'manifest', s.pending_manifest,
          'promotionId', s.pending_promotion_id
        )
      )
  )
$$;

revoke all on function private.hub_release_manifest_write_authorized(
  text, text, jsonb
) from public;
grant execute on function private.hub_release_manifest_write_authorized(
  text, text, jsonb
) to exped_hub_release_promote;

drop policy if exists "hub_release_promote_insert_manifest" on storage.objects;
drop policy if exists "hub_release_promote_update_manifest" on storage.objects;

create policy "hub_release_promote_insert_manifest"
on storage.objects
for insert
to exped_hub_release_promote
with check (
  bucket_id = 'hub-releases'
  and name = 'manifest.json'
  and storage.allow_only_operation('object.copy')
  and private.hub_release_copy_authorized(name)
  and private.hub_release_manifest_write_authorized(name, owner_id, user_metadata)
);

create policy "hub_release_promote_update_manifest"
on storage.objects
for update
to exped_hub_release_promote
using (
  bucket_id = 'hub-releases'
  and name = 'manifest.json'
  and storage.allow_only_operation('object.copy')
  and private.hub_release_copy_authorized(name)
)
with check (
  bucket_id = 'hub-releases'
  and name = 'manifest.json'
  and storage.allow_only_operation('object.copy')
  and private.hub_release_copy_authorized(name)
  and private.hub_release_manifest_write_authorized(name, owner_id, user_metadata)
);

drop function if exists private.hub_release_mark_copy(text, jsonb);

create or replace function private.hub_release_guard_manifest_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state private.hub_release_promotion_state%rowtype;
  v_source_metadata jsonb;
  v_source_user_metadata jsonb;
  v_source_etag text;
  v_object_etag text;
  v_source_size bigint;
  v_object_size bigint;
  v_expected_source_metadata jsonb;
  v_expected_object_metadata jsonb;
  v_observed_at timestamptz := pg_catalog.clock_timestamp();
begin
  if not storage.allow_only_operation('object.copy') then
    return new;
  end if;

  select * into strict v_state
  from private.hub_release_promotion_state
  where singleton
  for update;

  if v_state.pending_promotion_id is null then
    raise exception using
      errcode = '55000',
      message = 'nenhuma promocao ativa autoriza manifest canonico';
  end if;
  if v_state.pending_expires_at <= v_observed_at then
    raise exception using
      errcode = '55000',
      message = 'reserva de promocao expirou; autorize novamente';
  end if;
  if new.owner_id is distinct from v_state.pending_subject::text then
    raise exception using
      errcode = '55000',
      message = 'manifest canonico nao pertence ao subject da reserva';
  end if;

  v_expected_source_metadata := pg_catalog.jsonb_build_object(
    'expedRelease', pg_catalog.jsonb_build_object(
      'schemaVersion', 1,
      'kind', 'hub-release-manifest',
      'version', v_state.pending_version,
      'platform', 'win32',
      'sourceSha', v_state.pending_source_sha,
      'artifactSha256', v_state.pending_artifact_sha256,
      'manifestSha256', v_state.pending_manifest_sha256,
      'manifest', v_state.pending_manifest
    )
  );
  v_expected_object_metadata := pg_catalog.jsonb_build_object(
    'expedRelease', (v_expected_source_metadata -> 'expedRelease')
      || pg_catalog.jsonb_build_object(
        'promotionId', v_state.pending_promotion_id
      )
  );

  select o.metadata, o.user_metadata
  into v_source_metadata, v_source_user_metadata
  from storage.objects o
  where o.bucket_id = 'hub-releases'
    and o.name = v_state.pending_source_name;
  if not found then
    raise exception using
      errcode = '55000',
      message = 'candidato imutavel da promocao nao foi encontrado';
  end if;
  if v_source_user_metadata is distinct from v_expected_source_metadata then
    raise exception using
      errcode = '55000',
      message = 'candidato imutavel possui atestacao divergente';
  end if;
  if new.user_metadata is distinct from v_expected_object_metadata then
    raise exception using
      errcode = '55000',
      message = 'manifest canonico possui nonce ou atestacao divergente';
  end if;

  v_source_etag := v_source_metadata ->> 'eTag';
  v_object_etag := new.metadata ->> 'eTag';
  v_source_size := case
    when coalesce(v_source_metadata ->> 'size', '') ~ '^[0-9]+$'
      then (v_source_metadata ->> 'size')::bigint
    when coalesce(v_source_metadata ->> 'contentLength', '') ~ '^[0-9]+$'
      then (v_source_metadata ->> 'contentLength')::bigint
    else null
  end;
  v_object_size := case
    when coalesce(new.metadata ->> 'size', '') ~ '^[0-9]+$'
      then (new.metadata ->> 'size')::bigint
    when coalesce(new.metadata ->> 'contentLength', '') ~ '^[0-9]+$'
      then (new.metadata ->> 'contentLength')::bigint
    else null
  end;
  if v_source_etag is null
    or v_object_etag is distinct from v_source_etag
    or v_source_size is null
    or v_object_size is distinct from v_source_size
  then
    raise exception using
      errcode = '55000',
      message = 'manifest canonico diverge do candidato imutavel';
  end if;
  if new.version is null or new.version = '' then
    raise exception using
      errcode = '55000',
      message = 'manifest canonico exige versao materializada do Storage';
  end if;
  if v_observed_at <= v_state.pending_requested_at then
    raise exception using
      errcode = '55000',
      message = 'gravacao canonica nao e posterior ao inicio da reserva';
  end if;

  delete from private.hub_release_copy_proofs p
  where p.promotion_id <> v_state.pending_promotion_id
    and p.observed_at < v_state.pending_requested_at;

  insert into private.hub_release_copy_proofs (
    promotion_id,
    subject,
    version,
    source_name,
    source_sha,
    artifact_sha256,
    metadata_sha256,
    manifest_sha256,
    object_version,
    object_etag,
    object_size,
    observed_at
  ) values (
    v_state.pending_promotion_id,
    v_state.pending_subject,
    v_state.pending_version,
    v_state.pending_source_name,
    v_state.pending_source_sha,
    v_state.pending_artifact_sha256,
    v_state.pending_metadata_sha256,
    v_state.pending_manifest_sha256,
    new.version,
    v_object_etag,
    v_object_size,
    v_observed_at
  )
  on conflict (promotion_id) do update set
    subject = excluded.subject,
    version = excluded.version,
    source_name = excluded.source_name,
    source_sha = excluded.source_sha,
    artifact_sha256 = excluded.artifact_sha256,
    metadata_sha256 = excluded.metadata_sha256,
    manifest_sha256 = excluded.manifest_sha256,
    object_version = excluded.object_version,
    object_etag = excluded.object_etag,
    object_size = excluded.object_size,
    observed_at = excluded.observed_at;

  update private.hub_release_promotion_state
  set
    pending_copy_promotion_id = pending_promotion_id,
    pending_copy_observed_at = v_observed_at
  where singleton;

  return new;
end;
$$;

revoke all on function private.hub_release_guard_manifest_write() from public;

drop trigger if exists hub_release_guard_manifest_write on storage.objects;
create trigger hub_release_guard_manifest_write
before insert or update on storage.objects
for each row
when (
  new.bucket_id = 'hub-releases'
  and new.name = 'manifest.json'
)
execute function private.hub_release_guard_manifest_write();

create or replace function private.hub_release_assert_materialized_copy(
  p_state private.hub_release_promotion_state,
  p_subject uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_proof private.hub_release_copy_proofs%rowtype;
  v_object_version text;
  v_object_owner_id text;
  v_object_metadata jsonb;
  v_object_user_metadata jsonb;
  v_expected_object_metadata jsonb;
  v_object_size bigint;
begin
  select * into v_proof
  from private.hub_release_copy_proofs p
  where p.promotion_id = p_state.pending_promotion_id
    and p.subject = p_subject;
  if not found then
    raise exception using
      errcode = '55000',
      message = 'Storage API ainda nao comprovou a copia canonica desta promocao';
  end if;
  if v_proof.version <> p_state.pending_version
    or v_proof.source_name <> p_state.pending_source_name
    or v_proof.source_sha <> p_state.pending_source_sha
    or v_proof.artifact_sha256 <> p_state.pending_artifact_sha256
    or v_proof.metadata_sha256 <> p_state.pending_metadata_sha256
    or v_proof.manifest_sha256 <> p_state.pending_manifest_sha256
    or v_proof.observed_at <= p_state.pending_requested_at
  then
    raise exception using
      errcode = '55000',
      message = 'prova canonica nao corresponde a reserva ativa';
  end if;

  v_expected_object_metadata := pg_catalog.jsonb_build_object(
    'expedRelease', pg_catalog.jsonb_build_object(
      'schemaVersion', 1,
      'kind', 'hub-release-manifest',
      'version', p_state.pending_version,
      'platform', 'win32',
      'sourceSha', p_state.pending_source_sha,
      'artifactSha256', p_state.pending_artifact_sha256,
      'manifestSha256', p_state.pending_manifest_sha256,
      'manifest', p_state.pending_manifest,
      'promotionId', p_state.pending_promotion_id
    )
  );

  select o.version, o.owner_id, o.metadata, o.user_metadata
  into v_object_version, v_object_owner_id, v_object_metadata, v_object_user_metadata
  from storage.objects o
  where o.bucket_id = 'hub-releases'
    and o.name = 'manifest.json';
  if not found
    or v_object_version is distinct from v_proof.object_version
    or v_object_owner_id is distinct from p_subject::text
    or v_object_user_metadata is distinct from v_expected_object_metadata
    or (v_object_metadata ->> 'eTag') is distinct from v_proof.object_etag
  then
    raise exception using
      errcode = '55000',
      message = 'manifest canonico mudou depois da prova materializada';
  end if;
  v_object_size := case
    when coalesce(v_object_metadata ->> 'size', '') ~ '^[0-9]+$'
      then (v_object_metadata ->> 'size')::bigint
    when coalesce(v_object_metadata ->> 'contentLength', '') ~ '^[0-9]+$'
      then (v_object_metadata ->> 'contentLength')::bigint
    else null
  end;
  if v_object_size is distinct from v_proof.object_size then
    raise exception using
      errcode = '55000',
      message = 'manifest canonico mudou depois da prova materializada';
  end if;

  return pg_catalog.jsonb_build_object(
    'promotionId', p_state.pending_promotion_id,
    'observedAt', v_proof.observed_at,
    'objectVersion', v_proof.object_version,
    'sourceSha', p_state.pending_source_sha,
    'artifactSha256', p_state.pending_artifact_sha256,
    'metadataSha256', p_state.pending_metadata_sha256,
    'manifestSha256', p_state.pending_manifest_sha256
  );
end;
$$;

revoke all on function private.hub_release_assert_materialized_copy(
  private.hub_release_promotion_state, uuid
) from public;

create or replace function public.attest_hub_release_manifest_copy(
  p_promotion_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subject uuid := private.hub_release_subject('exped_hub_release_promote');
  v_state private.hub_release_promotion_state%rowtype;
begin
  select * into strict v_state
  from private.hub_release_promotion_state
  where singleton
  for update;

  if v_state.pending_promotion_id is null then
    raise exception using errcode = '55000', message = 'nenhuma promocao esta pendente';
  end if;
  if v_state.pending_promotion_id <> p_promotion_id then
    raise exception using errcode = '55000', message = 'promotion_id nao corresponde a reserva ativa';
  end if;
  if v_state.pending_expires_at <= pg_catalog.clock_timestamp() then
    raise exception using errcode = '55000', message = 'reserva de promocao expirou; autorize novamente';
  end if;
  if v_state.pending_subject <> v_subject then
    raise exception using errcode = '42501', message = 'somente o subject que reservou pode atestar';
  end if;

  return private.hub_release_assert_materialized_copy(v_state, v_subject);
end;
$$;

revoke all on function public.attest_hub_release_manifest_copy(uuid)
  from public, anon, authenticated, service_role, exped_hub_release_stage;
grant execute on function public.attest_hub_release_manifest_copy(uuid)
  to exped_hub_release_promote;

create or replace function public.complete_hub_release_promotion(
  p_promotion_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subject uuid := private.hub_release_subject('exped_hub_release_promote');
  v_state private.hub_release_promotion_state%rowtype;
begin
  select * into strict v_state
  from private.hub_release_promotion_state
  where singleton
  for update;

  if v_state.pending_promotion_id is null then
    if v_state.current_promotion_id = p_promotion_id then
      return pg_catalog.jsonb_build_object(
        'manifest', v_state.current_manifest,
        'requiresCopy', false,
        'promotionId', v_state.current_promotion_id,
        'sourceSha', v_state.current_source_sha,
        'artifactSha256', v_state.current_artifact_sha256,
        'metadataSha256', v_state.current_metadata_sha256,
        'manifestSha256', v_state.current_manifest_sha256
      );
    end if;
    raise exception using errcode = '55000', message = 'nenhuma promocao compativel esta pendente';
  end if;
  if v_state.pending_promotion_id <> p_promotion_id then
    raise exception using errcode = '55000', message = 'promotion_id nao corresponde a reserva ativa';
  end if;
  if v_state.pending_expires_at <= pg_catalog.clock_timestamp() then
    raise exception using errcode = '55000', message = 'reserva de promocao expirou; autorize novamente';
  end if;
  if v_state.pending_subject <> v_subject then
    raise exception using errcode = '42501', message = 'somente o subject que reservou pode concluir';
  end if;
  if v_state.pending_copy_promotion_id is distinct from v_state.pending_promotion_id
    or v_state.pending_copy_observed_at is null
  then
    raise exception using
      errcode = '55000',
      message = 'Storage API ainda nao comprovou a copia canonica desta promocao';
  end if;

  perform private.hub_release_assert_materialized_copy(v_state, v_subject);

  update private.hub_release_promotion_state
  set
    current_promotion_id = pending_promotion_id,
    current_version = pending_version,
    current_source_sha = pending_source_sha,
    current_artifact_sha256 = pending_artifact_sha256,
    current_metadata_sha256 = pending_metadata_sha256,
    current_manifest = pending_manifest,
    current_manifest_sha256 = pending_manifest_sha256,
    pending_promotion_id = null,
    pending_version = null,
    pending_source_sha = null,
    pending_artifact_sha256 = null,
    pending_metadata_sha256 = null,
    pending_manifest = null,
    pending_manifest_sha256 = null,
    pending_source_name = null,
    pending_subject = null,
    pending_requested_at = null,
    pending_expires_at = null,
    pending_copy_promotion_id = null,
    pending_copy_observed_at = null
  where singleton
  returning * into strict v_state;

  delete from private.hub_release_copy_proofs
  where promotion_id = p_promotion_id;

  return pg_catalog.jsonb_build_object(
    'manifest', v_state.current_manifest,
    'requiresCopy', false,
    'promotionId', v_state.current_promotion_id,
    'sourceSha', v_state.current_source_sha,
    'artifactSha256', v_state.current_artifact_sha256,
    'metadataSha256', v_state.current_metadata_sha256,
    'manifestSha256', v_state.current_manifest_sha256
  );
end;
$$;

revoke all on function public.complete_hub_release_promotion(uuid)
  from public, anon, authenticated, service_role, exped_hub_release_stage;
grant execute on function public.complete_hub_release_promotion(uuid)
  to exped_hub_release_promote;
