// hub/force-update.mjs — FORÇA o auto-update do hub AGORA (sem esperar o timer de 1h).
//
// Usa a versão real do ponteiro `current`, com fallback para cfg.version. A opção
// forceSameVersion reinstala a versão atual sem autorizar versões inferiores;
// downgrade continua dependendo do contrato explícito do manifest.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const RESTART_WINDOWS_SERVICE = String.raw`& {
$ErrorActionPreference = 'Stop'
$name = $env:EXPED_WINDOWS_SERVICE_NAME
if ([string]::IsNullOrWhiteSpace($name)) {
  throw 'Nome do servico Windows ausente'
}
$service = Get-Service -Name $name -ErrorAction Stop
if ($service.Status -ne 'Stopped') {
  Stop-Service -Name $name -Force -ErrorAction Stop
  (Get-Service -Name $name).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(90))
}
Start-Service -Name $name -ErrorAction Stop
(Get-Service -Name $name).WaitForStatus('Running', [TimeSpan]::FromSeconds(90))
}
`;

export function restartWindowsService(service, run = execFileSync) {
  if (typeof service !== 'string' || !service.trim()) {
    throw new Error('nome do servico Windows invalido');
  }
  run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      RESTART_WINDOWS_SERVICE,
    ],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        EXPED_WINDOWS_SERVICE_NAME: service.trim(),
      },
    },
  );
}

export function currentVersionForForceUpdate(
  pointerPath,
  configVersion,
  read = readFileSync,
) {
  try {
    const pointer = String(read(pointerPath, 'utf8')).trim();
    if (pointer) return pointer;
  } catch {
    // Instalações anteriores podem ainda não ter criado o ponteiro.
  }
  if (typeof configVersion === 'string' && configVersion.trim()) {
    return configVersion.trim();
  }
  return '0.0.0';
}

export function resolveForceUpdatePaths({
  platform = process.platform,
  root,
  configPath,
  releasesDir,
  releasesPtr,
} = {}) {
  const pathApi = platform === 'win32' ? path.win32 : path;
  const defaultRoot = platform === 'win32' ? 'C:\\Exped' : '/tmp/exped';
  const resolvedRoot = root
    ? (pathApi.isAbsolute(root) ? pathApi.normalize(root) : pathApi.resolve(defaultRoot, root))
    : (configPath && pathApi.isAbsolute(configPath)
      ? pathApi.dirname(pathApi.normalize(configPath))
      : defaultRoot);
  const fromRoot = (value, fallback) => {
    const selected = value || fallback;
    return pathApi.isAbsolute(selected)
      ? pathApi.normalize(selected)
      : pathApi.resolve(resolvedRoot, selected);
  };

  return {
    root: resolvedRoot,
    configPath: fromRoot(configPath, 'config.json'),
    releasesDir: fromRoot(releasesDir, 'releases'),
    pointerPath: fromRoot(releasesPtr, pathApi.join('releases', 'current')),
    nssm: pathApi.join(resolvedRoot, 'bin', 'nssm.exe'),
  };
}

async function main() {
  const initialPaths = resolveForceUpdatePaths({
    configPath: process.argv[2],
    root: process.env.EXPED_ROOT,
  });
  const { configPath, root } = initialPaths;
  const service = process.env.EXPED_SERVICE_NAME || 'ExpedHub';

  const raw = JSON.parse(readFileSync(configPath, 'utf8'));
  const setIf = (key, value) => {
    if (value !== undefined && value !== null && value !== '') {
      process.env[key] = String(value);
    }
  };
  const pgBin = path.join(root, 'bin', 'pgsql', 'bin');
  process.env.PATH = `${pgBin};${path.join(root, 'bin', 'node')};${process.env.PATH || ''}`;
  setIf('EXPED_PG_BIN', pgBin);
  setIf('EXPED_CERT_DIR', path.join(root, 'cert'));
  if (raw.ports) {
    setIf('EXPED_PG_PORT', raw.ports.pg);
    setIf('EXPED_POSTGREST_PORT', raw.ports.postgrest);
    setIf('EXPED_GOTRUE_PORT', raw.ports.gotrue);
    setIf('EXPED_GATEWAY_PORT', raw.ports.gateway);
    setIf('EXPED_STORAGE_PORT', raw.ports.storage);
    setIf('EXPED_APP_PORT', raw.ports.app);
    setIf('EXPED_FRONTDOOR_PORT', raw.ports.frontdoor);
    setIf('EXPED_EVENTS_PORT', raw.ports.events);
  }
  setIf('EXPED_PG_DATA', (raw.paths && raw.paths.pgData) || path.join(root, 'data', 'pg'));
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
  if (raw.agent) {
    setIf('EXPED_AGENT_SYNC_PORT', raw.agent.syncNowPort);
    setIf('EXPED_AGENT_HEALTH_PATH', raw.agent.healthPath);
    setIf('EXPED_AGENT_HEALTH_MAX_AGE_MS', raw.agent.healthMaxAgeMs);
    setIf('EXPED_AGENT_STARTUP_MODE', raw.agent.startupMode);
    if (raw.agent.survivesRebootWithoutLogon !== undefined) {
      setIf(
        'EXPED_AGENT_SURVIVES_REBOOT_WITHOUT_LOGON',
        raw.agent.survivesRebootWithoutLogon,
      );
    }
  }

  const { loadConfig } = await import('./config.mjs');
  const { checkAndUpdate } = await import('./updater.mjs');
  const { applyPendingMigrations } = await import('./bootstrap.mjs');
  const { waitForCompleteHubStatus } = await import('./health.mjs');

  const cfg = loadConfig(raw);
  if (!cfg.manifestUrl) throw new Error('config.json sem manifestUrl — nada a forçar.');

  const resolvedPaths = resolveForceUpdatePaths({
    root,
    configPath,
    releasesDir: cfg.paths.releasesDir,
    releasesPtr: cfg.paths.releasesPtr,
  });
  const { releasesDir, pointerPath } = resolvedPaths;
  cfg.paths.releasesDir = releasesDir;
  cfg.paths.releasesPtr = pointerPath;

  const result = await checkAndUpdate(
    cfg,
    {
      getCurrentVersion: () => currentVersionForForceUpdate(pointerPath, cfg.version),
      forceSameVersion: true,
      restart: async () => {
        restartWindowsService(service);
      },
      health: async (expectedVersion) => {
        const actualVersion = currentVersionForForceUpdate(pointerPath, cfg.version);
        if (actualVersion !== expectedVersion) {
          throw new Error(`health da versao ${actualVersion}; esperado ${expectedVersion}`);
        }
        const statusPort = cfg.ports.status || cfg.ports.app + 1;
        await waitForCompleteHubStatus(
          `http://127.0.0.1:${statusPort}/status`,
          90000,
        );
      },
      migrate: async (releaseDir) => applyPendingMigrations(
        cfg,
        cfg.paths.db,
        path.join(releaseDir, 'supabase', 'migrations'),
      ),
      logger: console,
    },
  );

  console.log('RESULTADO:', JSON.stringify(result));
  return result.updated ? 0 : 1;
}

const isMain = (() => {
  try {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  main()
    .then((exitCode) => { process.exitCode = exitCode; })
    .catch((error) => {
      console.error('FALHOU:', error?.message || error);
      process.exitCode = 1;
    });
}
