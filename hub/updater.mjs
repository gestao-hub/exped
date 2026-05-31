// Auto-update do Hub Exped com rollback.
//
// Fluxo (checkAndUpdate):
//   1. sem cfg.manifestUrl            -> no-op.
//   2. GET manifest { versao,url,sha256 }.
//   3. versao não é mais nova         -> no-op.
//   4. baixa url -> releases/<versao>.zip, valida sha256; mismatch -> aborta.
//   5. extrai -> releases/<versao>/, aponta ponteiro `current` pra <versao>, restart().
//   6. health(); ok -> {updated:true}. Lançou -> reverte ponteiro pro anterior,
//      restart() de novo, {updated:false, rolledBack:true}.
//
// A LÓGICA é testável injetando deps (fetchManifest/download/verifySha/extract/
// setPointer/getPointer) e os callbacks (getCurrentVersion/restart/health). Os
// defaults fazem o I/O real (node:crypto, fetch, unzip via tar/PowerShell).

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);

/** Parse "1.2.3" -> [1,2,3]; segmentos ausentes/NaN viram 0. */
function parseSemver(v) {
  return String(v)
    .trim()
    .replace(/^v/, '')
    .split('.')
    .slice(0, 3)
    .map((n) => {
      const x = parseInt(n, 10);
      return Number.isFinite(x) ? x : 0;
    });
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
  const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok || !res.body) throw new Error(`download HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

/** sha256 hex do arquivo `file`. */
async function defaultVerifySha(file) {
  const buf = await readFile(file);
  return createHash('sha256').update(buf).digest('hex');
}

/** extrai o zip `file` pra pasta `dir`. Usa tar (Win10+/Linux) com fallback PowerShell. */
async function defaultExtract(file, dir) {
  await mkdir(dir, { recursive: true });
  try {
    await execFileAsync('tar', ['-xf', file, '-C', dir], { maxBuffer: 1024 * 1024 * 64 });
  } catch {
    // fallback Windows (PowerShell Expand-Archive)
    await execFileAsync(
      'powershell',
      ['-NoProfile', '-Command', `Expand-Archive -Force -Path '${file}' -DestinationPath '${dir}'`],
      { maxBuffer: 1024 * 1024 * 64 },
    );
  }
}

/**
 * Cria getPointer/setPointer reais ligados a `ptrPath`. Assinaturas:
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
      await writeFile(ptrPath, String(versao), 'utf8');
    },
  };
}

/**
 * Verifica o manifesto e, se houver versão mais nova, baixa/valida/extrai,
 * troca o ponteiro `current`, reinicia e roda health. Se o health falhar,
 * reverte o ponteiro e reinicia (rollback).
 *
 * @param {object} cfg                 config do hub (usa manifestUrl + paths.releasesPtr/releasesDir)
 * @param {object} cb                  { getCurrentVersion, restart, health, logger }
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

  const ptrIO = makePointerIO(ptrPath);
  const {
    fetchManifest = defaultFetchManifest,
    download = defaultDownload,
    verifySha = defaultVerifySha,
    extract = defaultExtract,
    setPointer = ptrIO.setPointer,
    getPointer = ptrIO.getPointer,
  } = deps;

  // (2) manifesto
  const manifest = await fetchManifest(cfg.manifestUrl);
  const { versao, url, sha256 } = manifest;

  // (3) mais nova?
  if (!isNewer(versao, getCurrentVersion())) {
    return { updated: false };
  }
  logger.info?.(`[updater] versão ${versao} disponível (atual ${getCurrentVersion()})`);

  // (4) baixa + valida sha
  const zipPath = path.join(releasesDir, `${versao}.zip`);
  await download(url, zipPath);
  const got = await verifySha(zipPath);
  if (got !== sha256) {
    logger.error?.(`[updater] sha mismatch: esperado ${sha256}, obtido ${got}`);
    await rm(zipPath, { force: true }).catch(() => {});
    return { updated: false, reason: 'sha mismatch' };
  }

  // (5) extrai + troca ponteiro
  const previous = await getPointer();
  await extract(zipPath, path.join(releasesDir, versao));
  await setPointer(versao);
  await restart();

  // (6) health -> rollback se falhar
  try {
    await health();
    logger.info?.(`[updater] atualizado para ${versao}`);
    return { updated: true, versao };
  } catch (err) {
    logger.error?.(`[updater] health falhou após update (${err?.message}); revertendo para ${previous}`);
    if (previous) await setPointer(previous);
    await restart();
    return { updated: false, rolledBack: true };
  }
}

export default { isNewer, checkAndUpdate };
