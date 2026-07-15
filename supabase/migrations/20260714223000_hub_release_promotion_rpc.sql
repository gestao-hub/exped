-- Release identity and promotion coordination live in application-owned tables.
-- Storage objects are created and copied only through the public Storage API.
-- RLS uses Supabase's documented operation helper to restrict the mutable
-- manifest to a canonical copy authorized by a short-lived pending record.

create schema if not exists private authorization postgres;
revoke all on schema private from public;

do $$
begin
  if to_regprocedure('storage.allow_only_operation(text)') is null then
    raise exception using
      errcode = '55000',
      message = 'Supabase Storage schema is outdated: storage.allow_only_operation(text) is required';
  end if;
end;
$$;

-- Storage info() is a supported API but still needs SELECT plus RLS. The
-- policy at the end narrows this grant to immutable versioned release paths.
grant select on storage.objects to exped_hub_release_stage;

create table private.hub_release_artifacts (
  version text primary key
    check (version ~ '^[0-9]+(\.[0-9]+){0,2}$'),
  source_sha text not null
    check (source_sha ~ '^[a-f0-9]{40}$'),
  artifact_sha256 text not null
    check (artifact_sha256 ~ '^[a-f0-9]{64}$'),
  metadata_sha256 text not null
    check (metadata_sha256 ~ '^[a-f0-9]{64}$'),
  approval jsonb not null
    check (pg_catalog.jsonb_typeof(approval) = 'object'),
  registered_subject uuid not null,
  registered_at timestamptz not null default pg_catalog.clock_timestamp(),
  unique (source_sha, artifact_sha256, metadata_sha256)
);

revoke all on table private.hub_release_artifacts from public;
revoke all on table private.hub_release_artifacts
  from anon, authenticated, service_role,
    exped_hub_release_stage, exped_hub_release_promote;

