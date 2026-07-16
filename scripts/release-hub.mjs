// Publica o app Next standalone em duas fases:
//   stage   -> envia ZIP, metadata e candidatos de manifest imutaveis.
//   promote -> RPC autoriza um candidato; Storage o copia para manifest.json.
//
// Uso (CI ou local):
//   SUPABASE_RELEASE_KEY=<sb_secret custom-role stage>
//     PROJECT_REF=<ref> node scripts/release-hub.mjs stage [versao]
//   SUPABASE_RELEASE_KEY=<sb_secret custom-role promote>
//     PROJECT_REF=<ref> node scripts/release-hub.mjs promote [versao]
//     --allow-downgrade --confirm-hub-version 0.3.21
// Downgrade do app exige ExpedSetup/Hub 0.3.21+ previamente instalado. O
// updater antigo continua recusando versoes inferiores, de forma fail-safe.

import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createClient } from '@supabase/supabase-js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ZIP_EPOCH = new Date('1980-01-01T00:00:00.000Z');
const STORAGE_BUCKET = 'hub-releases';
const WINDOWS_ARTIFACT_PREFIX = 'windows';
const WINDOWS_PLATFORM = 'win32';
const MINIMUM_DOWNGRADE_HUB_VERSION = '0.3.21';
export const STAGE_ROLE = 'exped_hub_release_stage';
export const PROMOTION_ROLE = 'exped_hub_release_promote';

export function buildManifest(
  versao,
  url,
  sha256,
  { allowDowngrade = false, minimumHubVersion } = {},
) {
  const manifest = { versao, url, sha256 };
  if (allowDowngrade === true) {
    assertDowngradeHubVersion(minimumHubVersion);
    manifest.allowDowngrade = true;
    manifest.minimumHubVersion = minimumHubVersion;
  }
  return manifest;
}

export function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function versaoValida(v) {
  return typeof v === 'string' && /^[0-9]+(\.[0-9]+){0,2}$/.test(v);
}

export function sourceShaValido(sourceSha) {
  return typeof sourceSha === 'string' && /^[a-f0-9]{40}$/.test(sourceSha);
}

function sha256Valido(sha256) {
  return typeof sha256 === 'string' && /^[a-f0-9]{64}$/.test(sha256);
}

export function projectRefValido(ref) {
  return typeof ref === 'string' && /^[a-z0-9]{20}$/.test(ref);
}

function assertProjectRef(ref) {
  if (!projectRefValido(ref)) throw new Error('PROJECT_REF invalido');
}

function versionParts(version) {
  const parts = version.split('.').map(Number);
  while (parts.length < 3) parts.push(0);
  return parts;
}

export function compareSemver(a, b) {
  if (!versaoValida(a) || !versaoValida(b)) {
    throw new Error(`comparacao semver invalida: ${a} / ${b}`);
  }
  const left = versionParts(a);
  const right = versionParts(b);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

function versionAtLeast(version, minimum) {
  return compareSemver(version, minimum) >= 0;
}

function assertDowngradeHubVersion(minimumHubVersion) {
  if (
    !versaoValida(minimumHubVersion)
    || !versionAtLeast(minimumHubVersion, MINIMUM_DOWNGRADE_HUB_VERSION)
  ) {
    throw new Error(
      `confirme ExpedSetup/Hub >= ${MINIMUM_DOWNGRADE_HUB_VERSION} com --confirm-hub-version`,
    );
  }
}

export function parseReleaseArgs(argv, packageVersion) {
  const [mode, ...args] = argv;
  if (!['stage', 'promote'].includes(mode)) throw new Error('use stage ou promote');

  let version;
  let allowDowngrade = false;
  let minimumHubVersion;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--allow-downgrade') {
      if (allowDowngrade) throw new Error('argumento repetido: --allow-downgrade');
      allowDowngrade = true;
    } else if (arg === '--confirm-hub-version') {
      if (minimumHubVersion) throw new Error('argumento repetido: --confirm-hub-version');
      minimumHubVersion = args[i + 1];
      i += 1;
      if (!minimumHubVersion) throw new Error('--confirm-hub-version exige uma versao');
    } else if (arg.startsWith('-')) {
      throw new Error(`argumento desconhecido: ${arg}`);
    } else if (version) {
      throw new Error(`argumento desconhecido: ${arg}`);
    } else {
      version = arg;
    }
  }

  version ||= packageVersion;
  if (!versaoValida(version)) throw new Error(`versao invalida: ${version}`);
  if (allowDowngrade && mode !== 'promote') {
    throw new Error('--allow-downgrade so pode ser usado em promote');
  }
  if (minimumHubVersion && !allowDowngrade) {
    throw new Error('--confirm-hub-version exige --allow-downgrade');
  }
  if (allowDowngrade) assertDowngradeHubVersion(minimumHubVersion);

  return allowDowngrade
    ? { mode, version, allowDowngrade: true, minimumHubVersion }
    : { mode, version };
}

export function publicZipUrl(ref, version) {
  assertProjectRef(ref);
  return `https://${ref}.supabase.co/storage/v1/object/public/${STORAGE_BUCKET}/${WINDOWS_ARTIFACT_PREFIX}/${version}.zip`;
}

export function publicMetadataUrl(ref, version) {
  assertProjectRef(ref);
  return `https://${ref}.supabase.co/storage/v1/object/public/${STORAGE_BUCKET}/${WINDOWS_ARTIFACT_PREFIX}/${version}.json`;
}

