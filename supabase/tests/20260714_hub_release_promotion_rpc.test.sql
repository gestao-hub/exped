begin;

select plan(71);

select has_function(
  'public',
  'register_hub_release_artifact',
  array['text', 'jsonb'],
  'RPC de registro imutavel existe'
);

select has_function(
  'public',
  'initialize_hub_release_promotion',
  array['text', 'text', 'text'],
  'RPC inicializa estado a partir do manifest canonico observado'
);

select has_function(
  'public',
  'promote_hub_release',
  array['text', 'text', 'text', 'text', 'text', 'boolean', 'text'],
  'RPC de promocao exige identidade completa do artifact'
);

select has_function(
  'public',
  'complete_hub_release_promotion',
  array['uuid'],
  'RPC de conclusao explicita existe'
);

select has_function(
  'public',
  'attest_hub_release_manifest_copy',
  array['uuid'],
  'RPC atesta o objeto materializado depois do copy'
);

select hasnt_function(
  'private',
  'hub_release_mark_copy',
  array['text', 'jsonb'],
  'prova nao depende de efeito colateral descartado pela checagem RLS'
);

select has_table(
  'private',
  'hub_release_copy_proofs',
  'prova persistente guarda a versao materializada do objeto'
);

select has_function(
  'private',
  'hub_release_guard_manifest_write',
  array[]::text[],
  'trigger valida a gravacao real feita pelo Storage'
);

select is(
  (
    select p.prosecdef
    from pg_catalog.pg_proc p
    where p.oid = to_regprocedure(
      'public.promote_hub_release(text,text,text,text,text,boolean,text)'
    )
  ),
  true,
  'RPC usa SECURITY DEFINER'
);

select is(
  (
    select p.proconfig
    from pg_catalog.pg_proc p
    where p.oid = to_regprocedure(
      'public.promote_hub_release(text,text,text,text,text,boolean,text)'
    )
  ),
  array['search_path=""']::text[],
  'RPC fixa search_path vazio'
);

select is(
  (
    select p.prosecdef
    from pg_catalog.pg_proc p
    where p.oid = to_regprocedure(
      'public.attest_hub_release_manifest_copy(uuid)'
    )
  ),
  true,
  'RPC de atestacao usa SECURITY DEFINER'
);

select is(
  (
    select p.proconfig
    from pg_catalog.pg_proc p
    where p.oid = to_regprocedure(
      'public.attest_hub_release_manifest_copy(uuid)'
    )
  ),
  array['search_path=""']::text[],
  'RPC de atestacao fixa search_path vazio'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.promote_hub_release(text,text,text,text,text,boolean,text)',
    'execute'
  ),
  'anon nao executa promocao'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.promote_hub_release(text,text,text,text,text,boolean,text)',
    'execute'
  ),
  'authenticated nao executa promocao'
);

select ok(
  not has_function_privilege(
    'exped_hub_release_stage',
    'public.promote_hub_release(text,text,text,text,text,boolean,text)',
    'execute'
  ),
  'stage nao executa promocao'
);

select ok(
  not has_function_privilege(
    'service_role',
    'public.promote_hub_release(text,text,text,text,text,boolean,text)',
    'execute'
  ),
  'service_role nao substitui a credencial dedicada'
);

select ok(
  has_function_privilege(
    'exped_hub_release_promote',
    'public.promote_hub_release(text,text,text,text,text,boolean,text)',
    'execute'
  ),
  'role dedicada executa promocao vinculada'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.attest_hub_release_manifest_copy(uuid)',
    'execute'
  ),
  'anon nao atesta copia'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.attest_hub_release_manifest_copy(uuid)',
    'execute'
  ),
  'authenticated nao atesta copia'
);

select ok(
  not has_function_privilege(
    'exped_hub_release_stage',
    'public.attest_hub_release_manifest_copy(uuid)',
    'execute'
  ),
  'stage nao atesta copia'
);

