import { createHash, createHmac, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';

const apiUrl = process.env.SUPABASE_LOCAL_API_URL;
const dbUrl = process.env.SUPABASE_LOCAL_DB_URL;
const anonKey = process.env.SUPABASE_LOCAL_ANON_KEY;
const jwtSecret = process.env.SUPABASE_LOCAL_JWT_SECRET;

if (!apiUrl || !dbUrl || !anonKey || !jwtSecret) {
  throw new Error('ambiente Supabase local incompleto');
}

const stageSubject = '10000000-0000-4000-8000-000000000001';
const promotionSubject = '20000000-0000-4000-8000-000000000002';
const promotionId = randomUUID();
const version = '9.9.9';
const sourceSha = 'c'.repeat(40);
const artifactSha256 = 'a'.repeat(64);
const metadataSha256 = 'b'.repeat(64);
const sourceName = `windows/${version}.manifest.json`;
const manifest = {
  versao: version,
  url: `${apiUrl}/storage/v1/object/public/hub-releases/windows/${version}.zip`,
  sha256: artifactSha256,
};
const manifestBytes = Buffer.from(JSON.stringify(manifest));
const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
const sourceMetadata = {
  expedRelease: {
    schemaVersion: 1,
    kind: 'hub-release-manifest',
    version,
    platform: 'win32',
    sourceSha,
    artifactSha256,
    manifestSha256,
    manifest,
  },
};
const canonicalMetadata = {
  expedRelease: {
    ...sourceMetadata.expedRelease,
    promotionId,
  },
};
const copyPauseLockKey = 903035;

function base64url(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function token(role, subject) {
  const header = base64url({ alg: 'HS256', typ: 'JWT' });
  const payload = base64url({
    aud: 'authenticated',
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    iss: 'supabase-demo',
    role,
    sub: subject,
  });
  const signature = createHmac('sha256', jwtSecret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function sql(query, variables = {}) {
  const args = [dbUrl, '-X', '-v', 'ON_ERROR_STOP=1', '-tA', '-P', 'pager=off'];
  for (const [name, value] of Object.entries(variables)) {
    args.push('-v', `${name}=${value}`);
  }
  return execFileSync('psql', args, {
    encoding: 'utf8',
    input: `${query}\n`,
  }).trim();
}

async function api(path, accessToken, init = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      apikey: anonKey,
      authorization: `Bearer ${accessToken}`,
      ...(init.headers || {}),
    },
  });
  const body = await response.text();
  return { response, body };
}

function expectOk(result, label) {
  if (!result.response.ok) {
    throw new Error(`${label} falhou HTTP ${result.response.status}: ${result.body}`);
  }
}

function readMaterializedCopy() {
  return JSON.parse(sql(
    `select pg_catalog.row_to_json(result)::text
       from (
         select
           src.metadata ->> 'eTag' = dst.metadata ->> 'eTag' as etag_matches,
           (src.metadata ->> 'size')::bigint =
             (dst.metadata ->> 'size')::bigint as size_matches,
           dst.version = proof.object_version as version_matches,
           dst.metadata ->> 'eTag' = proof.object_etag as proof_etag_matches,
           (dst.metadata ->> 'size')::bigint = proof.object_size as proof_size_matches,
           dst.owner_id = :'promotion_subject' as owner_matches,
           dst.user_metadata = :'canonical_metadata'::jsonb as user_metadata_matches,
           dst.version as destination_version
         from storage.objects src
         join storage.objects dst
           on dst.bucket_id = 'hub-releases' and dst.name = 'manifest.json'
         join private.hub_release_copy_proofs proof
           on proof.promotion_id = :'promotion_id'::uuid
         where src.bucket_id = 'hub-releases' and src.name = :'source_name'
       ) result`,
    {
      promotion_subject: promotionSubject,
      canonical_metadata: JSON.stringify(canonicalMetadata),
      promotion_id: promotionId,
      source_name: sourceName,
    },
  ));
}

function assertMaterializedCopy(materialized, label) {
  if (
    !materialized.etag_matches
    || !materialized.size_matches
    || !materialized.version_matches
    || !materialized.proof_etag_matches
    || !materialized.proof_size_matches
    || !materialized.owner_matches
    || !materialized.user_metadata_matches
  ) {
    throw new Error(`${label} divergiu da prova materializada`);
  }
}

function installCopyPause() {
  sql(
    `create table private.hub_release_e2e_copy_pause (
       promotion_id uuid primary key,
       lock_key bigint not null
     );
     revoke all on table private.hub_release_e2e_copy_pause from public;

     create function private.hub_release_e2e_pause_copy()
     returns trigger
     language plpgsql
     security definer
     set search_path = ''
     as $$
     declare
       v_lock_key bigint;
     begin
       if new.version is distinct from '1'
         and storage.allow_only_operation('object.copy')
       then
         select p.lock_key into v_lock_key
         from private.hub_release_e2e_copy_pause p
         where p.promotion_id::text =
           new.user_metadata #>> '{expedRelease,promotionId}';
         if found then
           perform pg_catalog.pg_advisory_xact_lock(v_lock_key);
         end if;
       end if;
       return new;
     end;
     $$;
     revoke all on function private.hub_release_e2e_pause_copy() from public;

     create trigger aaa_hub_release_e2e_pause_copy
     before insert or update on storage.objects
     for each row
     when (
       new.bucket_id = 'hub-releases'
       and new.name = 'manifest.json'
     )
     execute function private.hub_release_e2e_pause_copy();

     insert into private.hub_release_e2e_copy_pause (promotion_id, lock_key)
     values (:'promotion_id'::uuid, :'lock_key'::bigint);`,
    {
      promotion_id: promotionId,
      lock_key: copyPauseLockKey,
    },
  );
}

async function waitForAdvisoryLock(granted) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const count = Number(sql(
      `select count(*)
         from pg_catalog.pg_locks
        where locktype = 'advisory'
          and classid = 0
          and objid = :'lock_key'::oid
          and granted = :'granted'::boolean`,
      {
        lock_key: copyPauseLockKey,
        granted: String(granted),
      },
    ));
    if (count > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`lock advisory ${granted ? 'titular' : 'bloqueado'} nao foi observado`);
}