export function buildReleaseApproval(ref, version, sourceSha, artifactSha256) {
  assertProjectRef(ref);
  if (!versaoValida(version)) throw new Error(`versao invalida: ${version}`);
  if (!sourceShaValido(sourceSha)) throw new Error('source_sha invalido');
  if (!sha256Valido(artifactSha256)) throw new Error('SHA-256 do artefato invalido');

  const metadataBody = {
    schema_version: 1,
    versao: version,
    platform: WINDOWS_PLATFORM,
    source_sha: sourceSha,
    sha256: artifactSha256,
  };
  const releaseManifest = buildManifest(
    version,
    publicZipUrl(ref, version),
    artifactSha256,
  );
  const rollbackManifest = buildManifest(
    version,
    publicZipUrl(ref, version),
    artifactSha256,
    {
      allowDowngrade: true,
      minimumHubVersion: MINIMUM_DOWNGRADE_HUB_VERSION,
    },
  );

  return {
    schema_version: 1,
    project_ref: ref,
    version,
    source_sha: sourceSha,
    artifact: {
      path: `${WINDOWS_ARTIFACT_PREFIX}/${version}.zip`,
      sha256: artifactSha256,
    },
    metadata: {
      path: `${WINDOWS_ARTIFACT_PREFIX}/${version}.json`,
      sha256: sha256Buffer(Buffer.from(JSON.stringify(metadataBody))),
      body: metadataBody,
    },
    manifests: {
      release: {
        path: manifestCandidatePath(version),
        sha256: sha256Buffer(Buffer.from(JSON.stringify(releaseManifest))),
        body: releaseManifest,
      },
      rollback: {
        path: manifestCandidatePath(version, true),
        sha256: sha256Buffer(Buffer.from(JSON.stringify(rollbackManifest))),
        body: rollbackManifest,
      },
    },
  };
}

export function loadApprovedRelease({
  ref,
  version,
  sourceSha,
  artifactSha256,
  approvalPath,
  artifactPath,
}) {
  assertProjectRef(ref);
  if (!versaoValida(version)) throw new Error(`versao invalida: ${version}`);
  if (!sourceShaValido(sourceSha)) throw new Error('source_sha aprovado invalido');
  if (!sha256Valido(artifactSha256)) throw new Error('SHA-256 aprovado invalido');

  let approval;
  try {
    approval = JSON.parse(readFileSync(approvalPath, 'utf8'));
  } catch {
    throw new Error('approval do GitHub ausente ou invalido');
  }
  if (approval?.source_sha !== sourceSha) {
    throw new Error('source_sha aprovado nao corresponde ao approval do GitHub');
  }
  if (approval?.artifact?.sha256 !== artifactSha256) {
    throw new Error('SHA-256 aprovado nao corresponde ao approval do GitHub');
  }

  const expected = buildReleaseApproval(ref, version, sourceSha, artifactSha256);
  if (!isDeepStrictEqual(approval, expected)) {
    throw new Error('metadata do approval do GitHub nao corresponde ao artifact aprovado');
  }

  const artifact = readFileSync(artifactPath);
  if (sha256Buffer(artifact) !== artifactSha256) {
    throw new Error('SHA-256 do artifact do GitHub nao corresponde aos valores aprovados');
  }
  return { approval, artifact };
}

function manifestCandidatePath(version, allowDowngrade = false) {
  const suffix = allowDowngrade ? 'rollback-manifest.json' : 'manifest.json';
  return `${WINDOWS_ARTIFACT_PREFIX}/${version}.${suffix}`;
}

function decodeJwtPayload(accessToken) {
  if (typeof accessToken !== 'string') throw new Error('SUPABASE_ACCESS_TOKEN deve ser JWT');
  const parts = accessToken.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new Error('SUPABASE_ACCESS_TOKEN deve ser JWT');
  }
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error();
    return payload;
  } catch {
    throw new Error('SUPABASE_ACCESS_TOKEN contem payload JWT invalido');
  }
}

export function assertReleaseAccessToken(
  accessToken,
  expectedRole,
  { nowSeconds = Math.floor(Date.now() / 1000) } = {},
) {
  const claims = decodeJwtPayload(accessToken);
  if (claims.role === 'service_role') {
    throw new Error('service_role e proibida no release hub; use custom role dedicada');
  }
  if (claims.role !== expectedRole) {
    throw new Error(`SUPABASE_ACCESS_TOKEN deve conter claim role ${expectedRole}`);
  }
  if (
    typeof claims.sub !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(claims.sub)
  ) {
    throw new Error('SUPABASE_ACCESS_TOKEN deve conter claim sub UUID valida');
  }
  if (!Number.isFinite(claims.exp) || claims.exp <= nowSeconds) {
    throw new Error('SUPABASE_ACCESS_TOKEN expirado ou sem claim exp valida');
  }
  if (Number.isFinite(claims.nbf) && claims.nbf > nowSeconds) {
    throw new Error('SUPABASE_ACCESS_TOKEN ainda nao esta valido');
  }
  return claims;
}

export function assertReleaseApiKey(releaseKey) {
  if (
    typeof releaseKey !== 'string'
    || !/^sb_secret_[A-Za-z0-9_-]{20,}_[A-Za-z0-9_-]{8}$/.test(releaseKey)
  ) {
    throw new Error('SUPABASE_RELEASE_KEY deve ser uma chave sb_secret_ dedicada');
  }
  return releaseKey;
}

function assertPublicAnonKey(anonKey) {
  if (typeof anonKey !== 'string' || anonKey.length === 0) {
    throw new Error('defina SUPABASE_ANON_KEY publica');
  }
  if (anonKey.startsWith('sb_secret_')) {
    throw new Error('SUPABASE_ANON_KEY nao pode ser uma chave sb_secret_');
  }
  if (anonKey.split('.').length === 3) {
    const claims = decodeJwtPayload(anonKey);
    if (claims.role === 'service_role') {
      throw new Error('SUPABASE_ANON_KEY nao pode conter role service_role');
    }
    if (claims.role && claims.role !== 'anon') {
      throw new Error('SUPABASE_ANON_KEY JWT deve conter role anon');
    }
  }
}