select ok(
  not has_function_privilege(
    'service_role',
    'public.attest_hub_release_manifest_copy(uuid)',
    'execute'
  ),
  'service_role nao substitui a credencial de atestacao'
);

select ok(
  has_function_privilege(
    'exped_hub_release_promote',
    'public.attest_hub_release_manifest_copy(uuid)',
    'execute'
  ),
  'role dedicada atesta a copia materializada'
);

select ok(
  (
    select not initialized and current_version is null
    from private.hub_release_promotion_state
    where singleton
  ),
  'migration inicia fechada sem supor versao legada'
);

select is(
  (
    select count(*)::integer
    from pg_catalog.pg_trigger t
    where t.tgrelid = 'storage.objects'::regclass
      and not t.tgisinternal
      and t.tgname = 'hub_release_guard_manifest_write'
  ),
  1,
  'gravacao real do manifest e guardada no mesmo commit do Storage'
);

select is(
  (
    select count(*)::integer
    from pg_catalog.pg_policy p
    where p.polrelid = 'storage.objects'::regclass
      and p.polname like 'hub_release_promote_%'
      and (
        coalesce(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '')
        || coalesce(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '')
      ) like '%allow_only_operation%object.copy%'
      and (
        coalesce(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '')
        || coalesce(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '')
      ) not like '%storage.operation%'
  ),
  3,
  'policies de copy usam somente o helper publico de operacao'
);

select is(
  (
    select count(*)::integer
    from pg_catalog.pg_policy p
    where p.polrelid = 'storage.objects'::regclass
      and p.polname in (
        'hub_release_promote_insert_manifest',
        'hub_release_promote_update_manifest'
      )
      and pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid)
        like '%hub_release_mark_copy(name, user_metadata)%'
  ),
  0,
  'policies autorizam o copy sem efeitos colaterais que o Storage descarta'
);

select is(
  (
    select count(*)::integer
    from pg_catalog.pg_policy p
    where p.polrelid = 'storage.objects'::regclass
      and p.polname in (
        'hub_release_promote_insert_manifest',
        'hub_release_promote_update_manifest'
      )
      and pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid)
        like '%hub_release_manifest_write_authorized(name, owner_id, user_metadata)%'
  ),
  2,
  'insert e update exigem nonce e metadata do pending sem efeitos laterais'
);

select ok(
  (
    select
      pg_catalog.pg_get_expr(p.polqual, p.polrelid)
        like '%NOT storage.allow_only_operation(''object.copy''::text)%'
      and pg_catalog.pg_get_expr(p.polqual, p.polrelid)
        like '%storage.allow_only_operation(''object.copy''::text)%hub_release_copy_authorized(name)%'
    from pg_catalog.pg_policy p
    where p.polrelid = 'storage.objects'::regclass
      and p.polname = 'hub_release_promote_read'
  ),
  'SELECT separa info() de copy e vincula a origem da copia ao pending'
);

select is(
  (
    select count(*)::integer
    from pg_catalog.pg_policy p
    where p.polrelid = 'storage.objects'::regclass
      and p.polname in ('hub_release_stage_read', 'hub_release_promote_read')
      and p.polcmd = 'r'
  ),
  2,
  'retries consultam metadata por policies SELECT explicitas e suportadas'
);

select ok(
  has_table_privilege(
    'exped_hub_release_stage',
    'storage.objects',
    'select'
  ),
  'stage possui somente o grant de leitura necessario para Storage info()'
);

select is(
  (
    select count(*)::integer
    from pg_catalog.pg_proc p
    where p.pronamespace in ('private'::regnamespace, 'public'::regnamespace)
      and p.proname like '%hub_release%'
      and pg_catalog.pg_get_functiondef(p.oid)
        ~* '(from|join)[[:space:]]+storage[.]objects'
  ),
  2,
  'somente o guard e a assercao pos-copy leem objetos do Storage'
);

