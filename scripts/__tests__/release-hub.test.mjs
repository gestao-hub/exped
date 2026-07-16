import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as releaseHub from '../release-hub.mjs';
import {
  PROMOTION_ROLE,
  STAGE_ROLE,
  assertReleaseApiKey,
  assertReleaseAccessToken,
  buildManifest,
  compareSemver,
  montarRelease,
  parseReleaseArgs,
  promoteRelease,
  projectRefValido,
  publicZipUrl,
  sha256Buffer,
  stageRelease,
  uploadImmutableZip,
  versaoValida,
} from '../release-hub.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROJECT_REF = 'abcdefghijklmnopqrst';
const ANON_KEY = 'anon-publica';
const RELEASE_KEY = `sb_secret_${'a'.repeat(22)}_${'b'.repeat(8)}`;
const PROMOTION_RELEASE_KEY = `sb_secret_${'c'.repeat(22)}_${'d'.repeat(8)}`;
const SOURCE_SHA = '7'.repeat(40);
const promotionMigration = readFileSync(
  path.join(ROOT, 'supabase/migrations/20260714223000_hub_release_promotion_rpc.sql'),
  'utf8',
);
const materializedCopyMigration = readFileSync(
  path.join(
    ROOT,
    'supabase/migrations/20260716131854_hub_release_materialized_copy_attestation.sql',
  ),
  'utf8',
);
const apiKeyMigration = readFileSync(
  path.join(ROOT, 'supabase/migrations/20260715115548_hub_release_api_key_auth.sql'),
  'utf8',
);