async function startAdvisoryLockHolder() {
  const holder = spawn(
    'psql',
    [
      dbUrl,
      '-X',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      `select pg_advisory_lock(${copyPauseLockKey}); select pg_sleep(60);`,
    ],
    { stdio: 'ignore' },
  );
  holder.on('error', () => {});
  await waitForAdvisoryLock(true);
  return async () => {
    if (holder.exitCode === null && holder.signalCode === null) {
      holder.kill('SIGTERM');
      await once(holder, 'exit');
    }
  };
}

function resetFixture() {
  sql(
    `begin;
     drop trigger if exists aaa_hub_release_e2e_pause_copy on storage.objects;
     drop function if exists private.hub_release_e2e_pause_copy();
     drop table if exists private.hub_release_e2e_copy_pause;
     set local storage.allow_delete_query = 'true';
     delete from storage.objects
      where bucket_id = 'hub-releases'
        and name in ('manifest.json', :'source_name');
     delete from private.hub_release_copy_proofs;
     update private.hub_release_promotion_state
        set initialized = false,
            current_promotion_id = null,
            current_version = null,
            current_source_sha = null,
            current_artifact_sha256 = null,
            current_metadata_sha256 = null,
            current_manifest = null,
            current_manifest_sha256 = null,
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
      where singleton;
     commit;`,
    { source_name: sourceName },
  );
}