create temporary table release_fixture (
  version text primary key,
  source_sha text not null,
  artifact_sha256 text not null,
  metadata_sha256 text not null,
  release_manifest_sha256 text not null,
  rollback_manifest_sha256 text not null,
  approval jsonb not null
) on commit drop;

with source as (
  select
    values_.version,
    values_.source_sha,
    values_.artifact_sha256,
    '{"schema_version":1,"versao":"' || values_.version
      || '","platform":"win32","source_sha":"' || values_.source_sha
      || '","sha256":"' || values_.artifact_sha256 || '"}' as metadata_text,
    '{"versao":"' || values_.version
      || '","url":"https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/public/hub-releases/windows/'
      || values_.version || '.zip","sha256":"' || values_.artifact_sha256 || '"}'
      as release_manifest_text,
    '{"versao":"' || values_.version
      || '","url":"https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/public/hub-releases/windows/'
      || values_.version || '.zip","sha256":"' || values_.artifact_sha256
      || '","allowDowngrade":true,"minimumHubVersion":"0.3.21"}'
      as rollback_manifest_text
  from (
    values
      ('0.3.21', repeat('1', 40), repeat('a', 64)),
      ('0.3.22', repeat('2', 40), repeat('b', 64)),
      ('0.3.23', repeat('3', 40), repeat('c', 64))
  ) as values_(version, source_sha, artifact_sha256)
), fixture as (
  select
    source.*,
    pg_catalog.encode(extensions.digest(metadata_text, 'sha256'), 'hex')
      as metadata_sha256,
    pg_catalog.encode(extensions.digest(release_manifest_text, 'sha256'), 'hex')
      as release_manifest_sha256,
    pg_catalog.encode(extensions.digest(rollback_manifest_text, 'sha256'), 'hex')
      as rollback_manifest_sha256
  from source
)
insert into release_fixture (
  version,
  source_sha,
  artifact_sha256,
  metadata_sha256,
  release_manifest_sha256,
  rollback_manifest_sha256,
  approval
)
select
  version,
  source_sha,
  artifact_sha256,
  metadata_sha256,
  release_manifest_sha256,
  rollback_manifest_sha256,
  pg_catalog.jsonb_build_object(
    'schema_version', 1,
    'project_ref', 'abcdefghijklmnopqrst',
    'version', version,
    'source_sha', source_sha,
    'artifact', pg_catalog.jsonb_build_object(
      'path', pg_catalog.format('windows/%s.zip', version),
      'sha256', artifact_sha256
    ),
    'metadata', pg_catalog.jsonb_build_object(
      'path', pg_catalog.format('windows/%s.json', version),
      'sha256', metadata_sha256,
      'body', metadata_text::jsonb
    ),
    'manifests', pg_catalog.jsonb_build_object(
      'release', pg_catalog.jsonb_build_object(
        'path', pg_catalog.format('windows/%s.manifest.json', version),
        'sha256', release_manifest_sha256,
        'body', release_manifest_text::jsonb
      ),
      'rollback', pg_catalog.jsonb_build_object(
        'path', pg_catalog.format('windows/%s.rollback-manifest.json', version),
        'sha256', rollback_manifest_sha256,
        'body', rollback_manifest_text::jsonb
      )
    )
  )
from fixture;

grant select on release_fixture
  to exped_hub_release_stage, exped_hub_release_promote;
-- Schema-only test databases can omit pgTAP's default PUBLIC grants. Grant
-- only extension-owned pgTAP helpers; these changes roll back with the test.
grant usage on schema extensions
  to exped_hub_release_stage, exped_hub_release_promote;

select set_config(
  'request.jwt.claims',
  '{"role":"exped_hub_release_stage","sub":"00000000-0000-0000-0000-000000000011"}',
  true
);
set local role exped_hub_release_stage;

