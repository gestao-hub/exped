import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig } from '../config.mjs';
import { bootstrap } from '../bootstrap.mjs';

const execFileAsync = promisify(execFile);

// DB de teste isolado (NÃO o 'exped' do spike). Dropado no começo e no fim.
const TEST_DB = 'exped_boot_test';

const cfg = loadConfig({
  jwtSecret: 'segredo-de-teste-bootstrap-com-mais-de-32-chars',
  paths: {
    db: TEST_DB,
    pgHost: '/tmp/exped-pg',
    user: 'postgres',
    authBin: 'scripts/local-stack/bin/auth',
  },
  ports: { pg: 54329 },
});

const PSQL_BASE = ['-p', '54329', '-h', '/tmp/exped-pg', '-U', 'postgres'];

/** Checa (1x) se há um Postgres acessível pros testes de integração. Sem ele, pulamos (CI). */
async function psqlDisponivel() {
  try {
    await execFileAsync('psql', [...PSQL_BASE, '-d', 'postgres', '-c', 'select 1'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
const TEM_PSQL = await psqlDisponivel();
if (!TEM_PSQL) console.warn('[bootstrap.test] psql indisponível — pulando testes de integração.');

async function psqlPostgres(sql) {
  const { stdout } = await execFileAsync(
    'psql',
    [...PSQL_BASE, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-tAc', sql],
    { maxBuffer: 1024 * 1024 * 16 },
  );
  return stdout.trim();
}

async function dropTestDb() {
  await psqlPostgres(
    `select pg_terminate_backend(pid) from pg_stat_activity ` +
      `where datname='${TEST_DB}' and pid<>pg_backend_pid()`,
  );
  await psqlPostgres(`drop database if exists ${TEST_DB}`);
}

async function tableExists(table) {
  const { stdout } = await execFileAsync(
    'psql',
    [
      ...PSQL_BASE,
      '-d',
      TEST_DB,
      '-tAc',
      `select to_regclass('public.${table}') is not null`,
    ],
    { maxBuffer: 1024 * 1024 * 16 },
  );
  return stdout.trim() === 't';
}

describe.skipIf(!TEM_PSQL)('bootstrap (Node, ordem do spike)', () => {
  beforeAll(async () => {
    await dropTestDb();
  }, 60_000);

  afterAll(async () => {
    await dropTestDb();
  }, 60_000);

  it('cria o DB do zero e aplica auth + schema do app', async () => {
    const res = await bootstrap(cfg);
    expect(res.fresh).toBe(true);

    expect(await tableExists('empresas')).toBe(true);
    expect(await tableExists('profiles')).toBe(true);
    expect(await tableExists('ordens_servico')).toBe(true);

    // auth.users veio do GoTrue migrate
    const authUsers = await execFileAsync(
      'psql',
      [...PSQL_BASE, '-d', TEST_DB, '-tAc', "select to_regclass('auth.users') is not null"],
      { maxBuffer: 1024 * 1024 * 16 },
    );
    expect(authUsers.stdout.trim()).toBe('t');
  }, 120_000);

  it('é idempotente: rodar de novo não lança e o DB já existe', async () => {
    const res = await bootstrap(cfg);
    expect(res.fresh).toBe(false);
    expect(await tableExists('empresas')).toBe(true);
  }, 120_000);
});