function tokenForRole(role, claims = {}) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    role,
    sub: '00000000-0000-0000-0000-000000000001',
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...claims,
  })}.assinatura`;
}

function credentialsFor(role) {
  return { anonKey: ANON_KEY, accessToken: tokenForRole(role) };
}

describe('contrato transacional da promocao', () => {
  it('so conclui depois de prova produzida pela operacao Storage copy', () => {
    expect(promotionMigration).toMatch(
      /hub_release_mark_copy\(\s*p_name text,\s*p_user_metadata jsonb\s*\)[\s\S]*allow_only_operation\('object\.copy'\)/i,
    );
    expect(promotionMigration).toMatch(
      /p_user_metadata[\s\S]*pending_manifest_sha256[\s\S]*pending_manifest/i,
    );
    expect(promotionMigration).toMatch(/pending_copy_promotion_id[\s\S]*pending_copy_observed_at/i);
    expect(promotionMigration).toMatch(/complete_hub_release_promotion\(\s*p_promotion_id uuid\s*\)/i);
    expect(promotionMigration).not.toMatch(
      /complete_hub_release_promotion\(\s*p_promotion_id uuid,\s*p_source_sha/i,
    );
  });

  it('mantem promocao copiada em recovery e bloqueia identidade concorrente', () => {
    expect(promotionMigration).toMatch(/promocao copiada aguarda recovery da mesma identidade/i);
    expect(promotionMigration).toMatch(/versao atual legada possui identidade imutavel desconhecida/i);
  });

  it('atesta a copia materializada fora da transacao descartada pelo Storage', () => {
    expect(materializedCopyMigration).toMatch(
      /attest_hub_release_manifest_copy\(\s*p_promotion_id uuid\s*\)/i,
    );
    expect(materializedCopyMigration).toMatch(
      /from storage\.objects[\s\S]*bucket_id = 'hub-releases'[\s\S]*name = 'manifest\.json'/i,
    );
    expect(materializedCopyMigration).toMatch(
      /observed_at[\s\S]*pending_requested_at[\s\S]*user_metadata[\s\S]*pending_manifest_sha256/i,
    );
    expect(materializedCopyMigration).toMatch(
      /create trigger hub_release_guard_manifest_write[\s\S]*on storage\.objects/i,
    );
    expect(materializedCopyMigration).toMatch(
      /promotionId[\s\S]*pending_promotion_id[\s\S]*eTag[\s\S]*pending_source_name/i,
    );
    expect(materializedCopyMigration).toMatch(
      /observed_at\s*<=\s*p_state\.pending_requested_at/i,
    );
    expect(materializedCopyMigration).toMatch(
      /complete_hub_release_promotion[\s\S]*hub_release_assert_materialized_copy/i,
    );
    expect(materializedCopyMigration).toMatch(
      /revoke all on function public\.attest_hub_release_manifest_copy\(uuid\)[\s\S]*service_role/i,
    );
    expect(materializedCopyMigration).toMatch(
      /grant execute on function public\.attest_hub_release_manifest_copy\(uuid\)[\s\S]*exped_hub_release_promote/i,
    );
    expect(materializedCopyMigration).not.toMatch(
      /hub_release_mark_copy\(name,\s*user_metadata\)/i,
    );
  });
});

describe('credencial opaca de release', () => {
  it('expoe RPC minima e revoga explicitamente service_role', () => {
    expect(apiKeyMigration).toMatch(
      /assert_hub_release_access\(\s*p_expected_role text\s*\)[\s\S]*private\.hub_release_subject\(p_expected_role\)/i,
    );
    expect(apiKeyMigration).toMatch(
      /revoke all on function public\.assert_hub_release_access\(text\)[\s\S]*service_role/i,
    );
    expect(apiKeyMigration).toMatch(
      /grant execute on function public\.assert_hub_release_access\(text\)[\s\S]*exped_hub_release_stage[\s\S]*exped_hub_release_promote/i,
    );
  });
});

const stageCredentials = () => credentialsFor(STAGE_ROLE);
const promotionCredentials = () => credentialsFor(PROMOTION_ROLE);

function requestHeader(init, name) {
  return new Headers(init.headers).get(name);
}

function fakeResponse(status, body = '') {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    arrayBuffer: async () => payload,
    blob: async () => new Blob([payload]),
    json: async () => JSON.parse(payload.toString('utf8')),
    text: async () => payload.toString('utf8'),
  };
}

function storageObjectNotFoundResponse() {
  return fakeResponse(400, JSON.stringify({
    statusCode: '404',
    error: 'not_found',
    message: 'Object not found',
  }));
}

function artifactAttestation(version, zip, sourceSha = SOURCE_SHA) {
  return {
    expedRelease: {
      schemaVersion: 1,
      kind: 'hub-release-artifact',
      version,
      platform: 'win32',
      sourceSha,
      sha256: sha256Buffer(zip),
    },
  };
}

function objectInfoResponse(objectPath, bytes, contentType, metadata) {
  return fakeResponse(200, JSON.stringify({
    id: 'object-id',
    version: 'object-version',
    name: objectPath,
    bucket_id: 'hub-releases',
    size: bytes.length,
    content_type: contentType,
    metadata,
  }));
}

describe('release-hub (partes puras)', () => {
  it('buildManifest monta {versao,url,sha256}', () => {
    expect(buildManifest('1.2.0', 'https://x/h/1.2.0.zip', 'abc')).toEqual({
      versao: '1.2.0', url: 'https://x/h/1.2.0.zip', sha256: 'abc',
    });
  });
  it('sha256Buffer = hash hex do buffer', () => {
    const buf = Buffer.from('hello');
    expect(sha256Buffer(buf)).toBe(createHash('sha256').update(buf).digest('hex'));
  });
  it('versaoValida aceita semver limpo, rejeita lixo', () => {
    expect(versaoValida('1.2.0')).toBe(true);
    expect(versaoValida('v1.2.0')).toBe(false);
    expect(versaoValida('1.2.0; rm')).toBe(false);
  });

  it('compara semver numericamente em vez de lexicalmente', () => {
    expect(compareSemver('0.3.10', '0.3.9')).toBe(1);
    expect(compareSemver('2.0.0', '10.0.0')).toBe(-1);
    expect(compareSemver('1.2', '1.2.0')).toBe(0);
  });

  it('aceita somente o custom role esperado e recusa service_role explicitamente', () => {
    expect(assertReleaseAccessToken(tokenForRole(STAGE_ROLE), STAGE_ROLE)).toMatchObject({
      role: STAGE_ROLE,
    });
    expect(() => assertReleaseAccessToken(
      tokenForRole(PROMOTION_ROLE),
      STAGE_ROLE,
    )).toThrow(`role ${STAGE_ROLE}`);
    expect(() => assertReleaseAccessToken(
      tokenForRole('service_role'),
      STAGE_ROLE,
    )).toThrow('service_role');
    expect(() => assertReleaseAccessToken(
      tokenForRole(STAGE_ROLE, { sub: undefined }),
      STAGE_ROLE,
    )).toThrow('claim sub UUID valida');
    expect(() => assertReleaseAccessToken('nao-e-jwt', STAGE_ROLE)).toThrow('JWT');
  });

  it('aceita somente chave opaca secreta moderna para a credencial restrita', () => {
    expect(assertReleaseApiKey(RELEASE_KEY)).toBe(RELEASE_KEY);
    expect(() => assertReleaseApiKey(tokenForRole('service_role'))).toThrow('sb_secret_');
    expect(() => assertReleaseApiKey('sb_publishable_publica')).toThrow('sb_secret_');
    expect(() => assertReleaseApiKey('sb_secret_curta')).toThrow('sb_secret_');
  });

  it('stage e promote exigem modo explicito', () => {
    expect(parseReleaseArgs(['stage', '0.3.21'], '0.3.20')).toEqual({
      mode: 'stage', version: '0.3.21',
    });
    expect(parseReleaseArgs(['promote'], '0.3.21')).toEqual({
      mode: 'promote', version: '0.3.21',
    });
    expect(() => parseReleaseArgs([], '0.3.21')).toThrow('use stage ou promote');
  });

  it('exige confirmacao do ExpedSetup/Hub 0.3.21+ para downgrade', () => {
    expect(parseReleaseArgs([
      'promote',
      '0.3.20',
      '--allow-downgrade',
      '--confirm-hub-version',
      '0.3.21',
    ], '0.3.21')).toEqual({
      mode: 'promote',
      version: '0.3.20',
      allowDowngrade: true,
      minimumHubVersion: '0.3.21',
    });
    expect(() => parseReleaseArgs(['promote', '0.3.20', '--allow-downgrade'], '0.3.21'))
      .toThrow('confirme ExpedSetup/Hub >= 0.3.21');
    expect(() => parseReleaseArgs([
      'promote',
      '0.3.20',
      '--allow-downgrade',
      '--confirm-hub-version',
      '0.3.20',
    ], '0.3.21')).toThrow('ExpedSetup/Hub >= 0.3.21');
    expect(() => parseReleaseArgs(['stage', '0.3.20', '--allow-downgrade'], '0.3.21'))
      .toThrow('--allow-downgrade so pode ser usado em promote');
    expect(() => parseReleaseArgs([
      'promote', '0.3.20', '--confirm-hub-version', '0.3.21',
    ], '0.3.21')).toThrow('--confirm-hub-version exige --allow-downgrade');
    expect(() => parseReleaseArgs(['promote', '0.3.20', '--desconhecida'], '0.3.21'))
      .toThrow('argumento desconhecido');
  });

  it('monta a URL publica do ZIP versionado', () => {
    expect(publicZipUrl(PROJECT_REF, '0.3.21')).toBe(
      `https://${PROJECT_REF}.supabase.co/storage/v1/object/public/hub-releases/windows/0.3.21.zip`,
    );
  });

  it('valida PROJECT_REF estritamente antes de construir URL', () => {
    expect(projectRefValido(PROJECT_REF)).toBe(true);
    for (const invalid of [
      'evil.example/x',
      'abcdefghijklmnopqrs',
      'abcdefghijklmnopqrstu',
      'ABCDEFGHIJKLMNOPQRST',
      '',
      undefined,
    ]) {
      expect(projectRefValido(invalid)).toBe(false);
      expect(() => publicZipUrl(invalid, '0.3.21')).toThrow('PROJECT_REF invalido');
    }
  });

  it('inclui contrato completo de downgrade somente quando explicitamente confirmado', () => {
    expect(buildManifest('1.0.0', 'https://x/1.0.0.zip', 'abc', {
      allowDowngrade: true,
      minimumHubVersion: '0.3.21',
    })).toEqual({
      versao: '1.0.0',
      url: 'https://x/1.0.0.zip',
      sha256: 'abc',
      allowDowngrade: true,
      minimumHubVersion: '0.3.21',
    });
    expect(buildManifest('1.0.0', 'https://x/1.0.0.zip', 'abc', {
      allowDowngrade: 'true',
      minimumHubVersion: '0.3.21',
    })).toEqual({
      versao: '1.0.0', url: 'https://x/1.0.0.zip', sha256: 'abc',
    });
  });

  it('vincula o approval do GitHub ao source_sha, ZIP e metadata exatos', () => {
    expect(releaseHub.buildReleaseApproval).toBeTypeOf('function');
    const sourceSha = '1'.repeat(40);
    const artifactSha256 = 'a'.repeat(64);
    const approval = releaseHub.buildReleaseApproval(
      PROJECT_REF,
      '0.3.21',
      sourceSha,
      artifactSha256,
    );

    expect(approval).toMatchObject({
      schema_version: 1,
      project_ref: PROJECT_REF,
      version: '0.3.21',
      source_sha: sourceSha,
      artifact: {
        path: 'windows/0.3.21.zip',
        sha256: artifactSha256,
      },
      metadata: {
        path: 'windows/0.3.21.json',
        body: {
          schema_version: 1,
          versao: '0.3.21',
          platform: 'win32',
          source_sha: sourceSha,
          sha256: artifactSha256,
        },
      },
      manifests: {
        release: { path: 'windows/0.3.21.manifest.json' },
        rollback: { path: 'windows/0.3.21.rollback-manifest.json' },
      },
    });
    expect(approval.metadata.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(approval.manifests.release.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(approval.manifests.rollback.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('release-hub ZIP imutavel', () => {
  it('carrega somente o artifact do GitHub que corresponde aos valores aprovados', () => {
    expect(releaseHub.loadApprovedRelease).toBeTypeOf('function');
    const root = mkdtempSync(path.join(tmpdir(), 'exped-approval-'));
    const sourceSha = '2'.repeat(40);
    const zip = Buffer.from('zip aprovado pelo Actions');
    const artifactSha256 = sha256Buffer(zip);
    const approval = releaseHub.buildReleaseApproval(
      PROJECT_REF,
      '0.3.21',
      sourceSha,
      artifactSha256,
    );
    const approvalPath = path.join(root, '0.3.21.release.json');
    const artifactPath = path.join(root, '0.3.21.zip');

    try {
      writeFileSync(approvalPath, JSON.stringify(approval));
      writeFileSync(artifactPath, zip);

      expect(releaseHub.loadApprovedRelease({
        ref: PROJECT_REF,
        version: '0.3.21',
        sourceSha,
        artifactSha256,
        approvalPath,
        artifactPath,
      })).toEqual({ approval, artifact: zip });

      expect(() => releaseHub.loadApprovedRelease({
        ref: PROJECT_REF,
        version: '0.3.21',
        sourceSha: '3'.repeat(40),
        artifactSha256,
        approvalPath,
        artifactPath,
      })).toThrow('source_sha aprovado nao corresponde');

      writeFileSync(artifactPath, 'zip adulterado');
      expect(() => releaseHub.loadApprovedRelease({
        ref: PROJECT_REF,
        version: '0.3.21',
        sourceSha,
        artifactSha256,
        approvalPath,
        artifactPath,
      })).toThrow('SHA-256 do artifact do GitHub nao corresponde');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('aceita retry quando o objeto existente tem o mesmo SHA-256', async () => {
    const zip = Buffer.from('mesmo-zip');
    const calls = [];
    const result = await uploadImmutableZip(PROJECT_REF, stageCredentials(), '0.3.21', zip, {
      sourceSha: SOURCE_SHA,
      fetchImpl: async (url, init = {}) => {
        calls.push({ url, init });
        if (url.includes('/object/info/')) {
          return objectInfoResponse(
            'windows/0.3.21.zip',
            zip,
            'application/zip',
            artifactAttestation('0.3.21', zip),
          );
        }
        return fakeResponse(200, zip);
      },
    });

    expect(result).toEqual({ uploaded: false, reused: true, sha256: sha256Buffer(zip) });
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain('/hub-releases/windows/0.3.21.zip');
    expect(calls[0].init.method).toBeUndefined();
  });

  it('rejeita retry com bytes iguais quando a atestacao do objeto diverge', async () => {
    const zip = Buffer.from('mesmo-zip');
    const sourceSha = '4'.repeat(40);
    const artifactSha256 = sha256Buffer(zip);

    await expect(uploadImmutableZip(
      PROJECT_REF,
      stageCredentials(),
      '0.3.21',
      zip,
      {
        sourceSha,
        fetchImpl: async (url) => {
          if (url.includes('/object/info/')) {
            return fakeResponse(200, JSON.stringify({
              id: 'object-id',
              version: 'object-version',
              name: 'windows/0.3.21.zip',
              bucket_id: 'hub-releases',
              size: zip.length,
              content_type: 'application/zip',
              metadata: {
                expedRelease: {
                  schemaVersion: 1,
                  kind: 'hub-release-artifact',
                  version: '0.3.21',
                  platform: 'win32',
                  sourceSha: '5'.repeat(40),
                  sha256: artifactSha256,
                },
              },
            }));
          }
          return fakeResponse(200, zip);
        },
      },
    )).rejects.toThrow(
      'objeto imutavel windows/0.3.21.zip possui atestacao inconsistente',
    );
  });

  it('rejeita retry quando o objeto existente tem hash diferente', async () => {
    const calls = [];
    await expect(uploadImmutableZip(
      PROJECT_REF,
      stageCredentials(),
      '0.3.21',
      Buffer.from('novo'),
      {
        sourceSha: SOURCE_SHA,
        fetchImpl: async (url, init = {}) => {
          calls.push({ url, init });
          return fakeResponse(200, 'antigo');
        },
      },
    )).rejects.toThrow('ZIP 0.3.21 ja existe com SHA-256 diferente');
    expect(calls).toHaveLength(1);
  });

  it('envia ZIP novo sem x-upsert', async () => {
    const calls = [];
    const credentials = stageCredentials();
    await uploadImmutableZip(PROJECT_REF, credentials, '0.3.21', Buffer.from('novo'), {
      sourceSha: SOURCE_SHA,
      fetchImpl: async (url, init = {}) => {
        calls.push({ url, init });
        return calls.length === 1
          ? fakeResponse(404)
          : fakeResponse(200, JSON.stringify({ Id: 'id', Key: 'key' }));
      },
    });

    expect(calls).toHaveLength(2);
    expect(calls[1].url).toContain('/hub-releases/windows/0.3.21.zip');
    expect(calls[1].init.method).toBe('POST');
    expect(requestHeader(calls[1].init, 'x-upsert')).toBe('false');
    expect(requestHeader(calls[1].init, 'apikey')).toBe(ANON_KEY);
    expect(requestHeader(calls[1].init, 'authorization')).toBe(
      `Bearer ${credentials.accessToken}`,
    );
  });

  it('trata o 400/not_found do Storage publico como objeto ausente', async () => {
    const calls = [];
    const result = await uploadImmutableZip(
      PROJECT_REF,
      stageCredentials(),
      '0.3.21',
      Buffer.from('novo'),
      {
        sourceSha: SOURCE_SHA,
        fetchImpl: async (url, init = {}) => {
          calls.push({ url, init });
          return calls.length === 1
            ? storageObjectNotFoundResponse()
            : fakeResponse(200, JSON.stringify({ Id: 'id', Key: 'key' }));
        },
      },
    );

    expect(result).toMatchObject({ uploaded: true, reused: false });
    expect(calls).toHaveLength(2);
    expect(calls[1].init.method).toBe('POST');
  });

  it('continua rejeitando outros retornos HTTP 400 do Storage publico', async () => {
    await expect(uploadImmutableZip(
      PROJECT_REF,
      stageCredentials(),
      '0.3.21',
      Buffer.from('novo'),
      {
        sourceSha: SOURCE_SHA,
        fetchImpl: async () => fakeResponse(400, JSON.stringify({
          statusCode: '400',
          error: 'bad_request',
          message: 'Invalid request',
        })),
      },
    )).rejects.toThrow('consulta 0.3.21.zip HTTP 400');
  });

  it('valida a role da chave opaca antes de enviar o ZIP', async () => {
    const calls = [];
    const credentials = { releaseKey: RELEASE_KEY };
    await uploadImmutableZip(PROJECT_REF, credentials, '0.3.21', Buffer.from('novo'), {
      sourceSha: SOURCE_SHA,
      fetchImpl: async (url, init = {}) => {
        calls.push({ url, init });
        if (url.endsWith('/rest/v1/rpc/assert_hub_release_access')) {
          return fakeResponse(200, JSON.stringify({
            role: STAGE_ROLE,
            subject: '00000000-0000-0000-0000-000000000001',
          }));
        }
        return calls.length === 2
          ? fakeResponse(404)
          : fakeResponse(200, JSON.stringify({ Id: 'id', Key: 'key' }));
      },
    });

    expect(calls).toHaveLength(3);
    expect(calls[0].url).toContain('/rest/v1/rpc/assert_hub_release_access');
    expect(JSON.parse(calls[0].init.body)).toEqual({ p_expected_role: STAGE_ROLE });
    expect(requestHeader(calls[0].init, 'apikey')).toBe(RELEASE_KEY);
    expect(requestHeader(calls[0].init, 'authorization')).toBe(`Bearer ${RELEASE_KEY}`);
    expect(calls[2].url).toContain('/hub-releases/windows/0.3.21.zip');
    expect(calls[2].init.method).toBe('POST');
  });

  it('falha fechado quando a chave opaca nao comprova a role minima', async () => {
    const calls = [];
    await expect(uploadImmutableZip(
      PROJECT_REF,
      { releaseKey: RELEASE_KEY },
      '0.3.21',
      Buffer.from('novo'),
      {
        sourceSha: SOURCE_SHA,
        fetchImpl: async (url, init = {}) => {
          calls.push({ url, init });
          return fakeResponse(403, JSON.stringify({ message: 'permission denied' }));
        },
      },
    )).rejects.toThrow('credencial de release nao comprovou');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/rest/v1/rpc/assert_hub_release_access');
  });

  it('reconsulta e aceita corrida 409 somente com o mesmo hash', async () => {
    const zip = Buffer.from('zip-da-corrida');
    let call = 0;
    const result = await uploadImmutableZip(PROJECT_REF, stageCredentials(), '0.3.21', zip, {
      sourceSha: SOURCE_SHA,
      fetchImpl: async (url) => {
        call += 1;
        if (call === 1) return fakeResponse(404);
        if (call === 2) return fakeResponse(409, 'Duplicate');
        if (url.includes('/object/info/')) {
          return objectInfoResponse(
            'windows/0.3.21.zip',
            zip,
            'application/zip',
            artifactAttestation('0.3.21', zip),
          );
        }
        return fakeResponse(200, zip);
      },
    });

    expect(result.reused).toBe(true);
    expect(call).toBe(4);
  });

  it('nao repete o access token quando o Storage o ecoa no erro', async () => {
    let error;
    const credentials = {
      anonKey: ANON_KEY,
      accessToken: tokenForRole(STAGE_ROLE, { marker: 'segredo-super-secreto' }),
    };
    try {
      await uploadImmutableZip(
        PROJECT_REF,
        credentials,
        '0.3.21',
        Buffer.from('zip'),
        {
          sourceSha: SOURCE_SHA,
          fetchImpl: async (url, init = {}) => (
            init.method
              ? fakeResponse(500, JSON.stringify({
                message: `falha usando ${credentials.accessToken}`,
              }))
              : fakeResponse(404)
          ),
        },
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain(credentials.accessToken);
    expect(error.message).toContain('[REDACTED]');
  });

  it('redige o segredo antes de truncar a resposta em 500 caracteres', async () => {
    const credentials = stageCredentials();
    const responseBody = JSON.stringify({
      message: `${'x'.repeat(480)}${credentials.accessToken}`,
    });
    let error;
    try {
      await uploadImmutableZip(PROJECT_REF, credentials, '0.3.21', Buffer.from('zip'), {
        sourceSha: SOURCE_SHA,
        fetchImpl: async (url, init = {}) => (
          init.method ? fakeResponse(500, responseBody) : fakeResponse(404)
        ),
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain(credentials.accessToken.slice(0, 16));
    expect(error.message).toContain('[REDACTED]');
  });

  it('rejeita PROJECT_REF antes de qualquer fetch autenticado', async () => {
    let fetches = 0;
    await expect(uploadImmutableZip(
      'evil.example/x',
      stageCredentials(),
      '0.3.21',
      Buffer.from('zip'),
      {
        sourceSha: SOURCE_SHA,
        fetchImpl: async () => { fetches += 1; return fakeResponse(404); },
      },
    )).rejects.toThrow('PROJECT_REF invalido');
    expect(fetches).toBe(0);
  });

  it('stage recusa service_role antes de consultar ou enviar o ZIP', async () => {
    let fetches = 0;
    await expect(uploadImmutableZip(PROJECT_REF, {
      anonKey: ANON_KEY,
      accessToken: tokenForRole('service_role'),
    }, '0.3.21', Buffer.from('zip'), {
      fetchImpl: async () => { fetches += 1; return fakeResponse(500); },
    })).rejects.toThrow('service_role');
    expect(fetches).toBe(0);
  });

  it('recusa service_role tambem quando configurada no lugar da anon key', async () => {
    let fetches = 0;
    await expect(uploadImmutableZip(PROJECT_REF, {
      anonKey: tokenForRole('service_role'),
      accessToken: tokenForRole(STAGE_ROLE),
    }, '0.3.21', Buffer.from('zip'), {
      fetchImpl: async () => { fetches += 1; return fakeResponse(500); },
    })).rejects.toThrow(/SUPABASE_ANON_KEY.*service_role/);
    expect(fetches).toBe(0);
  });

  it('stage falha fora de win32 antes de montar ou enviar artefato', async () => {
    let fetches = 0;
    await expect(stageRelease(PROJECT_REF, stageCredentials(), '0.3.21', {
      root: path.join(tmpdir(), 'nao-deve-ser-lido'),
      platform: 'linux',
      fetchImpl: async () => { fetches += 1; return fakeResponse(200); },
      logger: { log() {} },
    })).rejects.toThrow('stage exige runtime win32');
    expect(fetches).toBe(0);
  });

  it('stage exige source_sha imutavel antes de montar o pacote', async () => {
    await expect(stageRelease(PROJECT_REF, stageCredentials(), '0.3.21', {
      root: path.join(tmpdir(), 'nao-deve-ser-lido'),
      platform: 'win32',
      logger: { log() {} },
    })).rejects.toThrow('source_sha invalido');
  });

  it.skipIf(process.platform === 'win32')(
    'gera bytes repetiveis e materializa symlink do standalone',
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), 'exped-stage-'));
      const put = (relative, content = relative) => {
        const file = path.join(root, relative);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, content);
      };
      const objects = new Map();
      const uploads = [];
      const fetchImpl = async (url, init = {}) => {
        if (url.endsWith('/rest/v1/rpc/register_hub_release_artifact')) {
          return fakeResponse(200, JSON.stringify(JSON.parse(init.body).p_release));
        }
        if (url.includes('/object/info/hub-releases/')) {
          const objectPath = decodeURIComponent(
            url.split('/object/info/hub-releases/')[1].split('?')[0],
          );
          const object = objects.get(objectPath);
          return object
            ? objectInfoResponse(
              objectPath,
              object.bytes,
              object.contentType,
              object.metadata,
            )
            : fakeResponse(404);
        }
        if (url.includes('/object/public/hub-releases/')) {
          const objectPath = decodeURIComponent(
            url.split('/object/public/hub-releases/')[1].split('?')[0],
          );
          return objects.has(objectPath)
            ? fakeResponse(200, objects.get(objectPath).bytes)
            : storageObjectNotFoundResponse();
        }
        const objectPath = decodeURIComponent(url.split('/object/hub-releases/')[1]);
        uploads.push({ objectPath, init });
        objects.set(objectPath, {
          bytes: Buffer.from(init.body),
          contentType: requestHeader(init, 'content-type'),
          metadata: JSON.parse(
            Buffer.from(requestHeader(init, 'x-metadata'), 'base64').toString('utf8'),
          ),
        });
        return fakeResponse(200, JSON.stringify({ Id: objectPath, Key: objectPath }));
      };

      try {
        put('.next/standalone/server.js');
        symlinkSync('server.js', path.join(root, '.next/standalone/linked.js'));
        put('.next/static/chunk.js');
        put('supabase/migrations/001.sql');

        const first = await stageRelease(PROJECT_REF, stageCredentials(), '0.3.21', {
          root, platform: 'win32', fetchImpl, logger: { log() {} }, sourceSha: SOURCE_SHA,
        });
        const second = await stageRelease(PROJECT_REF, stageCredentials(), '0.3.21', {
          root, platform: 'win32', fetchImpl, logger: { log() {} }, sourceSha: SOURCE_SHA,
        });
        const entries = execFileSync(
          'unzip',
          ['-Z1', path.join(root, 'releases', '0.3.21.zip')],
          { encoding: 'utf8' },
        ).trim().split('\n');

        expect(second).toEqual(first);
        expect(uploads.map(({ objectPath }) => objectPath)).toEqual([
          'windows/0.3.21.zip',
          'windows/0.3.21.json',
          'windows/0.3.21.manifest.json',
          'windows/0.3.21.rollback-manifest.json',
        ]);
        expect(uploads.every(({ init }) => requestHeader(init, 'x-upsert') === 'false')).toBe(true);
        expect(
          uploads
            .filter(({ objectPath }) => objectPath.endsWith('manifest.json'))
            .every(({ init }) => requestHeader(init, 'cache-control') === 'max-age=0'),
        ).toBe(true);
        const attestations = Object.fromEntries(uploads.map(({ objectPath, init }) => [
          objectPath,
          JSON.parse(Buffer.from(requestHeader(init, 'x-metadata'), 'base64').toString('utf8')),
        ]));
        expect(attestations['windows/0.3.21.zip']).toEqual({
          expedRelease: {
            schemaVersion: 1,
            kind: 'hub-release-artifact',
            version: '0.3.21',
            platform: 'win32',
            sourceSha: SOURCE_SHA,
            sha256: first.artifact.sha256,
          },
        });
        expect(
          attestations['windows/0.3.21.manifest.json'].expedRelease,
        ).toMatchObject({
          kind: 'hub-release-manifest',
          version: '0.3.21',
          platform: 'win32',
          sourceSha: SOURCE_SHA,
          artifactSha256: first.artifact.sha256,
          manifest: first.manifests.release.body,
        });
        expect(
          attestations['windows/0.3.21.manifest.json'].expedRelease.manifestSha256,
        ).toMatch(/^[a-f0-9]{64}$/);
        expect(JSON.parse(objects.get('windows/0.3.21.json').bytes.toString('utf8'))).toEqual({
          schema_version: 1,
          versao: '0.3.21',
          platform: 'win32',
          source_sha: SOURCE_SHA,
          sha256: first.artifact.sha256,
        });
        expect(JSON.parse(objects.get('windows/0.3.21.manifest.json').bytes.toString('utf8'))).toEqual({
          versao: '0.3.21',
          url: publicZipUrl(PROJECT_REF, '0.3.21'),
          sha256: first.artifact.sha256,
        });
        expect(
          JSON.parse(objects.get('windows/0.3.21.rollback-manifest.json').bytes.toString('utf8')),
        ).toEqual({
          versao: '0.3.21',
          url: publicZipUrl(PROJECT_REF, '0.3.21'),
          sha256: first.artifact.sha256,
          allowDowngrade: true,
          minimumHubVersion: '0.3.21',
        });
        expect(objects.has('manifest.json')).toBe(false);
        expect(existsSync(path.join(root, 'releases', '0.3.21.release.json'))).toBe(true);
        expect(entries).toContain('linked.js');

        objects.get('windows/0.3.21.json').bytes = Buffer.from(JSON.stringify({
          schema_version: 1,
          versao: '0.3.21',
          platform: 'win32',
          source_sha: SOURCE_SHA,
          sha256: '0'.repeat(64),
        }));
        await expect(stageRelease(PROJECT_REF, stageCredentials(), '0.3.21', {
          root, platform: 'win32', fetchImpl, logger: { log() {} }, sourceSha: SOURCE_SHA,
        })).rejects.toThrow('metadata 0.3.21 ja existe com conteudo diferente');
        expect(uploads).toHaveLength(4);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

describe('release-hub promote via RPC canonica', () => {
  const PROMOTION_ID = '11111111-1111-4111-8111-111111111111';

  function approvalFixture(version = '0.3.21') {
    const root = mkdtempSync(path.join(tmpdir(), 'exped-promote-'));
    const artifact = Buffer.from(`artifact-${version}`);
    const approval = releaseHub.buildReleaseApproval(
      PROJECT_REF,
      version,
      SOURCE_SHA,
      sha256Buffer(artifact),
    );
    const approvalPath = path.join(root, `${version}.release.json`);
    const artifactPath = path.join(root, `${version}.zip`);
    writeFileSync(approvalPath, JSON.stringify(approval));
    writeFileSync(artifactPath, artifact);
    return {
      root,
      artifact,
      approval,
      options: {
        sourceSha: SOURCE_SHA,
        artifactSha256: approval.artifact.sha256,
        approvalPath,
        artifactPath,
        logger: { log() {} },
      },
    };
  }

  function recordAttestation(approval, variantOrKind, promotionId) {
    if (variantOrKind === 'artifact') {
      return artifactAttestation(approval.version, Buffer.from(`artifact-${approval.version}`));
    }
    if (variantOrKind === 'metadata') {
      return {
        expedRelease: {
          schemaVersion: 1,
          kind: 'hub-release-metadata',
          version: approval.version,
          platform: 'win32',
          sourceSha: approval.source_sha,
          artifactSha256: approval.artifact.sha256,
          sha256: approval.metadata.sha256,
        },
      };
    }
    const candidate = approval.manifests[variantOrKind];
    const record = {
      expedRelease: {
        schemaVersion: 1,
        kind: 'hub-release-manifest',
        version: approval.version,
        platform: 'win32',
        sourceSha: approval.source_sha,
        artifactSha256: approval.artifact.sha256,
        manifestSha256: candidate.sha256,
        manifest: candidate.body,
      },
    };
    if (promotionId) record.expedRelease.promotionId = promotionId;
    return record;
  }

  function approvedRecords(fixture) {
    const { approval, artifact } = fixture;
    return new Map([
      [approval.artifact.path, {
        bytes: artifact,
        contentType: 'application/zip',
        metadata: recordAttestation(approval, 'artifact'),
      }],
      [approval.metadata.path, {
        bytes: Buffer.from(JSON.stringify(approval.metadata.body)),
        contentType: 'application/json',
        metadata: recordAttestation(approval, 'metadata'),
      }],
      ...['release', 'rollback'].map((variant) => {
        const candidate = approval.manifests[variant];
        return [candidate.path, {
          bytes: Buffer.from(JSON.stringify(candidate.body)),
          contentType: 'application/json',
          metadata: recordAttestation(approval, variant),
        }];
      }),
    ]);
  }

  function promotionFetch(fixture, {
    variant = 'release',
    requiresCopy = true,
    directiveOverrides = {},
    completionOverrides = {},
    copyStatus = 200,
    corruptCanonicalBytes = false,
    corruptCanonicalMetadata = false,
    corruptStorageDownloadBytes = false,
    attestationStatus = 200,
    attestationOverrides = {},
  } = {}) {
    const { approval } = fixture;
    const records = approvedRecords(fixture);
    const legacyZip = Buffer.from('zip legado observado');
    const legacyManifest = buildManifest(
      '0.3.20',
      `https://${PROJECT_REF}.supabase.co/storage/v1/object/public/hub-releases/0.3.20.zip`,
      sha256Buffer(legacyZip),
    );
    const candidate = approval.manifests[variant];
    let canonical = requiresCopy
      ? {
          bytes: Buffer.from(JSON.stringify(legacyManifest)),
          contentType: 'application/json',
          metadata: {},
        }
      : {
          bytes: corruptCanonicalBytes
            ? Buffer.from('corrompido')
            : Buffer.from(JSON.stringify(candidate.body)),
          contentType: 'application/json',
          metadata: corruptCanonicalMetadata
            ? {}
            : recordAttestation(approval, variant, PROMOTION_ID),
        };
    const directive = {
      manifest: candidate.body,
      source: candidate.path,
      destination: 'manifest.json',
      requiresCopy,
      promotionId: PROMOTION_ID,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      sourceSha: approval.source_sha,
      artifactSha256: approval.artifact.sha256,
      metadataSha256: approval.metadata.sha256,
      manifestSha256: candidate.sha256,
      ...directiveOverrides,
    };
    const calls = [];

    const fetchImpl = async (url, init = {}) => {
      calls.push({ url, init });
      if (url.endsWith('/rest/v1/rpc/assert_hub_release_access')) {
        return fakeResponse(200, JSON.stringify({
          role: PROMOTION_ROLE,
          subject: '00000000-0000-0000-0000-000000000002',
        }));
      }
      if (url.endsWith('/rest/v1/rpc/initialize_hub_release_promotion')) {
        return fakeResponse(200, JSON.stringify({ initialized: true }));
      }
      if (url.endsWith('/rest/v1/rpc/promote_hub_release')) {
        return fakeResponse(200, JSON.stringify(directive));
      }
      if (url.endsWith('/rest/v1/rpc/attest_hub_release_manifest_copy')) {
        return fakeResponse(attestationStatus, JSON.stringify(attestationStatus === 200 ? {
          promotionId: PROMOTION_ID,
          sourceSha: approval.source_sha,
          artifactSha256: approval.artifact.sha256,
          metadataSha256: approval.metadata.sha256,
          manifestSha256: candidate.sha256,
          observedAt: new Date().toISOString(),
          objectVersion: 'canonical-version',
          ...attestationOverrides,
        } : {
          message: 'manifest canonico nao foi materializado nesta reserva',
        }));
      }
      if (url.endsWith('/rest/v1/rpc/complete_hub_release_promotion')) {
        return fakeResponse(200, JSON.stringify({
          manifest: directive.manifest,
          requiresCopy: false,
          promotionId: PROMOTION_ID,
          sourceSha: approval.source_sha,
          artifactSha256: approval.artifact.sha256,
          metadataSha256: approval.metadata.sha256,
          manifestSha256: candidate.sha256,
          ...completionOverrides,
        }));
      }
      if (url.endsWith('/storage/v1/object/copy')) {
        if (copyStatus !== 200) return fakeResponse(copyStatus, '{"message":"copy denied"}');
        const source = records.get(JSON.parse(init.body).sourceKey);
        const encodedMetadata = requestHeader(init, 'x-metadata');
        const copiedMetadata = encodedMetadata
          ? JSON.parse(Buffer.from(encodedMetadata, 'base64').toString('utf8'))
          : source.metadata;
        canonical = {
          bytes: corruptCanonicalBytes ? Buffer.from('corrompido') : source.bytes,
          contentType: source.contentType,
          metadata: corruptCanonicalMetadata ? {} : copiedMetadata,
        };
        return fakeResponse(200, JSON.stringify({ Key: 'hub-releases/manifest.json' }));
      }
      if (url.includes('/object/info/hub-releases/')) {
        const objectPath = decodeURIComponent(
          url.split('/object/info/hub-releases/')[1].split('?')[0],
        );
        const object = objectPath === 'manifest.json' ? canonical : records.get(objectPath);
        return object
          ? objectInfoResponse(objectPath, object.bytes, object.contentType, object.metadata)
          : fakeResponse(404);
      }
      if (url.includes('/storage/v1/object/hub-releases/manifest.json')) {
        return fakeResponse(
          200,
          corruptStorageDownloadBytes ? Buffer.from('corrompido') : canonical.bytes,
        );
      }
      if (url.includes('/object/public/hub-releases/')) {
        const objectPath = decodeURIComponent(
          url.split('/object/public/hub-releases/')[1].split('?')[0],
        );
        if (objectPath === 'manifest.json') return fakeResponse(200, canonical.bytes);
        if (objectPath === '0.3.20.zip') return fakeResponse(200, legacyZip);
        const object = records.get(objectPath);
        return object ? fakeResponse(200, object.bytes) : fakeResponse(404);
      }
      return fakeResponse(500, `URL inesperada: ${url}`);
    };
    return { calls, directive, fetchImpl };
  }

  it('observa manifest legado pela API publica sem assumir user_metadata', async () => {
    expect(releaseHub.observeLegacyManifest).toBeTypeOf('function');
    const zip = Buffer.from('zip legado canonico');
    const manifest = buildManifest(
      '0.3.24',
      `https://${PROJECT_REF}.supabase.co/storage/v1/object/public/hub-releases/0.3.24.zip`,
      sha256Buffer(zip),
    );
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    const calls = [];
    const observed = await releaseHub.observeLegacyManifest(PROJECT_REF, {
      fetchImpl: async (url) => {
        calls.push(url);
        if (url.endsWith('/manifest.json')) return fakeResponse(200, manifestBytes);
        if (url.endsWith('/0.3.24.zip')) return fakeResponse(200, zip);
        return fakeResponse(500, 'URL inesperada');
      },
    });
    expect(observed).toEqual({
      manifest,
      manifestText: manifestBytes.toString('utf8'),
      manifestSha256: sha256Buffer(manifestBytes),
    });
    expect(calls).toHaveLength(3);
  });

  it('verifica artifact, inicializa legado, copia e conclui pela identidade exata', async () => {
    const fixture = approvalFixture();
    const credentials = promotionCredentials();
    const network = promotionFetch(fixture);
    try {
      const promoted = await promoteRelease(PROJECT_REF, credentials, '0.3.21', {
        ...fixture.options,
        fetchImpl: network.fetchImpl,
      });
      expect(promoted).toEqual(fixture.approval.manifests.release.body);
      const rpcCall = network.calls.find(({ url }) => url.endsWith('/promote_hub_release'));
      expect(JSON.parse(rpcCall.init.body)).toEqual({
        p_allow_downgrade: false,
        p_artifact_sha256: fixture.approval.artifact.sha256,
        p_metadata_sha256: fixture.approval.metadata.sha256,
        p_minimum_hub_version: null,
        p_project_ref: PROJECT_REF,
        p_source_sha: SOURCE_SHA,
        p_version: '0.3.21',
      });
      const copyCall = network.calls.find(({ url }) => url.endsWith('/object/copy'));
      expect(requestHeader(copyCall.init, 'x-upsert')).toBe('true');
      expect(JSON.parse(copyCall.init.body)).toEqual({
        bucketId: 'hub-releases',
        sourceKey: fixture.approval.manifests.release.path,
        destinationKey: 'manifest.json',
        copyMetadata: false,
      });
      expect(JSON.parse(Buffer.from(
        requestHeader(copyCall.init, 'x-metadata'),
        'base64',
      ).toString('utf8'))).toEqual(
        recordAttestation(fixture.approval, 'release', PROMOTION_ID),
      );
      const completeCall = network.calls.find(({ url }) => url.endsWith('/complete_hub_release_promotion'));
      const attestCall = network.calls.find(
        ({ url }) => url.endsWith('/attest_hub_release_manifest_copy'),
      );
      expect(JSON.parse(attestCall.init.body)).toEqual({
        p_promotion_id: PROMOTION_ID,
      });
      expect(JSON.parse(completeCall.init.body)).toEqual({
        p_promotion_id: PROMOTION_ID,
      });
      expect(network.calls.indexOf(attestCall)).toBeLessThan(network.calls.indexOf(completeCall));
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('promocao comprova a role opaca antes de ler objetos autenticados', async () => {
    const fixture = approvalFixture();
    const network = promotionFetch(fixture);
    try {
      await promoteRelease(
        PROJECT_REF,
        { releaseKey: PROMOTION_RELEASE_KEY },
        '0.3.21',
        { ...fixture.options, fetchImpl: network.fetchImpl },
      );
      const [accessCall] = network.calls;
      expect(accessCall.url).toContain('/rest/v1/rpc/assert_hub_release_access');
      expect(JSON.parse(accessCall.init.body)).toEqual({
        p_expected_role: PROMOTION_ROLE,
      });
      expect(requestHeader(accessCall.init, 'apikey')).toBe(PROMOTION_RELEASE_KEY);
      const copyCall = network.calls.find(({ url }) => url.endsWith('/object/copy'));
      expect(requestHeader(copyCall.init, 'apikey')).toBe(PROMOTION_RELEASE_KEY);
      expect(requestHeader(copyCall.init, 'authorization')).toBe(
        `Bearer ${PROMOTION_RELEASE_KEY}`,
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('promocao falha fechado sem tocar o Storage quando a prova opaca falha', async () => {
    const fixture = approvalFixture();
    const calls = [];
    try {
      await expect(promoteRelease(
        PROJECT_REF,
        { releaseKey: PROMOTION_RELEASE_KEY },
        '0.3.21',
        {
          ...fixture.options,
          fetchImpl: async (url, init = {}) => {
            calls.push({ url, init });
            return fakeResponse(403, JSON.stringify({ message: 'permission denied' }));
          },
        },
      )).rejects.toThrow('credencial de release nao comprovou');
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain('/rest/v1/rpc/assert_hub_release_access');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rollback usa somente o candidato aprovado com metadata de downgrade', async () => {
    const fixture = approvalFixture();
    const network = promotionFetch(fixture, { variant: 'rollback' });
    try {
      const promoted = await promoteRelease(PROJECT_REF, promotionCredentials(), '0.3.21', {
        ...fixture.options,
        allowDowngrade: true,
        minimumHubVersion: '0.3.21',
        fetchImpl: network.fetchImpl,
      });
      expect(promoted).toEqual(fixture.approval.manifests.rollback.body);
      const copyCall = network.calls.find(({ url }) => url.endsWith('/object/copy'));
      expect(JSON.parse(copyCall.init.body).sourceKey).toBe(
        fixture.approval.manifests.rollback.path,
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('reexecucao com a mesma identidade nao tenta copiar nem concluir', async () => {
    const fixture = approvalFixture();
    const network = promotionFetch(fixture, { requiresCopy: false });
    try {
      await promoteRelease(PROJECT_REF, promotionCredentials(), '0.3.21', {
        ...fixture.options,
        fetchImpl: network.fetchImpl,
      });
      expect(network.calls.some(({ url }) => url.endsWith('/object/copy'))).toBe(false);
      expect(network.calls.some(({ url }) => url.endsWith('/complete_hub_release_promotion')))
        .toBe(false);
      expect(network.calls.some(({ url }) => (
        url.includes('/storage/v1/object/hub-releases/manifest.json')
      ))).toBe(true);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('reexecucao idempotente falha se o objeto canonico nao materializa o aprovado', async () => {
    const fixture = approvalFixture();
    const network = promotionFetch(fixture, {
      requiresCopy: false,
      corruptStorageDownloadBytes: true,
    });
    try {
      await expect(promoteRelease(PROJECT_REF, promotionCredentials(), '0.3.21', {
        ...fixture.options,
        fetchImpl: network.fetchImpl,
      })).rejects.toThrow('manifest canonico no Storage possui bytes diferentes');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejeita directive que tente apontar para ZIP externo', async () => {
    const fixture = approvalFixture();
    const network = promotionFetch(fixture, {
      directiveOverrides: {
        manifest: {
          ...fixture.approval.manifests.release.body,
          url: 'https://evil.example/payload.zip',
        },
      },
    });
    try {
      await expect(promoteRelease(PROJECT_REF, promotionCredentials(), '0.3.21', {
        ...fixture.options,
        fetchImpl: network.fetchImpl,
      })).rejects.toThrow('RPC retornou URL nao canonica');
      expect(network.calls.some(({ url }) => url.endsWith('/object/copy'))).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('falha fechado quando a Storage API recusa a copia canonica', async () => {
    const fixture = approvalFixture();
    const network = promotionFetch(fixture, { copyStatus: 409 });
    try {
      await expect(promoteRelease(PROJECT_REF, promotionCredentials(), '0.3.21', {
        ...fixture.options,
        fetchImpl: network.fetchImpl,
      })).rejects.toThrow('copia canonica do manifest HTTP 409');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('nao conclui se a copia canonica tiver bytes inconsistentes', async () => {
    const fixture = approvalFixture();
    const network = promotionFetch(fixture, { corruptCanonicalBytes: true });
    try {
      await expect(promoteRelease(PROJECT_REF, promotionCredentials(), '0.3.21', {
        ...fixture.options,
        fetchImpl: network.fetchImpl,
      })).rejects.toThrow('copia canonica materializou bytes diferentes');
      expect(network.calls.some(({ url }) => url.endsWith('/complete_hub_release_promotion')))
        .toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('nao conclui se a copia perder a atestacao do candidato', async () => {
    const fixture = approvalFixture();
    const network = promotionFetch(fixture, { corruptCanonicalMetadata: true });
    try {
      await expect(promoteRelease(PROJECT_REF, promotionCredentials(), '0.3.21', {
        ...fixture.options,
        fetchImpl: network.fetchImpl,
      })).rejects.toThrow('manifest.json possui atestacao inconsistente');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('nao conclui quando o banco nao atesta a copia materializada nesta reserva', async () => {
    const fixture = approvalFixture();
    const network = promotionFetch(fixture, { attestationStatus: 409 });
    try {
      await expect(promoteRelease(PROJECT_REF, promotionCredentials(), '0.3.21', {
        ...fixture.options,
        fetchImpl: network.fetchImpl,
      })).rejects.toThrow('atestado da copia canonica falhou');
      expect(network.calls.some(({ url }) => url.endsWith('/complete_hub_release_promotion')))
        .toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('recusa service_role antes de ler approval ou chamar a rede', async () => {
    let fetches = 0;
    await expect(promoteRelease(PROJECT_REF, {
      anonKey: ANON_KEY,
      accessToken: tokenForRole('service_role'),
    }, '0.3.21', {
      fetchImpl: async () => { fetches += 1; return fakeResponse(500); },
      logger: { log() {} },
    })).rejects.toThrow('service_role');
    expect(fetches).toBe(0);
  });

  it('promote exige identidade e arquivos do artifact aprovado antes da rede', async () => {
    let fetches = 0;
    await expect(promoteRelease(PROJECT_REF, promotionCredentials(), '0.3.21', {
      fetchImpl: async () => { fetches += 1; return fakeResponse(500); },
      logger: { log() {} },
    })).rejects.toThrow('source_sha aprovado invalido');
    expect(fetches).toBe(0);
  });
});

describe('release-hub limite do pacote', () => {
  it.skipIf(process.platform === 'win32')(
    'copia somente standalone, static, public e migrations preservando symlinks relativos',
    () => {
      const root = mkdtempSync(path.join(tmpdir(), 'exped-release-'));
      const put = (relative, content = relative) => {
        const file = path.join(root, relative);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, content);
      };

      try {
        put('.next/standalone/server.js');
        put('.next/static/chunk.js');
        put('public/logo.png');
        put('supabase/migrations/001.sql');
        symlinkSync('chunk.js', path.join(root, '.next/static/chunk-link.js'));
        symlinkSync('logo.png', path.join(root, 'public/logo-link.png'));
        symlinkSync('001.sql', path.join(root, 'supabase/migrations/latest.sql'));
        put('hub/sync.mjs');
        put('scripts/win/install.ps1');
        put('agent/ExpedAgent.exe');

        const out = montarRelease('0.3.21', { root });
        expect(existsSync(path.join(out, 'server.js'))).toBe(true);
        expect(existsSync(path.join(out, '.next/static/chunk.js'))).toBe(true);
        expect(existsSync(path.join(out, 'public/logo.png'))).toBe(true);
        expect(existsSync(path.join(out, 'supabase/migrations/001.sql'))).toBe(true);
        expect(lstatSync(path.join(out, '.next/static/chunk-link.js')).isFile()).toBe(true);
        expect(lstatSync(path.join(out, 'public/logo-link.png')).isFile()).toBe(true);
        expect(lstatSync(path.join(out, 'supabase/migrations/latest.sql')).isFile()).toBe(true);
        expect(readFileSync(path.join(out, '.next/static/chunk-link.js'), 'utf8')).toBe(
          '.next/static/chunk.js',
        );
        expect(readFileSync(path.join(out, 'public/logo-link.png'), 'utf8')).toBe(
          'public/logo.png',
        );
        expect(readFileSync(path.join(out, 'supabase/migrations/latest.sql'), 'utf8')).toBe(
          'supabase/migrations/001.sql',
        );
        expect(existsSync(path.join(out, 'hub'))).toBe(false);
        expect(existsSync(path.join(out, 'scripts'))).toBe(false);
        expect(existsSync(path.join(out, 'agent'))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')('rejeita symlink relativo para fora do pacote', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'exped-release-external-'));
    const put = (relative, content = relative) => {
      const file = path.join(root, relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
    };

    try {
      put('.next/standalone/server.js');
      put('.next/static/chunk.js');
      put('supabase/migrations/001.sql');
      put('private.txt', 'nao deve entrar');
      symlinkSync('../../private.txt', path.join(root, '.next/static/external.txt'));

      expect(() => montarRelease('0.3.21', { root }))
        .toThrow('symlink quebrado ou externo proibido');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('workflows de release', () => {
  it('stage manual isola build da tag e executa tooling confiavel com segredo no step', () => {
    const workflow = readFileSync(
      path.join(ROOT, '.github/workflows/release-hub.yml'),
      'utf8',
    ).replace(/\r\n?/g, '\n');
    const buildSection = workflow.match(/\n  build:\n([\s\S]*?)\n  stage:\n/)?.[1] || '';
    const stageSection = workflow.split('\n  stage:\n')[1] || '';

    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toMatch(/\n\s+push:/);
    expect(workflow).toContain('ref: refs/tags/${{ inputs.tag }}');
    expect(workflow).toContain('path: source');
    expect(workflow).toContain('EXPECTED_TAG_REF="refs/tags/$SOURCE_TAG"');
    expect(workflow).toContain('fetch-depth: 0');
    expect(workflow).toMatch(/merge-base --is-ancestor "\$TAG_COMMIT" "origin\/\$DEFAULT_BRANCH"/);
    expect(workflow).toContain('git rev-parse "$EXPECTED_TAG_REF^{commit}"');
    expect(workflow).toContain('git rev-parse HEAD');
    expect(buildSection).not.toContain('secrets.');
    expect(buildSection).not.toContain('SUPABASE_RELEASE_KEY');
    expect(stageSection).toContain('needs: build');
    expect(stageSection).toContain('environment: hub-stage');
    expect(stageSection).toContain('ref: ${{ github.sha }}');
    expect(stageSection).not.toContain(
      'ref: ${{ github.event.repository.default_branch }}',
    );
    expect(stageSection).toContain('path: tooling');
    expect(stageSection).toContain('working-directory: tooling');
    expect(stageSection).toContain('RELEASE_SOURCE_ROOT: ${{ github.workspace }}/source');
    expect(stageSection).toContain(
      'SUPABASE_RELEASE_KEY: ${{ secrets.HUB_STAGE_SUPABASE_RELEASE_KEY }}',
    );
    expect(stageSection).not.toContain('SUPABASE_ACCESS_TOKEN');
    expect(stageSection).not.toContain('SUPABASE_ANON_KEY');
    expect(workflow).toContain('runs-on: windows-latest');
    expect(workflow).toContain('actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5');
    expect(workflow).toContain('actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020');
    expect(workflow).toContain('actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02');
    expect(workflow).toContain('actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093');
    expect(workflow).toContain("node-version: '24.18.0'");
    expect(workflow).not.toMatch(/uses:\s+actions\/[^@\s]+@v\d/);
    expect(workflow).toContain('node scripts/release-hub.mjs stage "$RELEASE_VERSION"');
    expect(workflow).not.toContain('node scripts/release-hub.mjs promote');
    expect(workflow).not.toMatch(/SERVICE_ROLE|\bSR:/);
    expect(workflow).toMatch(
      /name: Install pinned Info-ZIP[\s\S]*choco install zip --version=3\.0\.0\.20251001 --yes --no-progress/,
    );
    expect(workflow).toMatch(
      /name: Stage release ZIP[\s\S]*shell: bash[\s\S]*export PATH="\/usr\/bin:\$PATH"[\s\S]*command -v zip/,
    );
  });

  it('promocao usa tooling da branch default e flag explicita de rollback', () => {
    const workflow = readFileSync(path.join(ROOT, '.github/workflows/promote-hub.yml'), 'utf8');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('ref: ${{ github.sha }}');
    expect(workflow).not.toContain(
      'ref: ${{ github.event.repository.default_branch }}',
    );
    expect(workflow).not.toMatch(/ref:\s*v\$\{\{\s*inputs\.version/);
    expect(workflow).toContain('environment: hub-promotion');
    expect(workflow).toContain('stage_run_id:');
    expect(workflow).toContain('source_sha:');
    expect(workflow).toContain('artifact_sha256:');
    expect(workflow).toContain('actions: read');
    expect(workflow).toContain('run-id: ${{ inputs.stage_run_id }}');
    expect(workflow).toContain('name: hub-release-${{ inputs.source_sha }}');
    expect(workflow).toContain(
      'SUPABASE_RELEASE_KEY: ${{ secrets.HUB_PROMOTION_SUPABASE_RELEASE_KEY }}',
    );
    expect(workflow).not.toContain('SUPABASE_ACCESS_TOKEN');
    expect(workflow).not.toContain('SUPABASE_ANON_KEY');
    expect(workflow).not.toContain('HUB_STAGE_SUPABASE_RELEASE_KEY');
    expect(workflow).not.toMatch(/SERVICE_ROLE|\bSR:/);
    expect(workflow).toContain('ALLOW_DOWNGRADE');
    expect(workflow).toContain('--allow-downgrade');
    expect(workflow).toContain('confirm_hub_0_3_21_or_newer');
    expect(workflow).toContain('--confirm-hub-version');
    expect(workflow).toContain('MINIMUM_HUB_VERSION: 0.3.21');
    expect(workflow).toContain('node scripts/release-hub.mjs "${ARGS[@]}"');
    expect(workflow).toContain('group: promote-hub');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain('actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5');
    expect(workflow).toContain('actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020');
    expect(workflow).toContain("node-version: '24.18.0'");
    expect(workflow).not.toMatch(/uses:\s+actions\/[^@\s]+@v\d/);
  });
});