select lives_ok(
  $$
    select public.register_hub_release_artifact(
      'abcdefghijklmnopqrst',
      (select approval from release_fixture where version = '0.3.21')
    )
  $$,
  'stage registra artifact 0.3.21 com identidade completa'
);

select lives_ok(
  $$
    select public.register_hub_release_artifact(
      'abcdefghijklmnopqrst',
      (select approval from release_fixture where version = '0.3.21')
    )
  $$,
  'retry identico do registro e idempotente'
);

select throws_ok(
  $$
    select public.register_hub_release_artifact(
      'zzzzzzzzzzzzzzzzzzzz',
      (select approval from release_fixture where version = '0.3.21')
    )
  $$,
  '22023',
  'identidade do approval de release invalida',
  'retry nao reutiliza approval registrado em outro project_ref'
);

select throws_ok(
  $$
    select public.register_hub_release_artifact(
      'abcdefghijklmnopqrst',
      jsonb_set(
        (select approval from release_fixture where version = '0.3.21'),
        '{source_sha}',
        to_jsonb(repeat('9', 40))
      )
    )
  $$,
  '22023',
  'release 0.3.21 ja foi registrada com identidade diferente',
  'objeto versionado inconsistente falha fechado'
);

select lives_ok(
  $$
    select public.register_hub_release_artifact(
      'abcdefghijklmnopqrst',
      (select approval from release_fixture where version = '0.3.23')
    )
  $$,
  'stage registra artifact concorrente futuro'
);

select lives_ok(
  $$
    select public.register_hub_release_artifact(
      'abcdefghijklmnopqrst',
      (select approval from release_fixture where version = '0.3.22')
    )
  $$,
  'stage registra artifact da mesma versao legada para testar imutabilidade'
);

reset role;
select set_config(
  'request.jwt.claims',
  '{"role":"exped_hub_release_promote","sub":"00000000-0000-0000-0000-000000000021"}',
  true
);
set local role exped_hub_release_promote;

select throws_ok(
  $$
    select public.promote_hub_release(
      'abcdefghijklmnopqrst',
      f.version,
      f.source_sha,
      f.artifact_sha256,
      f.metadata_sha256,
      false,
      null
    )
    from release_fixture f
    where f.version = '0.3.21'
  $$,
  '55000',
  'estado inicial de promocao desconhecido; observe o manifest canonico pela API',
  'estado desconhecido bloqueia promocao sem fallback de versao'
);

select lives_ok(
  $$
    select public.initialize_hub_release_promotion(
      'abcdefghijklmnopqrst',
      '{"versao":"0.3.22","url":"https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/public/hub-releases/0.3.22.zip","sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}',
      pg_catalog.encode(
        extensions.digest(
          '{"versao":"0.3.22","url":"https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/public/hub-releases/0.3.22.zip","sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}',
          'sha256'
        ),
        'hex'
      )
    )
  $$,
  'manifest legado sem user_metadata inicializa por bytes observados'
);

reset role;
select is(
  (
    select current_version
    from private.hub_release_promotion_state
    where singleton
  ),
  '0.3.22',
  'versao inicial vem do manifest legado real'
);

select set_config(
  'request.jwt.claims',
  '{"role":"exped_hub_release_promote","sub":"00000000-0000-0000-0000-000000000021"}',
  true
);
set local role exped_hub_release_promote;

select throws_ok(
  $$
    select public.promote_hub_release(
      'abcdefghijklmnopqrst',
      f.version,
      f.source_sha,
      f.artifact_sha256,
      f.metadata_sha256,
      false,
      null
    )
    from release_fixture f
    where f.version = '0.3.22'
  $$,
  '22023',
  'versao atual legada possui identidade imutavel desconhecida; publique versao superior',
  'mesma versao legada nao pode substituir bytes sem identidade de origem'
);