function assertReleaseCredentials(credentials, expectedRole) {
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
    throw new Error('credenciais Supabase invalidas');
  }
  if (credentials.releaseKey) {
    if (credentials.anonKey || credentials.accessToken) {
      throw new Error('nao misture SUPABASE_RELEASE_KEY com credenciais JWT legadas');
    }
    return { releaseKey: assertReleaseApiKey(credentials.releaseKey) };
  }
  const { anonKey, accessToken } = credentials;
  assertPublicAnonKey(anonKey);
  assertReleaseAccessToken(accessToken, expectedRole);
  return { anonKey, accessToken };
}

function createReleaseClient(ref, credentials, expectedRole, fetchImpl) {
  assertProjectRef(ref);
  const validated = assertReleaseCredentials(credentials, expectedRole);
  if (validated.releaseKey) {
    return createClient(`https://${ref}.supabase.co`, validated.releaseKey, {
      global: { fetch: fetchImpl },
    });
  }
  return createClient(`https://${ref}.supabase.co`, validated.anonKey, {
    accessToken: async () => validated.accessToken,
    global: { fetch: fetchImpl },
  });
}

function releaseCredentialSecret(credentials) {
  return credentials.releaseKey || credentials.accessToken;
}

function releaseRequestHeaders(credentials) {
  const apiKey = credentials.releaseKey || credentials.anonKey;
  const authorization = credentials.releaseKey || credentials.accessToken;
  return {
    apikey: apiKey,
    authorization: `Bearer ${authorization}`,
  };
}

async function assertReleaseClientAccess(client, credentials, expectedRole) {
  if (!credentials.releaseKey) return;
  const { data, error } = await client.rpc('assert_hub_release_access', {
    p_expected_role: expectedRole,
  });
  if (error) {
    const detail = redactDetail(error.message, [credentials.releaseKey]);
    throw new Error(
      `credencial de release nao comprovou a role ${expectedRole}`
      + `${detail ? `: ${detail}` : ''}`,
    );
  }
  if (
    data?.role !== expectedRole
    || typeof data?.subject !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.subject)
  ) {
    throw new Error(`credencial de release retornou identidade invalida para ${expectedRole}`);
  }
}

