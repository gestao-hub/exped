/**
 * Configuração do hub local do Exped. Um objeto de defaults + merge raso com
 * overrides (e algumas envs). Mantido propositalmente simples.
 */

const DEFAULTS = {
  ports: {
    pg: 54329,
    postgrest: 54331,
    gotrue: 9999,
    gateway: 54320,
    storage: 5402,
    app: 3000,
  },
  paths: {
    // Em Linux usamos o socket dir do cluster do spike; em Windows o maestro
    // sobrescreve para 127.0.0.1 via overrides/env.
    pgHost: '/tmp/exped-pg',
    db: 'exped',
    user: 'postgres',
    migrationsDir: 'supabase/migrations',
    sqlDir: 'scripts/local-stack',
    authBin: 'scripts/local-stack/bin/auth',
  },
  jwtSecret: 'exped-local-super-secret-jwt-with-at-least-32-chars',
  manifestUrl: null,
};

/** merge raso preservando os sub-objetos ports/paths */
function shallowMerge(base, over = {}) {
  const out = { ...base, ...over };
  out.ports = { ...base.ports, ...(over.ports || {}) };
  out.paths = { ...base.paths, ...(over.paths || {}) };
  return out;
}

/**
 * Carrega a config: defaults <- env <- overrides (overrides têm prioridade).
 */
export function loadConfig(overrides = {}) {
  const env = {};
  const ports = {};
  const paths = {};

  if (process.env.EXPED_PG_PORT) ports.pg = Number(process.env.EXPED_PG_PORT);
  if (process.env.EXPED_POSTGREST_PORT) ports.postgrest = Number(process.env.EXPED_POSTGREST_PORT);
  if (process.env.EXPED_GOTRUE_PORT) ports.gotrue = Number(process.env.EXPED_GOTRUE_PORT);
  if (process.env.EXPED_GATEWAY_PORT) ports.gateway = Number(process.env.EXPED_GATEWAY_PORT);
  if (process.env.EXPED_STORAGE_PORT) ports.storage = Number(process.env.EXPED_STORAGE_PORT);
  if (process.env.EXPED_APP_PORT) ports.app = Number(process.env.EXPED_APP_PORT);

  if (process.env.EXPED_PG_HOST) paths.pgHost = process.env.EXPED_PG_HOST;
  if (process.env.EXPED_DB) paths.db = process.env.EXPED_DB;
  if (process.env.EXPED_DB_USER) paths.user = process.env.EXPED_DB_USER;

  if (process.env.EXPED_JWT_SECRET) env.jwtSecret = process.env.EXPED_JWT_SECRET;
  if (process.env.EXPED_MANIFEST_URL) env.manifestUrl = process.env.EXPED_MANIFEST_URL;

  if (Object.keys(ports).length) env.ports = ports;
  if (Object.keys(paths).length) env.paths = paths;

  return shallowMerge(shallowMerge(DEFAULTS, env), overrides);
}

export default loadConfig;