select throws_ok(
  $$
    select public.promote_hub_release(
      'zzzzzzzzzzzzzzzzzzzz',
      f.version,
      f.source_sha,
      f.artifact_sha256,
      f.metadata_sha256,
      false,
      null
    )
    from release_fixture f
    where f.version = '0.3.21'
  $$,
  '22023',
  'artifact aprovado nao corresponde ao release registrado',
  'promocao vincula a identidade ao project_ref registrado'
);

select throws_ok(
  $$
    select public.promote_hub_release(
      'abcdefghijklmnopqrst',
      f.version,
      repeat('9', 40),
      f.artifact_sha256,
      f.metadata_sha256,
      false,
      null
    )
    from release_fixture f
    where f.version = '0.3.21'
  $$,
  '22023',
  'artifact aprovado nao corresponde ao release registrado',
  'promocao nao aceita somente a versao'
);

select throws_ok(
  $$
    select public.promote_hub_release(
      'abcdefghijklmnopqrst',
      f.version,
      f.source_sha,
      f.artifact_sha256,
      f.metadata_sha256,
      false,
      null
    )
    from release_fixture f
    where f.version = '0.3.21'
  $$,
  '22023',
  'versao 0.3.21 e menor que manifest atual 0.3.22; use --allow-downgrade',
  'downgrade real e recusado sem flag'
);

select throws_ok(
  $$
    select public.promote_hub_release(
      'abcdefghijklmnopqrst',
      f.version,
      f.source_sha,
      f.artifact_sha256,
      f.metadata_sha256,
      true,
      '0.3.20'
    )
    from release_fixture f
    where f.version = '0.3.21'
  $$,
  '22023',
  'downgrade exige confirmacao exata do ExpedSetup/Hub 0.3.21',
  'downgrade exige Hub compativel'
);

create temporary table promotion_result (
  label text primary key,
  result jsonb not null
) on commit drop;
grant select, insert on promotion_result to exped_hub_release_promote;

insert into promotion_result (label, result)
select
  'first',
  public.promote_hub_release(
    'abcdefghijklmnopqrst',
    f.version,
    f.source_sha,
    f.artifact_sha256,
    f.metadata_sha256,
    true,
    '0.3.21'
  )
from release_fixture f
where f.version = '0.3.21';

select is(
  (select result ->> 'requiresCopy' from promotion_result where label = 'first'),
  'true',
  'RPC reserva rollback aprovado para copia'
);

select is(
  (
    select public.promote_hub_release(
      'abcdefghijklmnopqrst',
      f.version,
      f.source_sha,
      f.artifact_sha256,
      f.metadata_sha256,
      true,
      '0.3.21'
    ) ->> 'promotionId'
    from release_fixture f
    where f.version = '0.3.21'
  ),
  (select result ->> 'promotionId' from promotion_result where label = 'first'),
  'retry do mesmo subject reutiliza a reserva'
);

reset role;
select set_config(
  'request.jwt.claims',
  '{"role":"exped_hub_release_promote","sub":"00000000-0000-0000-0000-000000000022"}',
  true
);
set local role exped_hub_release_promote;

select throws_ok(
  $$
    select public.promote_hub_release(
      'abcdefghijklmnopqrst',
      f.version,
      f.source_sha,
      f.artifact_sha256,
      f.metadata_sha256,
      true,
      '0.3.21'
    )
    from release_fixture f
    where f.version = '0.3.21'
  $$,
  '55000',
  'promocao 0.3.21 esta reservada por outra credencial ate expirar',
  'rotacao de subject nao sequestra pending ainda valido'
);

select throws_ok(
  $$
    select public.promote_hub_release(
      'abcdefghijklmnopqrst',
      f.version,
      f.source_sha,
      f.artifact_sha256,
      f.metadata_sha256,
      false,
      null
    )
    from release_fixture f
    where f.version = '0.3.23'
  $$,
  '55000',
  'promocao 0.3.21 ja esta em andamento',
  'pending serializa artifacts concorrentes'
);

