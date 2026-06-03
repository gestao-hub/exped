import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { exe } from './platform.mjs';

const execFileAsync = promisify(execFile);

/**
 * Bootstrap idempotente do banco do app (exped) num Postgres local nativo.
 * Porta da ordem REAL do Supabase validada no spike (apply-schema.sh):
 *
 *   1. cria o banco (se não existe)
 *   2. 00-roles-ext.sql ...... extensões + roles + supabase_auth_admin + schema auth vazio
 *   3. GoTrue `migrate` ...... cria auth.users + tabelas do auth
 *   4. 00-prelude-helpers.sql . helpers auth.uid()/role()/jwt() + grants + storage/realtime shim
 *   5. supabase/migrations/*  . schema do app + RLS
 *
 * Em DB já existente: aplica só as migrations do app ainda não registradas em
 * public._hub_migrations. Rodar 2x não quebra.
 *
 * Toda comunicação com o Postgres é via execFile do `psql`; o migrate do auth
 * via execFile do binário GoTrue (lendo gotrue.env). Sem libs novas.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function resolveRoot(p) {
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

/** args base do psql a partir da cfg (porta/host/db/user) */
function psqlArgs(cfg, { db, dbOverride } = {}) {
  const targetDb = dbOverride || db || cfg.paths.db;
  return [
    '-p', String(cfg.ports.pg),
    '-h', cfg.paths.pgHost,
    '-U', cfg.paths.user || 'postgres',
    '-d', targetDb,
  ];
}

// PGCLIENTENCODING=UTF8: garante que o psql leia o SQL (UTF-8 vindo do Node) corretamente,
// inclusive no Windows (onde o codepage do console corromperia acentos).
const PSQL_ENV = { ...process.env, PGPASSWORD: process.env.PGPASSWORD || '', PGCLIENTENCODING: 'UTF8' };

/** roda psql -c (uma instrução), retorna stdout trimado */
async function psqlCmd(cfg, sql, { dbOverride } = {}) {
  const { stdout } = await execFileAsync(
    'psql',
    [...psqlArgs(cfg, { dbOverride }), '-v', 'ON_ERROR_STOP=1', '-tAc', sql],
    { env: PSQL_ENV, maxBuffer: 1024 * 1024 * 16 },
  );
  return stdout.trim();
}

/** roda psql -f num arquivo .sql */
async function psqlFile(cfg, file, { dbOverride } = {}) {
  await execFileAsync(
    'psql',
    [...psqlArgs(cfg, { dbOverride }), '-v', 'ON_ERROR_STOP=1', '-f', file],
    { env: PSQL_ENV, maxBuffer: 1024 * 1024 * 16 },
  );
}

async function dbExists(cfg, name) {
  const out = await psqlCmd(cfg, `select 1 from pg_database where datname='${name}'`, {
    dbOverride: 'postgres',
  });
  return out === '1';
}

async function createDb(cfg, name) {
  await psqlCmd(cfg, `create database "${name}"`, { dbOverride: 'postgres' });
}

/** carrega gotrue.env como objeto (KEY=VALUE, ignora comentários/linhas vazias) */
function loadGotrueEnv(cfg) {
  const file = path.join(resolveRoot(cfg.paths.sqlDir), 'gotrue.env');
  const env = {};
  if (!existsSync(file)) return env;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // tira aspas externas (gotrue.env usa aspas no DATABASE_URL)
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

/** roda o GoTrue migrate, apontando para o DB alvo desta bootstrap */
async function gotrueMigrate(cfg, targetDb) {
  const authBin = exe(resolveRoot(cfg.paths.authBin));
  const gtEnv = loadGotrueEnv(cfg);
  // garante driver e DATABASE_URL coerentes com a cfg/DB alvo (override do env do spike)
  gtEnv.GOTRUE_DB_DRIVER = gtEnv.GOTRUE_DB_DRIVER || 'postgres';
  const host = cfg.paths.pgHost.startsWith('/') ? '127.0.0.1' : cfg.paths.pgHost;
  gtEnv.DATABASE_URL =
    `postgres://supabase_auth_admin:authpass@${host}:${cfg.ports.pg}/${targetDb}` +
    `?search_path=auth&sslmode=disable`;
  // caminho das migrations do auth (relativo ao ROOT)
  if (gtEnv.GOTRUE_DB_MIGRATIONS_PATH) {
    gtEnv.GOTRUE_DB_MIGRATIONS_PATH = resolveRoot(gtEnv.GOTRUE_DB_MIGRATIONS_PATH);
  }
  await execFileAsync(authBin, ['migrate'], {
    cwd: ROOT,
    env: { ...process.env, ...gtEnv },
    maxBuffer: 1024 * 1024 * 16,
  });
}

/** lista as migrations (.sql) de um diretório, em ordem alfabética (= cronológica) */
export function listMigrations(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ name: f, file: path.join(dir, f) }));
}

async function ensureHubMigrationsTable(cfg, targetDb) {
  await psqlCmd(
    cfg,
    'create table if not exists public._hub_migrations ' +
      '(name text primary key, applied_at timestamptz default now())',
    { dbOverride: targetDb },
  );
}

async function appliedMigrations(cfg, targetDb) {
  const out = await psqlCmd(cfg, 'select name from public._hub_migrations', {
    dbOverride: targetDb,
  });
  return new Set(out ? out.split('\n').map((s) => s.trim()).filter(Boolean) : []);
}

async function recordMigration(cfg, targetDb, name) {
  await psqlCmd(
    cfg,
    `insert into public._hub_migrations(name) values ('${name}') on conflict do nothing`,
    { dbOverride: targetDb },
  );
}

/**
 * Aplica as migrations do app ainda não registradas (em `_hub_migrations`) e registra cada uma.
 * `migrationsDir` default = o dir do install (cfg.paths.migrationsDir); o auto-update passa o dir da release.
 */
export async function applyPendingMigrations(cfg, targetDb, migrationsDir = resolveRoot(cfg.paths.migrationsDir)) {
  await ensureHubMigrationsTable(cfg, targetDb);
  const done = await appliedMigrations(cfg, targetDb);
  for (const m of listMigrations(migrationsDir)) {
    if (done.has(m.name)) continue;
    await psqlFile(cfg, m.file, { dbOverride: targetDb });
    await recordMigration(cfg, targetDb, m.name);
  }
}

/**
 * Bootstrap principal. Idempotente.
 */
export async function bootstrap(cfg) {
  const db = cfg.paths.db;
  const sqlDir = resolveRoot(cfg.paths.sqlDir);
  const rolesExt = path.join(sqlDir, '00-roles-ext.sql');
  const prelude = path.join(sqlDir, '00-prelude-helpers.sql');

  const fresh = !(await dbExists(cfg, db));

  if (fresh) {
    // (1) cria o banco
    await createDb(cfg, db);
    // (2) roles + extensões + schema auth vazio
    await psqlFile(cfg, rolesExt, { dbOverride: db });
    // (3) GoTrue migrate (cria auth.users)
    await gotrueMigrate(cfg, db);
    // (4) helpers auth.* + grants + storage/realtime shim
    await psqlFile(cfg, prelude, { dbOverride: db });
    // (5) migrations do app (registra cada uma)
    await applyPendingMigrations(cfg, db);
  } else {
    // DB já existe: aplica só as migrations do app que faltam
    await applyPendingMigrations(cfg, db);
  }

  return { db, fresh };
}

export default bootstrap;