async function run() {
  const stageToken = token('exped_hub_release_stage', stageSubject);
  const promotionToken = token('exped_hub_release_promote', promotionSubject);

  sql(
    `insert into storage.buckets (id, name, public)
     values ('hub-releases', 'hub-releases', true)
     on conflict (id) do update set public = excluded.public`,
  );

  const upload = await api(
    `/storage/v1/object/hub-releases/${sourceName}`,
    stageToken,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-metadata': Buffer.from(JSON.stringify(sourceMetadata)).toString('base64'),
      },
      body: manifestBytes,
    },
  );
  expectOk(upload, 'upload do candidato');

  sql(
    `update private.hub_release_promotion_state
       set initialized = true,
           current_promotion_id = null,
           current_version = '0.3.98',
           current_source_sha = null,
           current_artifact_sha256 = null,
           current_metadata_sha256 = null,
           current_manifest = :'current_manifest'::jsonb,
           current_manifest_sha256 = :'current_manifest_sha256',
           pending_promotion_id = :'promotion_id'::uuid,
           pending_version = :'version',
           pending_source_sha = :'source_sha',
           pending_artifact_sha256 = :'artifact_sha256',
           pending_metadata_sha256 = :'metadata_sha256',
           pending_manifest = :'manifest'::jsonb,
           pending_manifest_sha256 = :'manifest_sha256',
           pending_source_name = :'source_name',
           pending_subject = :'promotion_subject'::uuid,
           pending_requested_at = clock_timestamp() - interval '1 second',
           pending_expires_at = clock_timestamp() + interval '10 minutes',
           pending_copy_promotion_id = null,
           pending_copy_observed_at = null
     where singleton`,
    {
      current_manifest: JSON.stringify({
        versao: '0.3.98',
        url: `${apiUrl}/legacy.zip`,
        sha256: 'd'.repeat(64),
      }),
      current_manifest_sha256: 'e'.repeat(64),
      promotion_id: promotionId,
      version,
      source_sha: sourceSha,
      artifact_sha256: artifactSha256,
      metadata_sha256: metadataSha256,
      manifest: JSON.stringify(manifest),
      manifest_sha256: manifestSha256,
      source_name: sourceName,
      promotion_subject: promotionSubject,
    },
  );

  const copyRequest = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-metadata': Buffer.from(JSON.stringify(canonicalMetadata)).toString('base64'),
      'x-upsert': 'true',
    },
    body: JSON.stringify({
      bucketId: 'hub-releases',
      sourceKey: sourceName,
      destinationKey: 'manifest.json',
      copyMetadata: false,
    }),
  };
  const insertedCopy = await api('/storage/v1/object/copy', promotionToken, copyRequest);
  expectOk(insertedCopy, 'copy INSERT real da Storage API');
  const inserted = readMaterializedCopy();
  assertMaterializedCopy(inserted, 'copy INSERT');

  const overwrittenCopy = await api('/storage/v1/object/copy', promotionToken, copyRequest);
  expectOk(overwrittenCopy, 'copy UPDATE real da Storage API');
  const overwritten = readMaterializedCopy();
  assertMaterializedCopy(overwritten, 'copy UPDATE');
  if (overwritten.destination_version === inserted.destination_version) {
    throw new Error('copy UPDATE nao materializou uma nova versao do objeto');
  }

  const attest = await api(
    '/rest/v1/rpc/attest_hub_release_manifest_copy',
    promotionToken,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ p_promotion_id: promotionId }),
    },
  );
  expectOk(attest, 'atestado RPC');
  const attestation = JSON.parse(attest.body);
  if (attestation.objectVersion !== overwritten.destination_version) {
    throw new Error('RPC retornou versao de objeto divergente');
  }

  installCopyPause();
  const releaseAdvisoryLock = await startAdvisoryLockHolder();
  const delayedCopyPromise = api('/storage/v1/object/copy', promotionToken, copyRequest);
  try {
    await waitForAdvisoryLock(false);
    const complete = await api(
      '/rest/v1/rpc/complete_hub_release_promotion',
      promotionToken,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ p_promotion_id: promotionId }),
      },
    );
    expectOk(complete, 'conclusao RPC durante copy atrasado');
  } finally {
    await releaseAdvisoryLock();
  }

  const delayedCopy = await delayedCopyPromise;
  if (delayedCopy.response.ok) {
    throw new Error('copy que passou RLS foi aceito depois da conclusao');
  }

  const state = JSON.parse(sql(
    `select pg_catalog.row_to_json(result)::text
       from (
         select current_version,
                pending_promotion_id is null as pending_cleared,
                (select count(*) from private.hub_release_copy_proofs) as proof_count
           from private.hub_release_promotion_state
          where singleton
       ) result`,
  ));
  if (
    state.current_version !== version
    || !state.pending_cleared
    || Number(state.proof_count) !== 0
  ) {
    throw new Error('estado final da promocao ficou inconsistente');
  }

  const finalVersion = sql(
    `select version from storage.objects
      where bucket_id = 'hub-releases' and name = 'manifest.json'`,
  );
  if (finalVersion !== overwritten.destination_version) {
    throw new Error('copy atrasado alterou o objeto canonico');
  }
}

try {
  await run();
  console.log('Storage copy E2E: ok');
} finally {
  resetFixture();
}