reset role;
update private.hub_release_promotion_state
set
  pending_requested_at = pg_catalog.clock_timestamp() - interval '11 minutes',
  pending_expires_at = pg_catalog.clock_timestamp() - interval '1 minute',
  pending_copy_promotion_id = pending_promotion_id,
  pending_copy_observed_at = pg_catalog.clock_timestamp() - interval '2 minutes'
where singleton;

select set_config(
  'request.jwt.claims',
  '{"role":"exped_hub_release_promote","sub":"00000000-0000-0000-0000-000000000022"}',
  true
);
set local role exped_hub_release_promote;

select throws_ok(
  $$
    select public.promote_hub_release(
      'abcdefghijklmnopqrst',
      f.version,
      f.source_sha,
      f.artifact_sha256,
      f.metadata_sha256,
      false,
      null
    )
    from release_fixture f
    where f.version = '0.3.23'
  $$,
  '55000',
  'promocao copiada aguarda recovery da mesma identidade',
  'pending copiado e expirado bloqueia qualquer identidade concorrente'
);

insert into promotion_result (label, result)
select
  'recovered',
  public.promote_hub_release(
    'abcdefghijklmnopqrst',
    f.version,
    f.source_sha,
    f.artifact_sha256,
    f.metadata_sha256,
    true,
    '0.3.21'
  )
from release_fixture f
where f.version = '0.3.21';

select isnt(
  (select result ->> 'promotionId' from promotion_result where label = 'recovered'),
  (select result ->> 'promotionId' from promotion_result where label = 'first'),
  'pending expirado permite recovery com novo subject e novo id'
);

select throws_ok(
  $$
    select public.complete_hub_release_promotion(
      (select (result ->> 'promotionId')::uuid from promotion_result where label = 'first')
    )
  $$,
  '55000',
  'promotion_id nao corresponde a reserva ativa',
  'conclusao atrasada do pending abandonado e recusada'
);

select throws_ok(
  $$
    select public.complete_hub_release_promotion(
      (select (result ->> 'promotionId')::uuid from promotion_result where label = 'recovered')
    )
  $$,
  '55000',
  'Storage API ainda nao comprovou a copia canonica desta promocao',
  'caller nao conclui pending apenas repetindo a identidade reservada'
);

reset role;
insert into storage.buckets (id, name, public)
values ('hub-releases', 'hub-releases', true)
on conflict (id) do nothing;

insert into storage.objects (
  bucket_id,
  name,
  owner_id,
  metadata,
  user_metadata,
  version,
  updated_at
)
select
  'hub-releases',
  pending_source_name,
  pending_subject::text,
  pg_catalog.jsonb_build_object(
    'eTag', '"candidate-recovered"',
    'size', 201,
    'mimetype', 'application/json'
  ),
  pg_catalog.jsonb_build_object(
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
  ),
  'candidate-recovered',
  pg_catalog.clock_timestamp()
from private.hub_release_promotion_state
where singleton;

-- O Storage reaplica este contexto na transacao privilegiada que materializa
-- o copy. Escritas SQL comuns permanecem fora do guard e seguem apenas a RLS.
select set_config('storage.operation', 'object.copy', true);

select throws_ok(
  $$
    insert into storage.objects (
      bucket_id, name, owner_id, metadata, user_metadata, version, updated_at
    )
    select
      'hub-releases',
      'manifest.json',
      '00000000-0000-0000-0000-000000000099',
      src.metadata,
      pg_catalog.jsonb_build_object(
        'expedRelease', (src.user_metadata -> 'expedRelease')
          || pg_catalog.jsonb_build_object('promotionId', s.pending_promotion_id)
      ),
      'wrong-owner',
      pg_catalog.clock_timestamp()
    from private.hub_release_promotion_state s
    join storage.objects src
      on src.bucket_id = 'hub-releases'
     and src.name = s.pending_source_name
    where s.singleton
  $$,
  '55000',
  'manifest canonico nao pertence ao subject da reserva',
  'owner divergente nao materializa o manifest canonico'
);

