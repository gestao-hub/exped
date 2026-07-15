import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { buildManifest, buildReleaseApproval } from '../release-hub.mjs';

const DATABASE_URL = process.env.HUB_RELEASE_TEST_DATABASE_URL;
const PROJECT_REF = 'abcdefghijklmnopqrst';

function assertLocalTestDatabase(databaseUrl) {
  const parsed = new URL(databaseUrl);
  const database = parsed.pathname.slice(1);
  if (
    !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)
    || (
      !/(test|codex)/i.test(database)
      && !(database === 'postgres' && process.env.HUB_RELEASE_TEST_ALLOW_POSTGRES === '1')
    )
  ) {
    throw new Error('HUB_RELEASE_TEST_DATABASE_URL deve apontar para banco local de teste');
  }
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runPsql(sql) {
  const result = spawnSync(
    'psql',
    [DATABASE_URL, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'],
    { encoding: 'utf8', input: sql },
  );
  if (result.status !== 0) {
    throw new Error(`psql falhou: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function spawnPsql(sql, onStdout) {
  const child = spawn('psql', [DATABASE_URL, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1']);
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    onStdout?.(stdout);
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(sql);
  const completed = new Promise((resolve) => {
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  return { child, completed };
}

const describePostgres = DATABASE_URL ? describe : describe.skip;

describePostgres('release-hub PostgreSQL concurrency', () => {
  it('serializa duas promocoes reais e preserva o primeiro pending', async () => {
    assertLocalTestDatabase(DATABASE_URL);
    const suffix = String(process.pid % 100000);
    const currentVersion = `90.0.${suffix}`;
    const firstVersion = `90.1.${suffix}`;
    const secondVersion = `90.2.${suffix}`;
    const firstSourceSha = '8'.repeat(40);
    const secondSourceSha = '9'.repeat(40);
    const firstArtifactSha256 = 'a'.repeat(64);
    const secondArtifactSha256 = 'b'.repeat(64);
    const firstApproval = buildReleaseApproval(
      PROJECT_REF,
      firstVersion,
      firstSourceSha,
      firstArtifactSha256,
    );
    const secondApproval = buildReleaseApproval(
      PROJECT_REF,
      secondVersion,
      secondSourceSha,
      secondArtifactSha256,
    );
    const currentManifest = buildManifest(
      currentVersion,
      `https://${PROJECT_REF}.supabase.co/storage/v1/object/public/hub-releases/windows/${currentVersion}.zip`,
      'c'.repeat(64),
    );
    const currentManifestText = JSON.stringify(currentManifest);
    const currentManifestSha256 = createHash('sha256')
      .update(currentManifestText)
      .digest('hex');
    const clearPending = `
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
      pending_expires_at = null
    `;

    runPsql(`
      begin;
      delete from private.hub_release_artifacts
      where version in (${sqlLiteral(firstVersion)}, ${sqlLiteral(secondVersion)});
      update private.hub_release_promotion_state set
        initialized = true,
        current_promotion_id = null,
        current_version = ${sqlLiteral(currentVersion)},
        current_source_sha = null,
        current_artifact_sha256 = null,
        current_metadata_sha256 = null,
        current_manifest = ${sqlLiteral(currentManifestText)}::jsonb,
        current_manifest_sha256 = ${sqlLiteral(currentManifestSha256)},
        ${clearPending}
      where singleton;
      select set_config(
        'request.jwt.claims',
        '{"role":"exped_hub_release_stage","sub":"00000000-0000-0000-0000-000000000031"}',
        true
      );
      set local role exped_hub_release_stage;
      select public.register_hub_release_artifact(
        ${sqlLiteral(PROJECT_REF)},
        ${sqlLiteral(JSON.stringify(firstApproval))}::jsonb
      );
      select public.register_hub_release_artifact(
        ${sqlLiteral(PROJECT_REF)},
        ${sqlLiteral(JSON.stringify(secondApproval))}::jsonb
      );
      commit;
    `);

    let firstSession;
    try {
      let markLocked;
      const locked = new Promise((resolve) => { markLocked = resolve; });
      firstSession = spawnPsql(`
        begin;
        select singleton
        from private.hub_release_promotion_state
        where singleton
        for update;
        \\echo HUB_RELEASE_LOCKED
        select pg_catalog.pg_sleep(0.8);
        select set_config(
          'request.jwt.claims',
          '{"role":"exped_hub_release_promote","sub":"00000000-0000-0000-0000-000000000041"}',
          true
        );
        set local role exped_hub_release_promote;
        select public.promote_hub_release(
          ${sqlLiteral(PROJECT_REF)},
          ${sqlLiteral(firstVersion)},
          ${sqlLiteral(firstSourceSha)},
          ${sqlLiteral(firstArtifactSha256)},
          ${sqlLiteral(firstApproval.metadata.sha256)},
          false,
          null
        );
        commit;
      `, (stdout) => {
        if (stdout.includes('HUB_RELEASE_LOCKED')) markLocked();
      });

      await Promise.race([
        locked,
        new Promise((_, reject) => setTimeout(
          () => reject(new Error('primeira sessao nao adquiriu o lock')), 3000,
        )),
      ]);

      const startedAt = Date.now();
      const secondSession = spawnPsql(`
        begin;
        select set_config(
          'request.jwt.claims',
          '{"role":"exped_hub_release_promote","sub":"00000000-0000-0000-0000-000000000042"}',
          true
        );
        set local role exped_hub_release_promote;
        select public.promote_hub_release(
          ${sqlLiteral(PROJECT_REF)},
          ${sqlLiteral(secondVersion)},
          ${sqlLiteral(secondSourceSha)},
          ${sqlLiteral(secondArtifactSha256)},
          ${sqlLiteral(secondApproval.metadata.sha256)},
          false,
          null
        );
        commit;
      `);

      const [firstResult, secondResult] = await Promise.all([
        firstSession.completed,
        secondSession.completed,
      ]);
      expect(firstResult.status, firstResult.stderr).toBe(0);
      expect(secondResult.status).not.toBe(0);
      expect(secondResult.stderr).toContain(`promocao ${firstVersion} ja esta em andamento`);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(500);
      expect(runPsql(`
        select pending_version
        from private.hub_release_promotion_state
        where singleton;
      `)).toBe(firstVersion);
    } finally {
      firstSession?.child.kill('SIGTERM');
      runPsql(`
        begin;
        delete from private.hub_release_artifacts
        where version in (${sqlLiteral(firstVersion)}, ${sqlLiteral(secondVersion)});
        update private.hub_release_promotion_state set
          initialized = false,
          current_promotion_id = null,
          current_version = null,
          current_source_sha = null,
          current_artifact_sha256 = null,
          current_metadata_sha256 = null,
          current_manifest = null,
          current_manifest_sha256 = null,
          ${clearPending}
        where singleton;
        commit;
      `);
    }
  }, 10_000);
});
