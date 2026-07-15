// Auto-update do Hub Exped com rollback.
//
// Fluxo (checkAndUpdate):
//   1. sem cfg.manifestUrl            -> no-op.
//   2. GET manifest { versao,url,sha256 }.
//   3. versao não é mais nova         -> no-op.
//   4. baixa url -> releases/<versao>.zip, valida sha256; mismatch -> aborta.
//   5. extrai -> releases/<versao>/, aponta ponteiro `current` pra <versao>, restart().
//   6. restart/health ok -> {updated:true}. Qualquer um falhou -> reverte ponteiro,
//      restart() + health() da versao anterior; so entao reporta rolledBack:true.
//
// A LÓGICA é testável injetando deps (fetchManifest/download/verifySha/extract/
// setPointer/getPointer/clearPointer) e os callbacks (getCurrentVersion/restart/health). Os
// defaults fazem o I/O real (node:crypto, fetch, unzip via tar/PowerShell).

import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  mkdir,
  open as openFile,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const MINIMUM_DOWNGRADE_HUB_VERSION = '0.3.21';
const activeUpdateLocks = new Set();

/**
 * Valida que `v` é um semver "limpo" (1, 1.2 ou 1.2.3), só dígitos e pontos.
 * Bloqueia injeção de comando / path traversal (`; rm`, `../`, etc.) antes de
 * a versão ser usada pra montar paths ou args de processo.
 */
export function validVersion(v) {
  return typeof v === 'string' && /^[0-9]+(\.[0-9]+){0,2}$/.test(v);
}

/** Parse "1.2.3" -> [1,2,3]; segmentos ausentes/NaN viram 0. */
function parseSemver(v) {
  const parts = String(v)
    .trim()
    .replace(/^v/, '')
    .split('.')
    .slice(0, 3)
    .map((n) => {
      const x = parseInt(n, 10);
      return Number.isFinite(x) ? x : 0;
    });
  while (parts.length < 3) parts.push(0);
  return parts;
}

/** true se semver `a` > `b` (compara major/minor/patch numericamente). */
export function isNewer(a, b) {
  const [aM, aMi, aP] = parseSemver(a);
  const [bM, bMi, bP] = parseSemver(b);
  if (aM !== bM) return aM > bM;
  if (aMi !== bMi) return aMi > bMi;
  return aP > bP;
}

// --------------------------------------------------------------------------
// I/O real (deps default) — funções pequenas, substituíveis nos testes.
// --------------------------------------------------------------------------

/** GET JSON do manifesto. */
async function defaultFetchManifest(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
  return res.json();
}

