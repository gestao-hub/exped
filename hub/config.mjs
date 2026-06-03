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
    // pgData: DIRETORIO DE DADOS do cluster (pg_ctl -D <pgData>).
    // pgHost: HOST DE CONEXAO (psql/PostgREST/GoTrue). Em Linux ambos default
    // para o socket dir do cluster do spike (conexao via socket Unix). Em
    // Windows separam: pgData = C:\Exped\data\pg, pgHost = 127.0.0.1 (TCP).
    pgData: '/tmp/exped-pg',
    pgHost: '/tmp/exped-pg',
    db: 'exped',
    user: 'postgres',
    migrationsDir: 'supabase/migrations',
    sqlDir: 'scripts/local-stack',
    authBin: 'scripts/local-stack/bin/auth',
    releasesDir: 'releases',
    releasesPtr: 'releases/current',
  },
  version: '0.0.0', // versão base instalada; o instalador carimba a real (de package.json) no config.json
  manifestUrl: null,
  // Sync com a nuvem (sub-projeto 3). Se apiBase E deviceToken presentes, o
  // maestro liga o cliente de sync; ausentes => modo ilha (hub roda sem sync,
  // não quebra).
  cloud: {
    apiBase: null, // EXPED_CLOUD_API — base da API de sync (ex.: https://app.exped.com.br)
    deviceToken: null, // EXPED_DEVICE_TOKEN — token do dispositivo (Bearer)
    syncIntervalMs: 10000, // EXPED_SYNC_INTERVAL_MS
  },
};

/** Placeholder histórico (segredo conhecido) — NUNCA aceitar como secret real. */
const JWT_PLACEHOLDER = 'exped-local-super-secret-jwt-with-at-least-32-chars';

/**
 * Resolve e valida o jwtSecret. Ordem: overrides.jwtSecret -> EXPED_JWT_SECRET.
 * Lança se ausente, igual ao placeholder conhecido, ou com menos de 32 chars.
 */
function resolveJwtSecret(overrides) {
  const secret = overrides.jwtSecret ?? process.env.EXPED_JWT_SECRET;
  if (!secret || secret === JWT_PLACEHOLDER || secret.length < 32) {
    throw new Error(
      'EXPED_JWT_SECRET ausente/placeholder: defina um segredo forte (>=32 chars) por instalação',
    );
  }
  return secret;
}

/** merge raso preservando os sub-objetos ports/paths */
function shallowMerge(base, over = {}) {
  const out = { ...base, ...over };
  out.ports = { ...base.ports, ...(over.ports || {}) };
  out.paths = { ...base.paths, ...(over.paths || {}) };
  out.cloud = { ...base.cloud, ...(over.cloud || {}) };
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

  // pgData (diretorio de dados) e pgHost (host de conexao) sao independentes.
  // Se EXPED_PG_DATA nao vier, pgData mantem o default — NUNCA herda EXPED_PG_HOST.
  if (process.env.EXPED_PG_DATA) paths.pgData = process.env.EXPED_PG_DATA;
  if (process.env.EXPED_PG_HOST) paths.pgHost = process.env.EXPED_PG_HOST;
  if (process.env.EXPED_DB) paths.db = process.env.EXPED_DB;
  if (process.env.EXPED_DB_USER) paths.user = process.env.EXPED_DB_USER;

  if (process.env.EXPED_MANIFEST_URL) env.manifestUrl = process.env.EXPED_MANIFEST_URL;
  if (process.env.EXPED_VERSION) env.version = process.env.EXPED_VERSION;

  // Sync com a nuvem (sub-projeto 3).
  const cloud = {};
  if (process.env.EXPED_CLOUD_API) cloud.apiBase = process.env.EXPED_CLOUD_API;
  if (process.env.EXPED_DEVICE_TOKEN) cloud.deviceToken = process.env.EXPED_DEVICE_TOKEN;
  if (process.env.EXPED_SYNC_INTERVAL_MS) cloud.syncIntervalMs = Number(process.env.EXPED_SYNC_INTERVAL_MS);

  if (Object.keys(ports).length) env.ports = ports;
  if (Object.keys(paths).length) env.paths = paths;
  if (Object.keys(cloud).length) env.cloud = cloud;

  // jwtSecret é obrigatório e validado — sem default fixo (segredo por instalação).
  const jwtSecret = resolveJwtSecret(overrides);

  const cfg = shallowMerge(shallowMerge(DEFAULTS, env), overrides);
  cfg.jwtSecret = jwtSecret;
  return cfg;
}

export default loadConfig;