select throws_ok(
  $$
    insert into storage.objects (
      bucket_id, name, owner_id, metadata, user_metadata, version, updated_at
    )
    select
      'hub-releases',
      'manifest.json',
      s.pending_subject::text,
      pg_catalog.jsonb_set(src.metadata, '{eTag}', '"old-bytes"'::jsonb),
      pg_catalog.jsonb_build_object(
        'expedRelease', (src.user_metadata -> 'expedRelease')
          || pg_catalog.jsonb_build_object('promotionId', s.pending_promotion_id)
      ),
      'old-bytes',
      pg_catalog.clock_timestamp()
    from private.hub_release_promotion_state s
    join storage.objects src
      on src.bucket_id = 'hub-releases'
     and src.name = s.pending_source_name
    where s.singleton
  $$,
  '55000',
  'manifest canonico diverge do candidato imutavel',
  'metadata nova nao permite promover bytes antigos'
);

select lives_ok(
  $$
    insert into storage.objects (
      bucket_id, name, owner_id, metadata, user_metadata, version, updated_at
    )
    select
      'hub-releases',
      'manifest.json',
      s.pending_subject::text,
      src.metadata,
      pg_catalog.jsonb_build_object(
        'expedRelease', (src.user_metadata -> 'expedRelease')
          || pg_catalog.jsonb_build_object('promotionId', s.pending_promotion_id)
      ),
      'canonical-recovered',
      pg_catalog.clock_timestamp()
    from private.hub_release_promotion_state s
    join storage.objects src
      on src.bucket_id = 'hub-releases'
     and src.name = s.pending_source_name
    where s.singleton
  $$,
  'gravacao real do candidato imutavel persiste a prova'
);

set local role exped_hub_release_promote;

select throws_ok(
  $$
    select public.attest_hub_release_manifest_copy(
      '00000000-0000-4000-8000-000000000099'
    )
  $$,
  '55000',
  'promotion_id nao corresponde a reserva ativa',
  'atestado nao aceita promotion_id diferente'
);

select throws_ok(
  $$
    select public.attest_hub_release_manifest_copy(null::uuid)
  $$,
  '55000',
  'promotion_id nao corresponde a reserva ativa',
  'atestado exige promotion_id nao nulo e exato'
);

select lives_ok(
  $$
    select public.attest_hub_release_manifest_copy(
      (select (result ->> 'promotionId')::uuid from promotion_result where label = 'recovered')
    )
  $$,
  'objeto recente com atestacao exata comprova a copia materializada'
);

select lives_ok(
  $$
    select public.attest_hub_release_manifest_copy(
      (select (result ->> 'promotionId')::uuid from promotion_result where label = 'recovered')
    )
  $$,
  'retry do atestado da mesma versao materializada e idempotente'
);

reset role;
select is(
  (
    select pending_copy_promotion_id::text
    from private.hub_release_promotion_state
    where singleton
  ),
  (select result ->> 'promotionId' from promotion_result where label = 'recovered'),
  'atestado vincula a prova ao pending exato'
);

select ok(
  (
    select pending_copy_observed_at > pending_requested_at
    from private.hub_release_promotion_state
    where singleton
  ),
  'prova persistida e estritamente posterior ao inicio da reserva'
);
set local role exped_hub_release_promote;

select throws_ok(
  $$
    select public.complete_hub_release_promotion(null::uuid)
  $$,
  '55000',
  'promotion_id nao corresponde a reserva ativa',
  'conclusao exige promotion_id nao nulo e exato'
);

select lives_ok(
  $$
    select public.complete_hub_release_promotion(
      (select (result ->> 'promotionId')::uuid from promotion_result where label = 'recovered')
    )
  $$,
  'copia verificada conclui a reserva recuperada'
);