/** baixa `url` pro arquivo `dest`. */
async function defaultDownload(url, dest) {
  await mkdir(path.dirname(dest), { recursive: true });
  const res = await fetch(url, { signal: AbortSignal.timeout(600000) });
  if (!res.ok || !res.body) throw new Error(`download HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

/** sha256 hex do arquivo `file`. */
async function defaultVerifySha(file) {
  const buf = await readFile(file);
  return createHash('sha256').update(buf).digest('hex');
}

const RELEASE_MARKER = '.exped-release.json';

async function pathExists(file) {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function assertReleaseIdentity(identity) {
  if (!validVersion(identity?.version) || !/^[a-f0-9]{64}$/i.test(identity?.sha256 || '')) {
    throw new Error('identidade da release invalida');
  }
}

async function hasExactReleaseIdentity(releaseDir, identity) {
  const marker = await readJson(path.join(releaseDir, RELEASE_MARKER));
  return marker?.version === identity.version
    && marker?.sha256 === identity.sha256
    && await pathExists(path.join(releaseDir, 'server.js'));
}

/**
 * Promove uma pasta já extraída por rename atômico. Uma versão nunca é
 * extraída por cima de outra: se o destino existir, ele só pode ser reutilizado
 * quando o marcador criptográfico tiver exatamente a mesma identidade.
 */
export async function promoteExtractedRelease(stagingDir, releaseDir, identity) {
  assertReleaseIdentity(identity);
  if (await pathExists(releaseDir)) {
    if (await hasExactReleaseIdentity(releaseDir, identity)) {
      await rm(stagingDir, { recursive: true, force: true });
      return { reused: true };
    }
    throw new Error(`release existente em ${releaseDir} possui outra identidade`);
  }
  if (!await pathExists(path.join(stagingDir, 'server.js'))) {
    throw new Error('release extraida sem server.js');
  }
  await writeFile(
    path.join(stagingDir, RELEASE_MARKER),
    JSON.stringify({ version: identity.version, sha256: identity.sha256 }),
    { encoding: 'utf8', flag: 'wx' },
  );
  try {
    await rename(stagingDir, releaseDir);
  } catch (error) {
    if (error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY') {
      if (await hasExactReleaseIdentity(releaseDir, identity)) {
        await rm(stagingDir, { recursive: true, force: true });
        return { reused: true };
      }
      throw new Error(`release existente em ${releaseDir} possui outra identidade`, {
        cause: error,
      });
    }
    throw error;
  }
  return { reused: false };
}

/** extrai o zip em staging e promove a pasta completa por rename atômico. */
async function defaultExtract(file, dir, identity) {
  const stagingDir = `${dir}.staging-${process.pid}-${randomUUID()}`;
  await mkdir(path.dirname(dir), { recursive: true });
  await mkdir(stagingDir);
  try {
    try {
      await execFileAsync('tar', ['-xf', file, '-C', stagingDir], {
        maxBuffer: 1024 * 1024 * 64,
      });
    } catch {
      // Os paths seguem como argumentos posicionais, sem interpolação em shell.
      // Recria o staging para nao misturar uma extracao parcial do tar com o fallback.
      await rm(stagingDir, { recursive: true, force: true });
      await mkdir(stagingDir);
      await execFileAsync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          '& {param($s,$d) Expand-Archive -Force -Path $s -DestinationPath $d}',
          '--',
          file,
          stagingDir,
        ],
        { maxBuffer: 1024 * 1024 * 64 },
      );
    }
    return await promoteExtractedRelease(stagingDir, dir, identity);
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Cria getPointer/setPointer/clearPointer reais ligados a `ptrPath`. Assinaturas:
 *   getPointer()        -> string|null  (versão atual apontada)
 *   setPointer(versao)  -> void
 * Os defaults e os mocks de teste compartilham essa mesma assinatura simples
 * (ptrPath fica encapsulado), o que mantém a injeção trivial.
 */
function makePointerIO(ptrPath) {
  return {
    getPointer: async () => {
      try {
        return (await readFile(ptrPath, 'utf8')).trim() || null;
      } catch {
        return null;
      }
    },
    setPointer: async (versao) => {
      await mkdir(path.dirname(ptrPath), { recursive: true });
      const temporary = `${ptrPath}.${process.pid}.${randomUUID()}.tmp`;
      let handle;
      try {
        handle = await openFile(temporary, 'wx');
        await handle.writeFile(String(versao), 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        await rename(temporary, ptrPath);
      } finally {
        await handle?.close().catch(() => {});
        await rm(temporary, { force: true }).catch(() => {});
      }
    },
    clearPointer: async () => {
      await rm(ptrPath, { force: true });
    },
  };
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function readLockIdentity(lockPath) {
  return readJson(path.join(lockPath, 'owner.json'));
}

async function readLockOwner(lockPath) {
  const identity = await readLockIdentity(lockPath);
  if (!identity?.token) return identity;
  const heartbeat = await readJson(path.join(lockPath, `heartbeat-${identity.token}.json`));
  return { ...identity, heartbeatAt: heartbeat?.heartbeatAt || identity.heartbeatAt };
}

async function writeLockIdentity(lockPath, owner) {
  const temporary = path.join(lockPath, `owner-${owner.token}.tmp`);
  await writeFile(temporary, JSON.stringify(owner), { encoding: 'utf8', flag: 'wx' });
  await rename(temporary, path.join(lockPath, 'owner.json'));
}

async function writeLockHeartbeat(lockPath, token, heartbeatAt) {
  const temporary = path.join(lockPath, `heartbeat-${token}-${randomUUID()}.tmp`);
  const target = path.join(lockPath, `heartbeat-${token}.json`);
  await writeFile(temporary, JSON.stringify({ token, heartbeatAt }), {
    encoding: 'utf8',
    flag: 'wx',
  });
  await rename(temporary, target);
}

export async function acquireUpdateLock(lockPath, options = {}) {
  const heartbeatMs = options.heartbeatMs || 5_000;
  const staleMs = options.staleMs || 60_000;
  const token = options.token || randomUUID();
  const key = path.resolve(lockPath);
  if (activeUpdateLocks.has(key)) {
    return { acquired: false, reason: 'atualizacao em andamento' };
  }
  activeUpdateLocks.add(key);

  let acquired = false;
  try {
    await mkdir(path.dirname(lockPath), { recursive: true });
    for (let attempt = 0; attempt < 3 && !acquired; attempt += 1) {
      try {
        await mkdir(lockPath);
        acquired = true;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const observed = await readLockOwner(lockPath);
        const observedHeartbeat = Date.parse(observed?.heartbeatAt || '');
        const observedStat = await stat(lockPath).catch(() => null);
        const observedMtime = observedStat?.mtimeMs;
        const hasValidOwner = Boolean(observed?.token) && Number.isFinite(observedHeartbeat);
        const observedIsStale = hasValidOwner
          ? Date.now() - observedHeartbeat > staleMs
          : Number.isFinite(observedMtime) && Date.now() - observedMtime > staleMs;
        if (!observedIsStale) {
          activeUpdateLocks.delete(key);
          return { acquired: false, reason: 'atualizacao em andamento' };
        }

        const stalePath = `${lockPath}.stale-${token}`;
        try {
          await rename(lockPath, stalePath);
        } catch (renameError) {
          if (renameError?.code === 'ENOENT' || renameError?.code === 'EEXIST') continue;
          throw renameError;
        }
        const moved = await readLockOwner(stalePath);
        const movedHeartbeat = Date.parse(moved?.heartbeatAt || '');
        const movedStat = await stat(stalePath).catch(() => null);
        const sameStaleOwner = hasValidOwner
          ? moved?.token === observed.token
            && Number.isFinite(movedHeartbeat)
            && Date.now() - movedHeartbeat > staleMs
          : !moved?.token
            && Number.isFinite(movedStat?.mtimeMs)
            && Date.now() - movedStat.mtimeMs > staleMs;
        if (!sameStaleOwner) {
          await rename(stalePath, lockPath).catch(() => {});
          activeUpdateLocks.delete(key);
          return { acquired: false, reason: 'atualizacao em andamento' };
        }
        await rm(stalePath, { recursive: true, force: true });
      }
    }
  } catch (error) {
    activeUpdateLocks.delete(key);
    throw error;
  }

  if (!acquired) {
    activeUpdateLocks.delete(key);
    return { acquired: false, reason: 'atualizacao em andamento' };
  }

  let timer = null;
  let heartbeatPromise = Promise.resolve();
  let lostError = null;
  const owner = () => ({
    token,
    pid: process.pid,
    heartbeatAt: new Date().toISOString(),
  });
  try {
    const initial = owner();
    await writeLockIdentity(lockPath, initial);
    await writeLockHeartbeat(lockPath, token, initial.heartbeatAt);
  } catch (error) {
    await rm(lockPath, { recursive: true, force: true });
    activeUpdateLocks.delete(key);
    throw error;
  }

  const assertOwned = async () => {
    if (lostError) throw lostError;
    const current = await readLockIdentity(lockPath);
    if (current?.token !== token) throw new Error('update lock ownership lost');
    return true;
  };
  const heartbeat = async () => {
    await assertOwned();
    await writeLockHeartbeat(lockPath, token, new Date().toISOString());
    await assertOwned();
  };
  timer = setInterval(() => {
    heartbeatPromise = heartbeat().catch((error) => { lostError = error; });
  }, heartbeatMs);
  timer.unref?.();

  const stopHeartbeat = async () => {
    if (timer) clearInterval(timer);
    timer = null;
    await heartbeatPromise.catch(() => {});
  };

  const release = async () => {
    try {
      await stopHeartbeat();
      const current = await readLockIdentity(lockPath);
      if (current?.token !== token) return false;
      const releasePath = `${lockPath}.release-${token}`;
      try {
        await rename(lockPath, releasePath);
      } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
      }
      const claimed = await readLockIdentity(releasePath);
      if (claimed?.token !== token) {
        await rename(releasePath, lockPath).catch(() => {});
        return false;
      }
      await rm(releasePath, { recursive: true, force: true });
      return true;
    } finally {
      activeUpdateLocks.delete(key);
    }
  };

  return { acquired: true, token, assertOwned, stopHeartbeat, release };
}

/**
 * Verifica o manifesto e, se houver versão mais nova, baixa/valida/extrai,
 * aplica migrations da release (aditivas/idempotentes), troca o ponteiro
 * `current`, reinicia e roda health. Se o primeiro restart ou o health falhar,
 * reverte o ponteiro e reinicia (rollback) — sem chamar migrate novamente.
 *
 * @param {object} cfg                 config do hub (usa manifestUrl + paths.releasesPtr/releasesDir)
 * @param {object} cb                  { getCurrentVersion, restart, health, logger,
 *                                       migrate?(releaseDir), forceSameVersion? }
 * @param {object} [deps]              I/O injetável (defaults reais)
 */
export async function checkAndUpdate(cfg, cb, deps = {}) {
  const { getCurrentVersion, restart, health } = cb;
  const logger = cb.logger || console;

  if (!cfg.manifestUrl) return { updated: false, reason: 'sem manifest' };

  const releasesDir = (cfg.paths && cfg.paths.releasesDir) || 'releases';
  const ptrPath =
    (cfg.paths && cfg.paths.releasesPtr) ||
    (process.platform === 'win32' ? 'C:\\Exped\\current' : path.join(releasesDir, 'current'));
  const lockPath = (cfg.paths && cfg.paths.updateLock) || `${ptrPath}.lock`;
  const acquireLock = deps.acquireLock || acquireUpdateLock;
  const lease = await acquireLock(lockPath, deps.lockOptions);
  if (!lease.acquired) return { updated: false, reason: 'atualizacao em andamento' };

  const ptrIO = makePointerIO(ptrPath);
  const {
    fetchManifest = defaultFetchManifest,
    download = defaultDownload,
    verifySha = defaultVerifySha,
    extract = defaultExtract,
    setPointer = ptrIO.setPointer,
    getPointer = ptrIO.getPointer,
    clearPointer = ptrIO.clearPointer,
  } = deps;

  try {

  // (2) manifesto
  const manifest = await fetchManifest(cfg.manifestUrl);
  const { versao, url, sha256 } = manifest;

  // (2.1) versao precisa ser semver limpo ANTES de virar path/arg de processo.
  // Bloqueia injeção de comando / path traversal sem baixar nem extrair nada.
  if (!validVersion(versao)) {
    logger.error?.(`[updater] versão inválida no manifesto: ${JSON.stringify(versao)}`);
    return { updated: false, reason: 'versão inválida' };
  }

  // (3) Upgrade normal; downgrade so quando o manifesto declarar booleano true
  // e o runtime Hub instalado satisfizer o bootstrap minimo.
  // Versao igual continua sendo no-op mesmo com allowDowngrade.
  const downgradeRequested = manifest.allowDowngrade === true;
  if (downgradeRequested) {
    const minimumHubVersion = manifest.minimumHubVersion;
    if (
      !validVersion(minimumHubVersion)
      || isNewer(MINIMUM_DOWNGRADE_HUB_VERSION, minimumHubVersion)
    ) {
      return { updated: false, reason: 'downgrade sem minimumHubVersion valido' };
    }
    if (!validVersion(cfg.version) || isNewer(minimumHubVersion, cfg.version)) {
      return {
        updated: false,
        reason: `hub incompativel: requer ExpedSetup/Hub >= ${minimumHubVersion}`,
      };
    }
  }

  const currentVersion = getCurrentVersion();
  const upgrade = isNewer(versao, currentVersion);
  const downgrade = isNewer(currentVersion, versao);
  const explicitDowngrade = downgradeRequested && downgrade;
  const forcedSameVersion = cb.forceSameVersion === true && !upgrade && !downgrade;
  if (!upgrade && !explicitDowngrade && !forcedSameVersion) {
    return { updated: false };
  }
  logger.info?.(`[updater] versão ${versao} disponível (atual ${currentVersion})`);

  if (cb.preflight) {
    try {
      await cb.preflight();
    } catch (error) {
      logger.info?.(`[updater] adiado: ${error?.message || error}`);
      return { updated: false, reason: 'sistema ainda nao esta pronto para atualizar' };
    }
  }

  // (4) baixa + valida sha
  const zipPath = path.join(releasesDir, `${versao}.zip`);
  await download(url, zipPath);
  const got = await verifySha(zipPath);
  if (got !== sha256) {
    logger.error?.(`[updater] sha mismatch: esperado ${sha256}, obtido ${got}`);
    await rm(zipPath, { force: true }).catch(() => {});
    return { updated: false, reason: 'sha mismatch' };
  }

  // (5) extrai + (migrate aditivo) + troca ponteiro + restart
  const previous = await getPointer();
  const releaseDir = path.join(releasesDir, versao);
  await extract(zipPath, releaseDir, { version: versao, sha256 });
  if (cb.migrate) await cb.migrate(releaseDir); // migrations da release (aditivas, idempotentes)
  await lease.assertOwned?.();
  await setPointer(versao);
  const activatedPointer = await getPointer();
  if (activatedPointer !== versao) {
    if (activatedPointer !== previous) {
      if (previous) await setPointer(previous);
      else await clearPointer();
    }
    throw new Error(`ponteiro nao confirmou ${versao}; atual=${activatedPointer || '<vazio>'}`);
  }
  // (6) primeiro restart + health -> rollback se qualquer um falhar
  try {
    await restart();
    await health(versao);
    logger.info?.(`[updater] atualizado para ${versao}`);
    return { updated: true, versao };
  } catch (activationError) {
    logger.error?.(
      `[updater] ativacao falhou apos update (${activationError?.message}); revertendo para ${previous}`,
    );
    try {
      if (previous) await setPointer(previous);
      else await clearPointer();
      const restoredPointer = await getPointer();
      if (restoredPointer !== previous) {
        throw new Error(
          `ponteiro de rollback divergiu; esperado=${previous || '<vazio>'} atual=${restoredPointer || '<vazio>'}`,
        );
      }
      await restart();
      await health(previous || currentVersion);
    } catch (rollbackError) {
      const message = `rollback falhou apos ativacao de ${versao}: ${rollbackError?.message}`;
      logger.error?.(`[updater] ${message}`);
      throw new AggregateError([activationError, rollbackError], message);
    }
    logger.info?.(`[updater] rollback saudavel para ${previous || 'instalacao base'}`);
    return { updated: false, rolledBack: true };
  }
  } finally {
    await lease.release();
  }
}

const updater = { isNewer, checkAndUpdate, acquireUpdateLock };

export default updater;
