// hub/force-update.mjs — FORÇA o auto-update do hub AGORA (sem esperar o timer de 1h).
//
// Por quê: o maestro só checa update num setInterval (default 1h) e NÃO checa no
// boot — então reiniciar o serviço não força. Este script roda o MESMO updater
// testado (checkAndUpdate, com rollback) uma vez, na hora.
//
// Uso no SERVIDOR da loja (PowerShell, como Administrador):
//   C:\Exped\bin\node.exe C:\Exped\hub\force-update.mjs
//   (opcional: caminho do config.json como 1º arg; default C:\Exped\config.json)
//
// O que faz: baixa a versão do manifest, valida sha256, aplica as migrations no
// Postgres LOCAL (idempotentes — pula as já aplicadas), troca o ponteiro `current`,
// reinicia o serviço ExpedHub e roda health (/login). Se o health falhar, REVERTE
// o ponteiro e reinicia (rollback). Seguro de rodar mais de uma vez.
//
// Reaproveita os módulos do próprio hub (config/updater/bootstrap) — não duplica lógica.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const CONFIG_PATH =
  process.argv[2] ||
  (process.platform === 'win32' ? 'C:\\Exped\\config.json' : '/tmp/exped/config.json');
const ROOT = path.dirname(CONFIG_PATH); // C:\Exped
const SERVICE = process.env.EXPED_SERVICE_NAME || 'ExpedHub';
const NSSM = path.join(ROOT, 'bin', 'nssm.exe');

// 1) Carrega config.json e injeta as EXPED_* (mesmo mapeamento do install-service.ps1),
//    pra loadConfig() montar a config IGUAL à do serviço.
const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const setIf = (k, v) => {
  if (v !== undefined && v !== null && v !== '') process.env[k] = String(v);
};
const pgBin = path.join(ROOT, 'bin', 'pgsql', 'bin');
process.env.PATH = `${pgBin};${path.join(ROOT, 'bin', 'node')};${process.env.PATH || ''}`;
setIf('EXPED_PG_BIN', pgBin);
setIf('EXPED_CERT_DIR', path.join(ROOT, 'cert'));
if (raw.ports) {
  setIf('EXPED_PG_PORT', raw.ports.pg);
  setIf('EXPED_POSTGREST_PORT', raw.ports.postgrest);
  setIf('EXPED_GOTRUE_PORT', raw.ports.gotrue);
  setIf('EXPED_GATEWAY_PORT', raw.ports.gateway);
  setIf('EXPED_STORAGE_PORT', raw.ports.storage);
  setIf('EXPED_APP_PORT', raw.ports.app);
}
setIf('EXPED_PG_DATA', (raw.paths && raw.paths.pgData) || path.join(ROOT, 'data', 'pg'));
setIf('EXPED_PG_HOST', (raw.paths && raw.paths.pgHost) || '127.0.0.1');
if (raw.paths) {
  setIf('EXPED_DB', raw.paths.db);
  setIf('EXPED_DB_USER', raw.paths.user);
}
setIf('EXPED_JWT_SECRET', raw.jwtSecret);
setIf('EXPED_MANIFEST_URL', raw.manifestUrl);
setIf('EXPED_VERSION', raw.version);
if (raw.cloud) {
  setIf('EXPED_CLOUD_API', raw.cloud.apiBase);
  setIf('EXPED_DEVICE_TOKEN', raw.cloud.deviceToken);
  setIf('EXPED_SYNC_INTERVAL_MS', raw.cloud.syncIntervalMs);
}

// 2) imports do hub (módulos de função — sem efeito colateral no import)
const { loadConfig } = await import('./config.mjs');
const { checkAndUpdate } = await import('./updater.mjs');
const { applyPendingMigrations } = await import('./bootstrap.mjs');

const cfg = loadConfig();
if (!cfg.manifestUrl) {
  console.error('config.json sem manifestUrl — nada a forçar.');
  process.exit(1);
}

// 3) Ponteiro: usa EXATAMENTE o que o maestro lê (cfg.paths.releasesPtr || <releasesDir>/current),
//    pra o que escrevemos aqui ser o que o app carrega no restart.
const releasesDir = cfg.paths.releasesDir || path.join(ROOT, 'releases');
const ptrPath = cfg.paths.releasesPtr || path.join(releasesDir, 'current');
cfg.paths.releasesDir = releasesDir;
cfg.paths.releasesPtr = ptrPath;

async function waitForHttp(url, ms = 90000) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (r.status >= 200 && r.status < 500) return; // app de pé (200/3xx/401 contam)
    } catch {
      /* ainda subindo */
    }
    if (Date.now() > deadline) throw new Error(`timeout esperando ${url}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

const res = await checkAndUpdate(
  cfg,
  {
    // FORÇA: trata o atual como 0.0.0 → isNewer(manifest, 0.0.0) sempre true.
    getCurrentVersion: () => '0.0.0',
    restart: async () => {
      execFileSync(NSSM, ['restart', SERVICE], { stdio: 'inherit' });
    },
    health: async () => {
      await waitForHttp(`http://127.0.0.1:${cfg.ports.app}/login`, 90000);
    },
    migrate: async (releaseDir) =>
      applyPendingMigrations(cfg, cfg.paths.db, path.join(releaseDir, 'supabase', 'migrations')),
    logger: console,
  },
  {
    getPointer: async () => {
      try {
        return readFileSync(ptrPath, 'utf8').trim() || null;
      } catch {
        return null;
      }
    },
    setPointer: async (v) => {
      mkdirSync(path.dirname(ptrPath), { recursive: true });
      writeFileSync(ptrPath, String(v), 'utf8');
    },
  },
);

console.log('RESULTADO:', JSON.stringify(res));
process.exit(res.updated ? 0 : 1);