reset role;
select throws_ok(
  $$
    update storage.objects
    set
      version = 'late-copy',
      updated_at = pg_catalog.clock_timestamp()
    where bucket_id = 'hub-releases'
      and name = 'manifest.json'
  $$,
  '55000',
  'nenhuma promocao ativa autoriza manifest canonico',
  'copy materializado depois do complete e recusado pelo trigger'
);

select is(
  (select current_version from private.hub_release_promotion_state where singleton),
  '0.3.21',
  'downgrade concluido atualiza estado corrente'
);

select ok(
  (
    select pending_promotion_id is null
      and pending_expires_at is null
      and pending_copy_promotion_id is null
      and pending_copy_observed_at is null
    from private.hub_release_promotion_state
    where singleton
  ),
  'conclusao limpa pending por completo'
);

select set_config(
  'request.jwt.claims',
  '{"role":"exped_hub_release_promote","sub":"00000000-0000-0000-0000-000000000022"}',
  true
);
set local role exped_hub_release_promote;

insert into promotion_result (label, result)
select
  'upgrade',
  public.promote_hub_release(
    'abcdefghijklmnopqrst',
    f.version,
    f.source_sha,
    f.artifact_sha256,
    f.metadata_sha256,
    false,
    null
  )
from release_fixture f
where f.version = '0.3.23';

select is(
  (select result ->> 'sourceSha' from promotion_result where label = 'upgrade'),
  repeat('3', 40),
  'directive final permanece vinculada ao source_sha aprovado'
);

reset role;
insert into storage.objects (
  bucket_id,
  name,
  owner_id,
  metadata,
  user_metadata,
  version,
  updated_at
)
select
  'hub-releases',
  s.pending_source_name,
  s.pending_subject::text,
  pg_catalog.jsonb_build_object(
    'eTag', '"candidate-upgrade"',
    'size', 201,
    'mimetype', 'application/json'
  ),
  pg_catalog.jsonb_build_object(
    'expedRelease', pg_catalog.jsonb_build_object(
      'schemaVersion', 1,
      'kind', 'hub-release-manifest',
      'version', s.pending_version,
      'platform', 'win32',
      'sourceSha', s.pending_source_sha,
      'artifactSha256', s.pending_artifact_sha256,
      'manifestSha256', s.pending_manifest_sha256,
      'manifest', s.pending_manifest
    )
  ),
  'candidate-upgrade',
  pg_catalog.clock_timestamp()
from private.hub_release_promotion_state s
where s.singleton;

update storage.objects o
set
  owner_id = s.pending_subject::text,
  metadata = src.metadata,
  updated_at = pg_catalog.clock_timestamp(),
  version = 'canonical-upgrade',
  user_metadata = pg_catalog.jsonb_build_object(
    'expedRelease', (src.user_metadata -> 'expedRelease')
      || pg_catalog.jsonb_build_object('promotionId', s.pending_promotion_id)
  )
from private.hub_release_promotion_state s
join storage.objects src
  on src.bucket_id = 'hub-releases'
 and src.name = s.pending_source_name
where s.singleton
  and o.bucket_id = 'hub-releases'
  and o.name = 'manifest.json';
set local role exped_hub_release_promote;

select lives_ok(
  $$
    select public.attest_hub_release_manifest_copy(
      (select (result ->> 'promotionId')::uuid from promotion_result where label = 'upgrade')
    )
  $$,
  'upgrade tambem exige atestado do objeto materializado'
);

select lives_ok(
  $$
    select public.complete_hub_release_promotion(
      (select (result ->> 'promotionId')::uuid from promotion_result where label = 'upgrade')
    )
  $$,
  'upgrade aprovado conclui normalmente'
);

reset role;
select is(
  (select current_version from private.hub_release_promotion_state where singleton),
  '0.3.23',
  'estado corrente avanca apos upgrade vinculado'
);

select * from finish();
rollback;