create table private.hub_release_promotion_state (
  singleton boolean primary key default true check (singleton),
  initialized boolean not null default false,
  current_promotion_id uuid,
  current_version text
    check (current_version is null or current_version ~ '^[0-9]+(\.[0-9]+){0,2}$'),
  current_source_sha text
    check (current_source_sha is null or current_source_sha ~ '^[a-f0-9]{40}$'),
  current_artifact_sha256 text
    check (current_artifact_sha256 is null or current_artifact_sha256 ~ '^[a-f0-9]{64}$'),
  current_metadata_sha256 text
    check (current_metadata_sha256 is null or current_metadata_sha256 ~ '^[a-f0-9]{64}$'),
  current_manifest jsonb,
  current_manifest_sha256 text
    check (current_manifest_sha256 is null or current_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  pending_promotion_id uuid,
  pending_version text
    check (pending_version is null or pending_version ~ '^[0-9]+(\.[0-9]+){0,2}$'),
  pending_source_sha text
    check (pending_source_sha is null or pending_source_sha ~ '^[a-f0-9]{40}$'),
  pending_artifact_sha256 text
    check (pending_artifact_sha256 is null or pending_artifact_sha256 ~ '^[a-f0-9]{64}$'),
  pending_metadata_sha256 text
    check (pending_metadata_sha256 is null or pending_metadata_sha256 ~ '^[a-f0-9]{64}$'),
  pending_manifest jsonb,
  pending_manifest_sha256 text
    check (pending_manifest_sha256 is null or pending_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  pending_source_name text,
  pending_subject uuid,
  pending_requested_at timestamptz,
  pending_expires_at timestamptz,
  pending_copy_promotion_id uuid,
  pending_copy_observed_at timestamptz,
  constraint hub_release_current_complete check (
    (
      not initialized
      and current_promotion_id is null
      and current_version is null
      and current_source_sha is null
      and current_artifact_sha256 is null
      and current_metadata_sha256 is null
      and current_manifest is null
      and current_manifest_sha256 is null
    )
    or
    (
      initialized
      and current_version is not null
      and current_manifest is not null
      and current_manifest_sha256 is not null
      and (
        (
          current_promotion_id is null
          and current_source_sha is null
          and current_artifact_sha256 is null
          and current_metadata_sha256 is null
        )
        or
        (
          current_promotion_id is not null
          and current_source_sha is not null
          and current_artifact_sha256 is not null
          and current_metadata_sha256 is not null
        )
      )
    )
  ),
  constraint hub_release_pending_complete check (
    (
      pending_promotion_id is null
      and pending_version is null
      and pending_source_sha is null
      and pending_artifact_sha256 is null
      and pending_metadata_sha256 is null
      and pending_manifest is null
      and pending_manifest_sha256 is null
      and pending_source_name is null
      and pending_subject is null
      and pending_requested_at is null
      and pending_expires_at is null
      and pending_copy_promotion_id is null
      and pending_copy_observed_at is null
    )
    or
    (
      pending_promotion_id is not null
      and pending_version is not null
      and pending_source_sha is not null
      and pending_artifact_sha256 is not null
      and pending_metadata_sha256 is not null
      and pending_manifest is not null
      and pending_manifest_sha256 is not null
      and pending_source_name is not null
      and pending_subject is not null
      and pending_requested_at is not null
      and pending_expires_at is not null
      and pending_expires_at > pending_requested_at
      and (
        (
          pending_copy_promotion_id is null
          and pending_copy_observed_at is null
        )
        or
        (
          pending_copy_promotion_id = pending_promotion_id
          and pending_copy_observed_at is not null
        )
      )
    )
  )
);

revoke all on table private.hub_release_promotion_state from public;
revoke all on table private.hub_release_promotion_state
  from anon, authenticated, service_role,
    exped_hub_release_stage, exped_hub_release_promote;

insert into private.hub_release_promotion_state (singleton, initialized)
values (true, false)
on conflict (singleton) do nothing;

create or replace function private.hub_release_version_parts(p_version text)
returns numeric[]
language sql
immutable
strict
set search_path = ''
as $$
  select array[
    split_part(p_version, '.', 1)::numeric,
    coalesce(nullif(split_part(p_version, '.', 2), ''), '0')::numeric,
    coalesce(nullif(split_part(p_version, '.', 3), ''), '0')::numeric
  ]
$$;

revoke all on function private.hub_release_version_parts(text) from public;

create or replace function private.hub_release_subject(p_expected_role text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_subject uuid;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> p_expected_role then
    raise exception using
      errcode = '42501',
      message = pg_catalog.format('somente a role %s pode executar esta operacao', p_expected_role);
  end if;

  begin
    v_subject := (auth.jwt() ->> 'sub')::uuid;
  exception when others then
    raise exception using
      errcode = '42501',
      message = 'JWT de release exige sub UUID valida';
  end;
  if v_subject is null then
    raise exception using
      errcode = '42501',
      message = 'JWT de release exige sub UUID valida';
  end if;
  return v_subject;
end;
$$;

revoke all on function private.hub_release_subject(text) from public;

create or replace function public.register_hub_release_artifact(
  p_project_ref text,
  p_release jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subject uuid := private.hub_release_subject('exped_hub_release_stage');
  v_version text := p_release ->> 'version';
  v_source_sha text := p_release ->> 'source_sha';
  v_artifact_sha256 text := p_release -> 'artifact' ->> 'sha256';
  v_metadata_sha256 text := p_release -> 'metadata' ->> 'sha256';
  v_metadata_text text;
  v_manifest_text text;
  v_rollback_text text;
  v_manifest_sha256 text;
  v_rollback_sha256 text;
  v_url text;
  v_expected jsonb;
  v_existing private.hub_release_artifacts%rowtype;
begin
  if p_project_ref is null or p_project_ref !~ '^[a-z0-9]{20}$' then
    raise exception using errcode = '22023', message = 'PROJECT_REF invalido';
  end if;
  if p_release is null or pg_catalog.jsonb_typeof(p_release) <> 'object'
    or v_version is null or v_version !~ '^[0-9]+(\.[0-9]+){0,2}$'
  then
    raise exception using errcode = '22023', message = 'approval de release invalido';
  end if;
  if p_release ->> 'project_ref' is distinct from p_project_ref
    or p_release ->> 'schema_version' is distinct from '1'
    or v_source_sha is null or v_source_sha !~ '^[a-f0-9]{40}$'
    or v_artifact_sha256 is null or v_artifact_sha256 !~ '^[a-f0-9]{64}$'
    or v_metadata_sha256 is null or v_metadata_sha256 !~ '^[a-f0-9]{64}$'
  then
    raise exception using errcode = '22023', message = 'identidade do approval de release invalida';
  end if;

  select * into v_existing
  from private.hub_release_artifacts
  where version = v_version;
  if found then
    if v_existing.approval is distinct from p_release then
      raise exception using
        errcode = '22023',
        message = pg_catalog.format(
          'release %s ja foi registrada com identidade diferente',
          v_version
        );
    end if;
    return p_release;
  end if;

  v_url := pg_catalog.format(
    'https://%s.supabase.co/storage/v1/object/public/hub-releases/windows/%s.zip',
    p_project_ref,
    v_version
  );
  v_metadata_text :=
    '{"schema_version":1,"versao":' || pg_catalog.to_json(v_version)::text
    || ',"platform":"win32","source_sha":' || pg_catalog.to_json(v_source_sha)::text
    || ',"sha256":' || pg_catalog.to_json(v_artifact_sha256)::text || '}';
  v_manifest_text :=
    '{"versao":' || pg_catalog.to_json(v_version)::text
    || ',"url":' || pg_catalog.to_json(v_url)::text
    || ',"sha256":' || pg_catalog.to_json(v_artifact_sha256)::text || '}';
  v_rollback_text :=
    '{"versao":' || pg_catalog.to_json(v_version)::text
    || ',"url":' || pg_catalog.to_json(v_url)::text
    || ',"sha256":' || pg_catalog.to_json(v_artifact_sha256)::text
    || ',"allowDowngrade":true,"minimumHubVersion":"0.3.21"}';
  v_manifest_sha256 := pg_catalog.encode(
    extensions.digest(v_manifest_text, 'sha256'),
    'hex'
  );
  v_rollback_sha256 := pg_catalog.encode(
    extensions.digest(v_rollback_text, 'sha256'),
    'hex'
  );

  v_expected := pg_catalog.jsonb_build_object(
    'schema_version', 1,
    'project_ref', p_project_ref,
    'version', v_version,
    'source_sha', v_source_sha,
    'artifact', pg_catalog.jsonb_build_object(
      'path', pg_catalog.format('windows/%s.zip', v_version),
      'sha256', v_artifact_sha256
    ),
    'metadata', pg_catalog.jsonb_build_object(
      'path', pg_catalog.format('windows/%s.json', v_version),
      'sha256', pg_catalog.encode(extensions.digest(v_metadata_text, 'sha256'), 'hex'),
      'body', v_metadata_text::jsonb
    ),
    'manifests', pg_catalog.jsonb_build_object(
      'release', pg_catalog.jsonb_build_object(
        'path', pg_catalog.format('windows/%s.manifest.json', v_version),
        'sha256', v_manifest_sha256,
        'body', v_manifest_text::jsonb
      ),
      'rollback', pg_catalog.jsonb_build_object(
        'path', pg_catalog.format('windows/%s.rollback-manifest.json', v_version),
        'sha256', v_rollback_sha256,
        'body', v_rollback_text::jsonb
      )
    )
  );

  if p_release is distinct from v_expected then
    raise exception using
      errcode = '22023',
      message = pg_catalog.format('approval da release %s nao e canonico', v_version);
  end if;

  insert into private.hub_release_artifacts (
    version,
    source_sha,
    artifact_sha256,
    metadata_sha256,
    approval,
    registered_subject
  ) values (
    v_version,
    v_source_sha,
    v_artifact_sha256,
    v_metadata_sha256,
    p_release,
    v_subject
  )
  on conflict (version) do nothing;

  select * into strict v_existing
  from private.hub_release_artifacts
  where version = v_version;
  if v_existing.approval is distinct from p_release then
    raise exception using
      errcode = '22023',
      message = pg_catalog.format(
        'release %s ja foi registrada com identidade diferente',
        v_version
      );
  end if;

  return p_release;
end;
$$;

revoke all on function public.register_hub_release_artifact(text, jsonb)
  from public, anon, authenticated, service_role, exped_hub_release_promote;
grant execute on function public.register_hub_release_artifact(text, jsonb)
  to exped_hub_release_stage;

create or replace function public.initialize_hub_release_promotion(
  p_project_ref text,
  p_manifest_text text,
  p_manifest_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subject uuid := private.hub_release_subject('exped_hub_release_promote');
  v_state private.hub_release_promotion_state%rowtype;
  v_manifest jsonb;
  v_version text;
  v_sha256 text;
  v_url text;
  v_expected jsonb;
begin
  perform v_subject;
  if p_project_ref is null or p_project_ref !~ '^[a-z0-9]{20}$' then
    raise exception using errcode = '22023', message = 'PROJECT_REF invalido';
  end if;

  select * into strict v_state
  from private.hub_release_promotion_state
  where singleton
  for update;

  if v_state.initialized then
    return pg_catalog.jsonb_build_object(
      'initialized', true,
      'currentVersion', v_state.current_version,
      'currentManifestSha256', v_state.current_manifest_sha256
    );
  end if;

  if p_manifest_text is null
    or p_manifest_sha256 is null
    or p_manifest_sha256 !~ '^[a-f0-9]{64}$'
    or pg_catalog.encode(extensions.digest(p_manifest_text, 'sha256'), 'hex')
      <> p_manifest_sha256
  then
    raise exception using
      errcode = '22023',
      message = 'bytes observados do manifest legado sao invalidos';
  end if;

  begin
    v_manifest := p_manifest_text::jsonb;
  exception when others then
    raise exception using errcode = '22023', message = 'manifest legado nao contem JSON valido';
  end;

  v_version := v_manifest ->> 'versao';
  v_sha256 := v_manifest ->> 'sha256';
  v_url := v_manifest ->> 'url';
  if v_version is null or v_version !~ '^[0-9]+(\.[0-9]+){0,2}$'
    or v_sha256 is null or v_sha256 !~ '^[a-f0-9]{64}$'
    or v_url not in (
      pg_catalog.format(
        'https://%s.supabase.co/storage/v1/object/public/hub-releases/%s.zip',
        p_project_ref,
        v_version
      ),
      pg_catalog.format(
        'https://%s.supabase.co/storage/v1/object/public/hub-releases/windows/%s.zip',
        p_project_ref,
        v_version
      )
    )
  then
    raise exception using errcode = '22023', message = 'manifest legado observado nao e canonico';
  end if;

  v_expected := pg_catalog.jsonb_build_object(
    'versao', v_version,
    'url', v_url,
    'sha256', v_sha256
  );
  if v_manifest ? 'allowDowngrade' or v_manifest ? 'minimumHubVersion' then
    if v_manifest ->> 'allowDowngrade' <> 'true'
      or v_manifest ->> 'minimumHubVersion' <> '0.3.21'
    then
      raise exception using errcode = '22023', message = 'metadata de downgrade legada invalida';
    end if;
    v_expected := v_expected || pg_catalog.jsonb_build_object(
      'allowDowngrade', true,
      'minimumHubVersion', '0.3.21'
    );
  end if;
  if v_manifest is distinct from v_expected then
    raise exception using errcode = '22023', message = 'manifest legado observado nao e canonico';
  end if;

  update private.hub_release_promotion_state
  set
    initialized = true,
    current_version = v_version,
    current_manifest = v_manifest,
    current_manifest_sha256 = p_manifest_sha256
  where singleton;

  return pg_catalog.jsonb_build_object(
    'initialized', true,
    'currentVersion', v_version,
    'currentManifestSha256', p_manifest_sha256
  );
end;
$$;

revoke all on function public.initialize_hub_release_promotion(text, text, text)
  from public, anon, authenticated, service_role, exped_hub_release_stage;
grant execute on function public.initialize_hub_release_promotion(text, text, text)
  to exped_hub_release_promote;

create or replace function private.hub_release_pending_directive(
  p_state private.hub_release_promotion_state
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'manifest', p_state.pending_manifest,
    'source', p_state.pending_source_name,
    'destination', 'manifest.json',
    'requiresCopy', true,
    'promotionId', p_state.pending_promotion_id,
    'expiresAt', p_state.pending_expires_at,
    'sourceSha', p_state.pending_source_sha,
    'artifactSha256', p_state.pending_artifact_sha256,
    'metadataSha256', p_state.pending_metadata_sha256,
    'manifestSha256', p_state.pending_manifest_sha256
  )
$$;

revoke all on function private.hub_release_pending_directive(
  private.hub_release_promotion_state
) from public;

drop function if exists public.promote_hub_release(text, text, boolean, text);

create or replace function public.promote_hub_release(
  p_project_ref text,
  p_version text,
  p_source_sha text,
  p_artifact_sha256 text,
  p_metadata_sha256 text,
  p_allow_downgrade boolean default false,
  p_minimum_hub_version text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subject uuid := private.hub_release_subject('exped_hub_release_promote');
  v_state private.hub_release_promotion_state%rowtype;
  v_artifact private.hub_release_artifacts%rowtype;
  v_order integer;
  v_is_downgrade boolean;
  v_manifest jsonb;
  v_manifest_sha256 text;
  v_source_name text;
  v_promotion_id uuid;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_expires_at timestamptz;
begin
  if p_project_ref is null or p_project_ref !~ '^[a-z0-9]{20}$' then
    raise exception using errcode = '22023', message = 'PROJECT_REF invalido';
  end if;
  if p_version is null or p_version !~ '^[0-9]+(\.[0-9]+){0,2}$'
    or p_source_sha is null or p_source_sha !~ '^[a-f0-9]{40}$'
    or p_artifact_sha256 is null or p_artifact_sha256 !~ '^[a-f0-9]{64}$'
    or p_metadata_sha256 is null or p_metadata_sha256 !~ '^[a-f0-9]{64}$'
  then
    raise exception using errcode = '22023', message = 'identidade do artifact aprovado invalida';
  end if;
  if p_allow_downgrade is null then
    raise exception using errcode = '22023', message = 'allowDowngrade deve ser booleano';
  end if;
  if p_minimum_hub_version is not null and not p_allow_downgrade then
    raise exception using errcode = '22023', message = 'minimumHubVersion exige allowDowngrade';
  end if;

  select * into strict v_state
  from private.hub_release_promotion_state
  where singleton
  for update;

  if not v_state.initialized then
    raise exception using
      errcode = '55000',
      message = 'estado inicial de promocao desconhecido; observe o manifest canonico pela API';
  end if;

  if v_state.pending_promotion_id is not null
    and v_state.pending_expires_at <= v_now
  then
    if v_state.pending_copy_promotion_id is not null then
      if v_state.pending_version <> p_version
        or v_state.pending_source_sha <> p_source_sha
        or v_state.pending_artifact_sha256 <> p_artifact_sha256
        or v_state.pending_metadata_sha256 <> p_metadata_sha256
        or not exists (
          select 1
          from private.hub_release_artifacts a
          where a.version = p_version
            and a.source_sha = p_source_sha
            and a.artifact_sha256 = p_artifact_sha256
            and a.metadata_sha256 = p_metadata_sha256
            and a.approval ->> 'project_ref' = p_project_ref
        )
      then
        raise exception using
          errcode = '55000',
          message = 'promocao copiada aguarda recovery da mesma identidade';
      end if;
      if v_state.pending_manifest ->> 'allowDowngrade' = 'true'
        and (
          not p_allow_downgrade
          or p_minimum_hub_version is distinct from '0.3.21'
        )
      then
        raise exception using
          errcode = '22023',
          message = 'recovery exige confirmacao do downgrade 0.3.21 original';
      end if;

      -- A copia pode ter sido concluida antes de uma queda do runner. Somente
      -- a mesma identidade pode assumir o recovery; uma nova copia e prova sao
      -- obrigatorias para vincular a credencial atual ao estado materializado.
      v_promotion_id := pg_catalog.gen_random_uuid();
      v_expires_at := v_now + interval '10 minutes';
      update private.hub_release_promotion_state
      set
        pending_promotion_id = v_promotion_id,
        pending_subject = v_subject,
        pending_requested_at = v_now,
        pending_expires_at = v_expires_at,
        pending_copy_promotion_id = null,
        pending_copy_observed_at = null
      where singleton
      returning * into strict v_state;
      return private.hub_release_pending_directive(v_state);
    else
      update private.hub_release_promotion_state
      set
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
    end if;
  end if;

  if v_state.pending_promotion_id is not null then
    if v_state.pending_version = p_version
      and v_state.pending_source_sha = p_source_sha
      and v_state.pending_artifact_sha256 = p_artifact_sha256
      and v_state.pending_metadata_sha256 = p_metadata_sha256
    then
      if v_state.pending_subject <> v_subject then
        raise exception using
          errcode = '55000',
          message = pg_catalog.format(
            'promocao %s esta reservada por outra credencial ate expirar',
            p_version
          );
      end if;
      if v_state.pending_manifest ->> 'allowDowngrade' = 'true'
        and (
          not p_allow_downgrade
          or p_minimum_hub_version is distinct from '0.3.21'
        )
      then
        raise exception using
          errcode = '22023',
          message = 'reserva pendente exige confirmacao de downgrade 0.3.21';
      end if;
      return private.hub_release_pending_directive(v_state);
    end if;

    raise exception using
      errcode = '55000',
      message = pg_catalog.format(
        'promocao %s ja esta em andamento',
        v_state.pending_version
      );
  end if;

  select * into v_artifact
  from private.hub_release_artifacts
  where version = p_version
    and source_sha = p_source_sha
    and artifact_sha256 = p_artifact_sha256
    and metadata_sha256 = p_metadata_sha256
    and approval ->> 'project_ref' = p_project_ref;
  if not found then
    raise exception using
      errcode = '22023',
      message = 'artifact aprovado nao corresponde ao release registrado';
  end if;

  v_order := case
    when private.hub_release_version_parts(p_version)
      > private.hub_release_version_parts(v_state.current_version) then 1
    when private.hub_release_version_parts(p_version)
      < private.hub_release_version_parts(v_state.current_version) then -1
    else 0
  end;
  if v_order = 0 and p_version <> v_state.current_version then
    raise exception using
      errcode = '22023',
      message = 'versao semanticamente equivalente usa grafia diferente';
  end if;

  if v_order = 0 and v_state.current_source_sha is null then
    raise exception using
      errcode = '22023',
      message = 'versao atual legada possui identidade imutavel desconhecida; publique versao superior';
  end if;

  if v_order = 0 and v_state.current_source_sha is not null then
    if v_state.current_source_sha <> p_source_sha
      or v_state.current_artifact_sha256 <> p_artifact_sha256
      or v_state.current_metadata_sha256 <> p_metadata_sha256
    then
      raise exception using
        errcode = '22023',
        message = 'versao atual foi promovida com outra identidade de artifact';
    end if;
    return pg_catalog.jsonb_build_object(
      'manifest', v_state.current_manifest,
      'source', case
        when v_state.current_manifest ->> 'allowDowngrade' = 'true'
        then v_artifact.approval -> 'manifests' -> 'rollback' ->> 'path'
        else v_artifact.approval -> 'manifests' -> 'release' ->> 'path'
      end,
      'destination', 'manifest.json',
      'requiresCopy', false,
      'promotionId', v_state.current_promotion_id,
      'sourceSha', p_source_sha,
      'artifactSha256', p_artifact_sha256,
      'metadataSha256', p_metadata_sha256,
      'manifestSha256', v_state.current_manifest_sha256
    );
  end if;

  v_is_downgrade := v_order < 0;
  if v_is_downgrade then
    if not p_allow_downgrade then
      raise exception using
        errcode = '22023',
        message = pg_catalog.format(
          'versao %s e menor que manifest atual %s; use --allow-downgrade',
          p_version,
          v_state.current_version
        );
    end if;
    if p_minimum_hub_version is distinct from '0.3.21' then
      raise exception using
        errcode = '22023',
        message = 'downgrade exige confirmacao exata do ExpedSetup/Hub 0.3.21';
    end if;
  end if;

  if v_is_downgrade then
    v_manifest := v_artifact.approval -> 'manifests' -> 'rollback' -> 'body';
    v_manifest_sha256 := v_artifact.approval -> 'manifests' -> 'rollback' ->> 'sha256';
    v_source_name := v_artifact.approval -> 'manifests' -> 'rollback' ->> 'path';
  else
    v_manifest := v_artifact.approval -> 'manifests' -> 'release' -> 'body';
    v_manifest_sha256 := v_artifact.approval -> 'manifests' -> 'release' ->> 'sha256';
    v_source_name := v_artifact.approval -> 'manifests' -> 'release' ->> 'path';
  end if;

  v_promotion_id := pg_catalog.gen_random_uuid();
  v_expires_at := v_now + interval '10 minutes';
  update private.hub_release_promotion_state
  set
    pending_promotion_id = v_promotion_id,
    pending_version = p_version,
    pending_source_sha = p_source_sha,
    pending_artifact_sha256 = p_artifact_sha256,
    pending_metadata_sha256 = p_metadata_sha256,
    pending_manifest = v_manifest,
    pending_manifest_sha256 = v_manifest_sha256,
    pending_source_name = v_source_name,
    pending_subject = v_subject,
    pending_requested_at = v_now,
    pending_expires_at = v_expires_at,
    pending_copy_promotion_id = null,
    pending_copy_observed_at = null
  where singleton
  returning * into strict v_state;

  return private.hub_release_pending_directive(v_state);
end;
$$;

revoke all on function public.promote_hub_release(
  text, text, text, text, text, boolean, text
) from public, anon, authenticated, service_role, exped_hub_release_stage;
grant execute on function public.promote_hub_release(
  text, text, text, text, text, boolean, text
) to exped_hub_release_promote;

create or replace function private.hub_release_mark_copy(
  p_name text,
  p_user_metadata jsonb
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_subject uuid := private.hub_release_subject('exped_hub_release_promote');
  v_rows integer;
begin
  if p_name <> 'manifest.json'
    or not storage.allow_only_operation('object.copy')
  then
    return false;
  end if;

  -- Esta escrita ocorre dentro da mesma transacao da Storage API. Se o copy
  -- falhar, a prova tambem sofre rollback; uma chamada RPC comum nao consegue
  -- produzi-la porque allow_only_operation exige o contexto interno do Storage.
  update private.hub_release_promotion_state
  set
    pending_copy_promotion_id = pending_promotion_id,
    pending_copy_observed_at = pg_catalog.clock_timestamp()
  where singleton
    and pending_promotion_id is not null
    and pending_subject = v_subject
    and pending_expires_at > pg_catalog.clock_timestamp()
    and p_user_metadata = pg_catalog.jsonb_build_object(
      'expedRelease', pg_catalog.jsonb_build_object(
        'schemaVersion', 1,
        'kind', 'hub-release-manifest',
        'version', pending_version,
        'platform', 'win32',
        'sourceSha', pending_source_sha,
        'artifactSha256', pending_artifact_sha256,
        'manifestSha256', pending_manifest_sha256,
        'manifest', pending_manifest
      )
    );
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

revoke all on function private.hub_release_mark_copy(text, jsonb) from public;
grant execute on function private.hub_release_mark_copy(text, jsonb)
  to exped_hub_release_promote;

drop function if exists public.complete_hub_release_promotion(uuid, text, text, text);

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

create or replace function private.hub_release_copy_authorized(p_name text)
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
      and s.pending_subject = auth.uid()
      and s.pending_expires_at > pg_catalog.clock_timestamp()
      and p_name in (s.pending_source_name, 'manifest.json')
  )
$$;

revoke all on function private.hub_release_copy_authorized(text) from public;
grant execute on function private.hub_release_copy_authorized(text)
  to exped_hub_release_promote;

drop policy if exists "hub_release_stage_insert" on storage.objects;
drop policy if exists "hub_release_stage_read" on storage.objects;
drop policy if exists "hub_release_promote_read" on storage.objects;
drop policy if exists "hub_release_promote_insert_manifest" on storage.objects;
drop policy if exists "hub_release_promote_update_manifest" on storage.objects;

create policy "hub_release_stage_insert"
on storage.objects
for insert
to exped_hub_release_stage
with check (
  bucket_id = 'hub-releases'
  and name ~ '^windows/[0-9]+(\.[0-9]+){0,2}\.(zip|json|manifest\.json|rollback-manifest\.json)$'
);

create policy "hub_release_stage_read"
on storage.objects
for select
to exped_hub_release_stage
using (
  bucket_id = 'hub-releases'
  and name ~ '^windows/[0-9]+(\.[0-9]+){0,2}\.(zip|json|manifest\.json|rollback-manifest\.json)$'
);

create policy "hub_release_promote_read"
on storage.objects
for select
to exped_hub_release_promote
using (
  bucket_id = 'hub-releases'
  and (
    (
      storage.allow_only_operation('object.copy')
      and private.hub_release_copy_authorized(name)
    )
    or (
      not storage.allow_only_operation('object.copy')
      and (
        name ~ '^windows/[0-9]+(\.[0-9]+){0,2}\.(zip|json|manifest\.json|rollback-manifest\.json)$'
        or (
          name = 'manifest.json'
          and private.hub_release_copy_authorized(name)
        )
      )
    )
  )
);

create policy "hub_release_promote_insert_manifest"
on storage.objects
for insert
to exped_hub_release_promote
with check (
  bucket_id = 'hub-releases'
  and name = 'manifest.json'
  and storage.allow_only_operation('object.copy')
  and private.hub_release_copy_authorized(name)
  and private.hub_release_mark_copy(name, user_metadata)
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
  and private.hub_release_mark_copy(name, user_metadata)
);