function relativeFiles(dir, prefix = '') {
  const entries = readdirSync(path.join(dir, prefix), { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const files = [];

  for (const entry of entries) {
    const relative = prefix ? path.join(prefix, entry.name) : entry.name;
    if (relative.includes('\n') || relative.includes('\r')) {
      throw new Error(`nome de arquivo invalido no release: ${JSON.stringify(relative)}`);
    }
    if (entry.isDirectory()) files.push(...relativeFiles(dir, relative));
    else if (entry.isFile()) files.push(relative.split(path.sep).join('/'));
  }

  return files;
}

function assertReleaseBoundary(out) {
  for (const forbidden of ['agent', 'hub', 'installers', 'scripts']) {
    if (existsSync(path.join(out, forbidden))) {
      throw new Error(`pacote do app contem caminho proibido: ${forbidden}`);
    }
  }
}

function materializeInternalSymlinks(root, prefix = '') {
  const entries = readdirSync(path.join(root, prefix), { withFileTypes: true });
  for (const entry of entries) {
    const relative = prefix ? path.join(prefix, entry.name) : entry.name;
    const absolute = path.join(root, relative);
    if (entry.isDirectory()) {
      materializeInternalSymlinks(root, relative);
      continue;
    }
    if (!entry.isSymbolicLink()) continue;

    let target;
    try {
      target = realpathSync(absolute);
    } catch {
      throw new Error(`symlink quebrado ou externo proibido no pacote: ${relative}`);
    }
    const targetRelative = path.relative(root, target);
    if (targetRelative.startsWith('..') || path.isAbsolute(targetRelative)) {
      throw new Error(`symlink quebrado ou externo proibido no pacote: ${relative}`);
    }
    if (statSync(target).isDirectory()) {
      throw new Error(`symlink de diretorio proibido no pacote: ${relative}`);
    }

    rmSync(absolute, { force: true });
    cpSync(target, absolute);
  }
}

/** Monta releases/<versao>/ somente com app standalone, static, public e migrations. */
export function montarRelease(versao, { root = ROOT } = {}) {
  if (!versaoValida(versao)) throw new Error(`versao invalida: ${versao}`);

  const out = path.join(root, 'releases', versao);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  cpSync(path.join(root, '.next', 'standalone'), out, {
    recursive: true,
    verbatimSymlinks: true,
  });
  mkdirSync(path.join(out, '.next'), { recursive: true });
  cpSync(path.join(root, '.next', 'static'), path.join(out, '.next', 'static'), {
    recursive: true,
    verbatimSymlinks: true,
  });
  if (existsSync(path.join(root, 'public'))) {
    cpSync(path.join(root, 'public'), path.join(out, 'public'), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }
  cpSync(
    path.join(root, 'supabase', 'migrations'),
    path.join(out, 'supabase', 'migrations'),
    { recursive: true, verbatimSymlinks: true },
  );

  materializeInternalSymlinks(out);
  assertReleaseBoundary(out);
  return out;
}

function createDeterministicZip(releaseDir, zipPath) {
  const files = relativeFiles(releaseDir);
  if (files.length === 0) throw new Error('pacote do app esta vazio');

  for (const relative of files) {
    utimesSync(path.join(releaseDir, relative), ZIP_EPOCH, ZIP_EPOCH);
  }

  rmSync(zipPath, { force: true });
  const portableZipPath = path.relative(releaseDir, zipPath).split(path.sep).join('/');
  execFileSync('zip', ['-X', '-q', portableZipPath, '-@'], {
    cwd: releaseDir,
    input: `${files.join('\n')}\n`,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
}

function redactDetail(value, secrets = []) {
  let detail = typeof value === 'string' ? value : '';
  for (const secret of secrets) {
    if (secret) detail = detail.split(secret).join('[REDACTED]');
  }
  return detail.slice(0, 500);
}

function storageErrorStatus(error) {
  const status = Number(error?.status);
  return Number.isInteger(status) ? status : null;
}

async function isPublicStorageObjectMissing(response) {
  if (response.status === 404) return true;
  if (response.status !== 400) return false;

  try {
    const body = await response.json();
    return String(body?.statusCode) === '404'
      && body?.error === 'not_found'
      && body?.message === 'Object not found';
  } catch {
    return false;
  }
}

async function fetchExistingZip(ref, version, fetchImpl) {
  const response = await fetchImpl(publicZipUrl(ref, version), { cache: 'no-store' });
  if (await isPublicStorageObjectMissing(response)) return null;
  if (response.status !== 200) {
    throw new Error(`consulta ${version}.zip HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function assertSameZip(version, localZip, remoteZip) {
  const localSha = sha256Buffer(localZip);
  const remoteSha = sha256Buffer(remoteZip);
  if (localSha !== remoteSha) {
    throw new Error(`ZIP ${version} ja existe com SHA-256 diferente`);
  }
  return localSha;
}

async function assertImmutableObjectInfo(
  client,
  objectPath,
  { size, bytes, contentType, attestation },
) {
  const { data, error } = await client.storage.from(STORAGE_BUCKET).info(objectPath);
  if (error) {
    const status = storageErrorStatus(error);
    throw new Error(
      `nao foi possivel validar a atestacao de ${objectPath} via Storage info()`
      + `${status ? ` (HTTP ${status})` : ''}`,
    );
  }

  const metadataMatches = isDeepStrictEqual(data?.metadata, attestation);
  const expectedSize = size ?? bytes?.length;
  if (data?.size !== expectedSize || data?.contentType !== contentType || !metadataMatches) {
    throw new Error(
      `objeto imutavel ${objectPath} possui atestacao inconsistente; `
      + 'corrija ou remova o objeto pela API do Storage antes de repetir o stage',
    );
  }
}

function buildArtifactAttestation(version, sha256, sourceSha) {
  return {
    schemaVersion: 1,
    kind: 'hub-release-artifact',
    version,
    platform: WINDOWS_PLATFORM,
    sourceSha,
    sha256,
  };
}

function buildMetadataAttestation(approval) {
  return {
    schemaVersion: 1,
    kind: 'hub-release-metadata',
    version: approval.version,
    platform: WINDOWS_PLATFORM,
    sourceSha: approval.source_sha,
    artifactSha256: approval.artifact.sha256,
    sha256: approval.metadata.sha256,
  };
}

function buildManifestAttestation(approval, variant) {
  const candidate = approval.manifests[variant];
  return {
    schemaVersion: 1,
    kind: 'hub-release-manifest',
    version: approval.version,
    platform: WINDOWS_PLATFORM,
    sourceSha: approval.source_sha,
    artifactSha256: approval.artifact.sha256,
    manifestSha256: candidate.sha256,
    manifest: candidate.body,
  };
}

function buildCanonicalManifestAttestation(approval, variant, promotionId) {
  return {
    ...buildManifestAttestation(approval, variant),
    promotionId,
  };
}

function publicObjectUrl(ref, objectPath) {
  assertProjectRef(ref);
  return `https://${ref}.supabase.co/storage/v1/object/public/${STORAGE_BUCKET}/${objectPath}`;
}

function approvedObjectSpecs(approval, artifact) {
  return [
    {
      objectPath: approval.artifact.path,
      bytes: Buffer.from(artifact),
      contentType: 'application/zip',
      attestation: {
        expedRelease: buildArtifactAttestation(
          approval.version,
          approval.artifact.sha256,
          approval.source_sha,
        ),
      },
      conflictMessage: `ZIP ${approval.version} ja existe com SHA-256 diferente`,
    },
    {
      objectPath: approval.metadata.path,
      bytes: Buffer.from(JSON.stringify(approval.metadata.body)),
      contentType: 'application/json',
      attestation: { expedRelease: buildMetadataAttestation(approval) },
      conflictMessage: `metadata ${approval.version} ja existe com conteudo diferente`,
    },
    ...['release', 'rollback'].map((variant) => {
      const candidate = approval.manifests[variant];
      return {
        objectPath: candidate.path,
        bytes: Buffer.from(JSON.stringify(candidate.body)),
        contentType: 'application/json',
        attestation: { expedRelease: buildManifestAttestation(approval, variant) },
        conflictMessage: `candidato ${candidate.path} ja existe com conteudo diferente`,
      };
    }),
  ];
}

async function fetchPublicObject(ref, objectPath, fetchImpl, cacheBust) {
  const suffix = cacheBust ? `?release_check=${encodeURIComponent(cacheBust)}` : '';
  return fetchImpl(`${publicObjectUrl(ref, objectPath)}${suffix}`, { cache: 'no-store' });
}

async function verifyExistingImmutableObject(ref, client, spec, fetchImpl, cacheBust) {
  const response = await fetchPublicObject(ref, spec.objectPath, fetchImpl, cacheBust);
  if (response.status !== 200) {
    throw new Error(`objeto aprovado ${spec.objectPath} indisponivel (HTTP ${response.status})`);
  }
  const remote = Buffer.from(await response.arrayBuffer());
  if (!spec.bytes.equals(remote)) throw new Error(spec.conflictMessage);
  await assertImmutableObjectInfo(client, spec.objectPath, {
    size: spec.bytes.length,
    contentType: spec.contentType,
    attestation: spec.attestation,
  });
}

async function verifyApprovedReleaseObjects(ref, client, approval, artifact, fetchImpl) {
  const specs = approvedObjectSpecs(approval, artifact);
  for (const spec of specs) {
    await verifyExistingImmutableObject(ref, client, spec, fetchImpl);
  }
}

/** Cria um ZIP versionado uma unica vez; retries exigem bytes e atestacao identicos. */
export async function uploadImmutableZip(
  ref,
  credentials,
  version,
  zip,
  { fetchImpl = fetch, client, sourceSha } = {},
) {
  assertProjectRef(ref);
  if (!versaoValida(version)) throw new Error(`versao invalida: ${version}`);
  const validatedCredentials = assertReleaseCredentials(credentials, STAGE_ROLE);
  if (!sourceShaValido(sourceSha)) throw new Error('source_sha invalido');
  const releaseClient = client || createReleaseClient(
    ref,
    validatedCredentials,
    STAGE_ROLE,
    fetchImpl,
  );
  await assertReleaseClientAccess(releaseClient, validatedCredentials, STAGE_ROLE);
  const zipBuffer = Buffer.from(zip);
  const sha256 = sha256Buffer(zipBuffer);
  const objectPath = `${WINDOWS_ARTIFACT_PREFIX}/${version}.zip`;
  const spec = {
    objectPath,
    bytes: zipBuffer,
    contentType: 'application/zip',
    attestation: {
      expedRelease: buildArtifactAttestation(version, sha256, sourceSha),
    },
    conflictMessage: `ZIP ${version} ja existe com SHA-256 diferente`,
  };
  const existing = await fetchExistingZip(ref, version, fetchImpl);
  if (existing) {
    assertSameZip(version, zipBuffer, existing);
    await assertImmutableObjectInfo(releaseClient, objectPath, spec);
    return { uploaded: false, reused: true, sha256 };
  }

  const { error } = await releaseClient.storage
    .from(STORAGE_BUCKET)
    .upload(objectPath, zipBuffer, {
      contentType: spec.contentType,
      metadata: spec.attestation,
      upsert: false,
    });
  if (!error) return { uploaded: true, reused: false, sha256 };

  const status = storageErrorStatus(error);
  const detail = redactDetail(error.message, [releaseCredentialSecret(validatedCredentials)]);
  if (status === 400 || status === 409) {
    const raced = await fetchExistingZip(ref, version, fetchImpl);
    if (raced) {
      assertSameZip(version, zipBuffer, raced);
      await assertImmutableObjectInfo(releaseClient, objectPath, spec);
      return { uploaded: false, reused: true, sha256 };
    }
  }

  throw new Error(`upload ${version}.zip HTTP ${status ?? 'desconhecido'}${detail ? `: ${detail}` : ''}`);
}

async function uploadImmutableApprovalObject(
  ref,
  credentials,
  spec,
  fetchImpl,
  client,
) {
  const validatedCredentials = assertReleaseCredentials(credentials, STAGE_ROLE);
  const existing = await fetchPublicObject(ref, spec.objectPath, fetchImpl);
  if (existing.status === 200) {
    const remote = Buffer.from(await existing.arrayBuffer());
    if (!spec.bytes.equals(remote)) throw new Error(spec.conflictMessage);
    await assertImmutableObjectInfo(client, spec.objectPath, spec);
    return;
  }
  if (!(await isPublicStorageObjectMissing(existing))) {
    throw new Error(`consulta objeto ${spec.objectPath} HTTP ${existing.status}`);
  }

  const { error } = await client.storage.from(STORAGE_BUCKET).upload(
    spec.objectPath,
    spec.bytes,
    {
      ...(spec.objectPath.endsWith('manifest.json') ? { cacheControl: '0' } : {}),
      contentType: spec.contentType,
      metadata: spec.attestation,
      upsert: false,
    },
  );
  if (!error) return;

  const status = storageErrorStatus(error);
  const detail = redactDetail(error.message, [releaseCredentialSecret(validatedCredentials)]);
  if (status === 400 || status === 409) {
    const raced = await fetchPublicObject(ref, spec.objectPath, fetchImpl);
    if (raced.status === 200) {
      const remote = Buffer.from(await raced.arrayBuffer());
      if (!spec.bytes.equals(remote)) throw new Error(spec.conflictMessage);
      await assertImmutableObjectInfo(client, spec.objectPath, spec);
      return;
    }
  }

  throw new Error(
    `upload ${spec.objectPath} HTTP ${status ?? 'desconhecido'}${detail ? `: ${detail}` : ''}`,
  );
}

export async function stageRelease(
  ref,
  credentials,
  version,
  {
    root = ROOT,
    platform = process.platform,
    fetchImpl = fetch,
    logger = console,
    sourceSha,
  } = {},
) {
  assertProjectRef(ref);
  if (platform !== 'win32') throw new Error('stage exige runtime win32');
  if (!sourceShaValido(sourceSha)) throw new Error('source_sha invalido');
  const client = createReleaseClient(ref, credentials, STAGE_ROLE, fetchImpl);
  const releaseDir = montarRelease(version, { root });
  const zipPath = path.join(root, 'releases', `${version}.zip`);
  createDeterministicZip(releaseDir, zipPath);

  const zip = readFileSync(zipPath);
  const approval = buildReleaseApproval(ref, version, sourceSha, sha256Buffer(zip));
  await uploadImmutableZip(ref, credentials, version, zip, {
    fetchImpl,
    client,
    sourceSha,
  });
  const specs = approvedObjectSpecs(approval, zip);
  for (const spec of specs.slice(1)) {
    await uploadImmutableApprovalObject(ref, credentials, spec, fetchImpl, client);
  }
  await verifyApprovedReleaseObjects(ref, client, approval, zip, fetchImpl);

  const { data, error } = await client.rpc('register_hub_release_artifact', {
    p_project_ref: ref,
    p_release: approval,
  });
  if (error) {
    const detail = redactDetail(error.message, [releaseCredentialSecret(credentials)]);
    throw new Error(`registro do artifact aprovado falhou${detail ? `: ${detail}` : ''}`);
  }
  if (!isDeepStrictEqual(data, approval)) {
    throw new Error('RPC registrou identidade diferente do artifact aprovado');
  }

  const approvalPath = path.join(root, 'releases', `${version}.release.json`);
  writeFileSync(approvalPath, `${JSON.stringify(approval, null, 2)}\n`, { mode: 0o600 });
  logger.log('Release staged and registered:', JSON.stringify(approval));
  return approval;
}

function assertPromotionDirective(ref, approval, directive, { allowDowngrade }) {
  if (!directive || typeof directive !== 'object' || Array.isArray(directive)) {
    throw new Error('RPC de promocao retornou resposta invalida');
  }
  const {
    manifest,
    source,
    destination,
    requiresCopy,
    promotionId,
    expiresAt,
    sourceSha,
    artifactSha256,
    metadataSha256,
    manifestSha256,
  } = directive;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('RPC de promocao retornou manifest invalido');
  }
  if (manifest.versao !== approval.version) {
    throw new Error('RPC de promocao retornou versao inesperada');
  }
  if (manifest.url !== publicZipUrl(ref, approval.version)) {
    throw new Error('RPC retornou URL nao canonica');
  }
  if (manifest.sha256 !== approval.artifact.sha256) {
    throw new Error('RPC de promocao retornou SHA-256 invalido');
  }

  const isDowngradeManifest = manifest.allowDowngrade === true;
  const hasDowngradeMetadata = Object.hasOwn(manifest, 'allowDowngrade')
    || Object.hasOwn(manifest, 'minimumHubVersion');
  if (hasDowngradeMetadata && (
    !isDowngradeManifest
    || manifest.minimumHubVersion !== MINIMUM_DOWNGRADE_HUB_VERSION
  )) {
    throw new Error('RPC de promocao retornou metadata de downgrade invalida');
  }
  if (requiresCopy === true && isDowngradeManifest && allowDowngrade !== true) {
    throw new Error('RPC tentou autorizar downgrade sem confirmacao local');
  }

  const variant = isDowngradeManifest ? 'rollback' : 'release';
  const expectedCandidate = approval.manifests[variant];
  if (!isDeepStrictEqual(manifest, expectedCandidate.body)) {
    throw new Error('RPC retornou manifest diferente do artifact aprovado');
  }
  const expectedSource = expectedCandidate.path;
  if (source !== expectedSource || destination !== 'manifest.json') {
    throw new Error('RPC de promocao retornou origem ou destino nao canonico');
  }
  if (requiresCopy !== true && requiresCopy !== false) {
    throw new Error('RPC de promocao retornou requiresCopy invalido');
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(promotionId)) {
    throw new Error('RPC de promocao retornou promotionId invalido');
  }
  if (
    sourceSha !== approval.source_sha
    || artifactSha256 !== approval.artifact.sha256
    || metadataSha256 !== approval.metadata.sha256
    || manifestSha256 !== expectedCandidate.sha256
  ) {
    throw new Error('RPC de promocao retornou identidade diferente do artifact aprovado');
  }
  if (requiresCopy) {
    const expiresAtMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      throw new Error('RPC de promocao retornou reserva expirada ou invalida');
    }
  }

  return {
    manifest,
    source,
    destination,
    requiresCopy,
    promotionId,
    expiresAt,
    sourceSha,
    artifactSha256,
    metadataSha256,
    manifestSha256,
    variant,
  };
}

function publicManifestUrl(ref) {
  assertProjectRef(ref);
  return `https://${ref}.supabase.co/storage/v1/object/public/${STORAGE_BUCKET}/manifest.json`;
}

function parseObservedManifest(ref, bytes) {
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('manifest legado publico nao contem JSON valido');
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('manifest legado publico possui formato invalido');
  }
  if (!versaoValida(manifest.versao) || !sha256Valido(manifest.sha256)) {
    throw new Error('manifest legado publico possui versao ou SHA-256 invalido');
  }
  const base = `https://${ref}.supabase.co/storage/v1/object/public/${STORAGE_BUCKET}`;
  const allowedUrls = new Set([
    `${base}/${manifest.versao}.zip`,
    `${base}/${WINDOWS_ARTIFACT_PREFIX}/${manifest.versao}.zip`,
  ]);
  if (!allowedUrls.has(manifest.url)) {
    throw new Error('manifest legado publico aponta para URL nao canonica');
  }
  const hasDowngradeMetadata = Object.hasOwn(manifest, 'allowDowngrade')
    || Object.hasOwn(manifest, 'minimumHubVersion');
  if (hasDowngradeMetadata && (
    manifest.allowDowngrade !== true
    || manifest.minimumHubVersion !== MINIMUM_DOWNGRADE_HUB_VERSION
  )) {
    throw new Error('manifest legado publico possui metadata de downgrade invalida');
  }
  return manifest;
}

export async function observeLegacyManifest(ref, { fetchImpl = fetch } = {}) {
  const manifestUrl = publicManifestUrl(ref);
  const first = await fetchImpl(manifestUrl, { cache: 'no-store' });
  if (first.status !== 200) {
    throw new Error(
      `manifest legado canonico indisponivel (HTTP ${first.status}); promocao bloqueada`,
    );
  }
  const firstBytes = Buffer.from(await first.arrayBuffer());
  const manifest = parseObservedManifest(ref, firstBytes);

  const artifactResponse = await fetchImpl(manifest.url, { cache: 'no-store' });
  if (artifactResponse.status !== 200) {
    throw new Error(`ZIP do manifest legado indisponivel (HTTP ${artifactResponse.status})`);
  }
  const artifact = Buffer.from(await artifactResponse.arrayBuffer());
  if (sha256Buffer(artifact) !== manifest.sha256) {
    throw new Error('ZIP do manifest legado nao corresponde ao SHA-256 publicado');
  }

  const second = await fetchImpl(manifestUrl, { cache: 'no-store' });
  if (second.status !== 200) {
    throw new Error('manifest legado mudou durante a observacao; promocao bloqueada');
  }
  const secondBytes = Buffer.from(await second.arrayBuffer());
  if (!firstBytes.equals(secondBytes)) {
    throw new Error('manifest legado mudou durante a observacao; promocao bloqueada');
  }

  const manifestText = firstBytes.toString('utf8');
  if (!Buffer.from(manifestText, 'utf8').equals(firstBytes)) {
    throw new Error('manifest legado publico nao usa UTF-8 canonico');
  }
  return { manifest, manifestText, manifestSha256: sha256Buffer(firstBytes) };
}

async function authorizePromotion(
  client,
  ref,
  approval,
  allowDowngrade,
  minimumHubVersion,
  accessToken,
) {
  const { data, error } = await client.rpc('promote_hub_release', {
    p_allow_downgrade: allowDowngrade,
    p_artifact_sha256: approval.artifact.sha256,
    p_metadata_sha256: approval.metadata.sha256,
    p_minimum_hub_version: minimumHubVersion || null,
    p_project_ref: ref,
    p_source_sha: approval.source_sha,
    p_version: approval.version,
  });
  if (error) {
    const detail = redactDetail(error.message, [accessToken]);
    throw new Error(`RPC de promocao falhou${detail ? `: ${detail}` : ''}`);
  }
  return assertPromotionDirective(ref, approval, data, { allowDowngrade });
}

async function initializePromotionState(client, ref, observed, accessToken) {
  const { error } = await client.rpc('initialize_hub_release_promotion', {
    p_manifest_sha256: observed.manifestSha256,
    p_manifest_text: observed.manifestText,
    p_project_ref: ref,
  });
  if (error) {
    const detail = redactDetail(error.message, [accessToken]);
    throw new Error(`inicializacao do estado de promocao falhou${detail ? `: ${detail}` : ''}`);
  }
}

async function copyAuthorizedManifest(
  ref,
  credentials,
  approval,
  directive,
  fetchImpl,
) {
  const canonicalMetadata = {
    expedRelease: buildCanonicalManifestAttestation(
      approval,
      directive.variant,
      directive.promotionId,
    ),
  };
  const response = await fetchImpl(
    `https://${ref}.supabase.co/storage/v1/object/copy`,
    {
      method: 'POST',
      headers: {
        ...releaseRequestHeaders(credentials),
        'content-type': 'application/json',
        'x-upsert': 'true',
        'x-metadata': Buffer.from(JSON.stringify(canonicalMetadata)).toString('base64'),
      },
      body: JSON.stringify({
        bucketId: STORAGE_BUCKET,
        sourceKey: directive.source,
        destinationKey: directive.destination,
        copyMetadata: false,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`copia canonica do manifest HTTP ${response.status}`);
  }
}

async function verifyCanonicalManifest(client, approval, directive) {
  const candidate = approval.manifests[directive.variant];
  const spec = {
    objectPath: 'manifest.json',
    bytes: Buffer.from(JSON.stringify(candidate.body)),
    contentType: 'application/json',
    attestation: {
      expedRelease: buildCanonicalManifestAttestation(
        approval,
        directive.variant,
        directive.promotionId,
      ),
    },
    conflictMessage: 'copia canonica materializou bytes diferentes do artifact aprovado',
  };
  const { data, error } = await client.storage.from(STORAGE_BUCKET).download(
    spec.objectPath,
    { cacheNonce: directive.promotionId },
    { cache: 'no-store' },
  );
  if (error || !data) {
    const status = storageErrorStatus(error);
    throw new Error(
      'nao foi possivel baixar o manifest canonico pela Storage API'
      + `${status ? ` (HTTP ${status})` : ''}`,
    );
  }
  const downloaded = Buffer.from(await data.arrayBuffer());
  if (!spec.bytes.equals(downloaded)) {
    throw new Error(directive.requiresCopy
      ? 'copia canonica materializou bytes diferentes do artifact aprovado'
      : 'manifest canonico no Storage possui bytes diferentes do artifact aprovado');
  }
  await assertImmutableObjectInfo(client, spec.objectPath, spec);
}

async function attestCanonicalManifestCopy(client, approval, directive, accessToken) {
  const { data, error } = await client.rpc('attest_hub_release_manifest_copy', {
    p_promotion_id: directive.promotionId,
  });
  if (error) {
    const detail = redactDetail(error.message, [accessToken]);
    throw new Error(`atestado da copia canonica falhou${detail ? `: ${detail}` : ''}`);
  }
  if (
    data?.promotionId !== directive.promotionId
    || data?.sourceSha !== approval.source_sha
    || data?.artifactSha256 !== approval.artifact.sha256
    || data?.metadataSha256 !== approval.metadata.sha256
    || data?.manifestSha256 !== directive.manifestSha256
    || typeof data?.objectVersion !== 'string'
    || data.objectVersion.length === 0
    || !Number.isFinite(Date.parse(data?.observedAt))
  ) {
    throw new Error('RPC atestou copia canonica com identidade diferente');
  }
  return data;
}

async function completePromotion(client, approval, directive, accessToken) {
  const { data, error } = await client.rpc('complete_hub_release_promotion', {
    p_promotion_id: directive.promotionId,
  });
  if (error) {
    const detail = redactDetail(error.message, [accessToken]);
    throw new Error(`conclusao da promocao falhou${detail ? `: ${detail}` : ''}`);
  }
  if (
    data?.requiresCopy !== false
    || data?.promotionId !== directive.promotionId
    || !isDeepStrictEqual(data?.manifest, directive.manifest)
    || data?.sourceSha !== approval.source_sha
    || data?.artifactSha256 !== approval.artifact.sha256
    || data?.metadataSha256 !== approval.metadata.sha256
    || data?.manifestSha256 !== directive.manifestSha256
  ) {
    throw new Error('RPC concluiu promocao com identidade diferente da copia verificada');
  }
  return data.manifest;
}

export async function promoteRelease(
  ref,
  credentials,
  version,
  {
    allowDowngrade = false,
    minimumHubVersion,
    fetchImpl = fetch,
    logger = console,
    sourceSha,
    artifactSha256,
    approvalPath,
    artifactPath,
  } = {},
) {
  assertProjectRef(ref);
  if (!versaoValida(version)) throw new Error(`versao invalida: ${version}`);
  if (allowDowngrade !== false && allowDowngrade !== true) {
    throw new Error('allowDowngrade deve ser booleano');
  }
  if (minimumHubVersion && allowDowngrade !== true) {
    throw new Error('minimumHubVersion exige allowDowngrade');
  }
  if (allowDowngrade === true) assertDowngradeHubVersion(minimumHubVersion);
  const validatedCredentials = assertReleaseCredentials(credentials, PROMOTION_ROLE);
  const { approval, artifact } = loadApprovedRelease({
    ref,
    version,
    sourceSha,
    artifactSha256,
    approvalPath,
    artifactPath,
  });
  const client = createReleaseClient(ref, validatedCredentials, PROMOTION_ROLE, fetchImpl);
  await assertReleaseClientAccess(client, validatedCredentials, PROMOTION_ROLE);
  await verifyApprovedReleaseObjects(ref, client, approval, artifact, fetchImpl);
  const credentialSecret = releaseCredentialSecret(validatedCredentials);
  const observed = await observeLegacyManifest(ref, { fetchImpl });
  await initializePromotionState(
    client,
    ref,
    observed,
    credentialSecret,
  );
  const directive = await authorizePromotion(
    client,
    ref,
    approval,
    allowDowngrade,
    minimumHubVersion,
    credentialSecret,
  );

  if (directive.requiresCopy) {
    await copyAuthorizedManifest(
      ref,
      validatedCredentials,
      approval,
      directive,
      fetchImpl,
    );
  }
  await verifyCanonicalManifest(client, approval, directive);
  if (!directive.requiresCopy) {
    logger.log('Manifest already promoted and verified:', JSON.stringify(directive.manifest));
    return directive.manifest;
  }
  await attestCanonicalManifestCopy(
    client,
    approval,
    directive,
    credentialSecret,
  );
  const manifest = await completePromotion(
    client,
    approval,
    directive,
    credentialSecret,
  );
  logger.log('Manifest promoted:', JSON.stringify(manifest));
  return manifest;
}

async function main() {
  const packageVersion = JSON.parse(
    readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
  ).version;
  const {
    mode,
    version,
    allowDowngrade = false,
    minimumHubVersion,
  } = parseReleaseArgs(
    process.argv.slice(2),
    packageVersion,
  );

  const ref = process.env.PROJECT_REF;
  const credentials = process.env.SUPABASE_RELEASE_KEY
    ? { releaseKey: process.env.SUPABASE_RELEASE_KEY }
    : {
        anonKey: process.env.SUPABASE_ANON_KEY,
        accessToken: process.env.SUPABASE_ACCESS_TOKEN,
      };
  if (
    !ref
    || (!credentials.releaseKey && (!credentials.anonKey || !credentials.accessToken))
  ) {
    throw new Error(
      'defina PROJECT_REF e SUPABASE_RELEASE_KEY custom-role',
    );
  }

  if (mode === 'stage') {
    await stageRelease(ref, credentials, version, {
      root: process.env.RELEASE_SOURCE_ROOT
        ? path.resolve(process.env.RELEASE_SOURCE_ROOT)
        : ROOT,
      sourceSha: process.env.RELEASE_SOURCE_SHA,
    });
  } else {
    await promoteRelease(ref, credentials, version, {
      allowDowngrade,
      minimumHubVersion,
      sourceSha: process.env.RELEASE_SOURCE_SHA,
      artifactSha256: process.env.RELEASE_ARTIFACT_SHA256,
      approvalPath: process.env.RELEASE_APPROVAL_PATH
        ? path.resolve(process.env.RELEASE_APPROVAL_PATH)
        : undefined,
      artifactPath: process.env.RELEASE_ARTIFACT_PATH
        ? path.resolve(process.env.RELEASE_ARTIFACT_PATH)
        : undefined,
    });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('FALHOU:', error.message);
    process.exit(1);
  });
}
