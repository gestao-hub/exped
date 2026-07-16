import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';

export const DEFAULT_LOG_MAX_BYTES = 64 * 1024 * 1024;
export const DEFAULT_LOG_BACKUPS = 2;

export function rotateLogFileSync(
  logPath,
  { maxBytes = DEFAULT_LOG_MAX_BYTES, backups = DEFAULT_LOG_BACKUPS } = {},
) {
  if (!logPath || !Number.isSafeInteger(maxBytes) || maxBytes < 1) return false;
  if (!Number.isSafeInteger(backups) || backups < 1) return false;

  try {
    if (!existsSync(logPath) || statSync(logPath).size < maxBytes) return false;
    rmSync(`${logPath}.${backups}`, { force: true });
    for (let index = backups - 1; index >= 1; index -= 1) {
      const source = `${logPath}.${index}`;
      if (existsSync(source)) renameSync(source, `${logPath}.${index + 1}`);
    }
    renameSync(logPath, `${logPath}.1`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Supervisiona um processo filho: inicia, vigia e reinicia (com backoff) se
 * ele sair, respeitando maxRestarts. stop() impede novos restarts e mata o
 * filho atual.
 */
export class Supervisor {
  constructor({
    name,
    cmd,
    args = [],
    env = {},
    cwd,
    logPath,
    maxRestarts = Infinity,
    backoffMs = 1000,
    stopTimeoutMs = 5000,
    forceKillTimeoutMs = 5000,
    logMaxBytes = DEFAULT_LOG_MAX_BYTES,
    logBackups = DEFAULT_LOG_BACKUPS,
    logRotateImpl = rotateLogFileSync,
    spawnImpl = spawn,
  }) {
    Object.assign(this, {
      name,
      cmd,
      args,
      env,
      cwd,
      logPath,
      maxRestarts,
      backoffMs,
      stopTimeoutMs,
      forceKillTimeoutMs,
      logMaxBytes,
      logBackups,
      logRotateImpl,
    });
    this.spawnImpl = spawnImpl;
    this.restarts = 0;
    this.child = null;
    this.stopped = false;
    this.restartTimer = null;
    this.stopPromise = null;
  }

  start() {
    this.stopped = false;
    this.stopPromise = null;
    this._spawn();
    return this;
  }

  _spawn() {
    // Para stdio o child_process exige um fd (não um WriteStream ainda não
    // aberto). Abrimos o arquivo de log em modo append e passamos o fd.
    if (this.logPath) {
      try {
        this.logRotateImpl(this.logPath, {
          maxBytes: this.logMaxBytes,
          backups: this.logBackups,
        });
      } catch {
        // Retencao e best-effort; nunca impede o processo supervisionado.
      }
    }
    const out = this.logPath ? openSync(this.logPath, 'a') : 'inherit';
    let child;
    try {
      child = this.spawnImpl(this.cmd, this.args, {
        env: { ...process.env, ...this.env },
        cwd: this.cwd,
        stdio: ['ignore', out, out],
      });
    } finally {
      if (typeof out === 'number') closeSync(out);
    }
    this.child = child;
    child.on('exit', () => {
      if (this.child === child) this.child = null;
      if (this.stopped) return;
      if (this.restarts >= this.maxRestarts) return;
      this.restarts++;
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        if (!this.stopped) this._spawn();
      }, this.backoffMs);
    });
  }

  stop() {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.stopPromise) return this.stopPromise;

    const child = this.child;
    const exited = () => (
      !child || child.exitCode !== null || child.signalCode !== null
    );
    if (exited()) {
      return Promise.resolve({
        forced: false,
        exitCode: child?.exitCode ?? null,
        signalCode: child?.signalCode ?? null,
      });
    }

    this.stopPromise = new Promise((resolve, reject) => {
      let forced = false;
      let graceTimer = null;
      let forceTimer = null;
      let settled = false;

      const cleanup = () => {
        if (graceTimer) clearTimeout(graceTimer);
        if (forceTimer) clearTimeout(forceTimer);
        child.removeListener('exit', onExit);
      };
      const finish = (exitCode = child.exitCode, signalCode = child.signalCode) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          forced,
          exitCode: exitCode ?? null,
          signalCode: signalCode ?? null,
        });
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onExit = (exitCode, signalCode) => finish(exitCode, signalCode);

      child.once('exit', onExit);
      if (exited()) {
        finish();
        return;
      }

      graceTimer = setTimeout(() => {
        if (exited()) {
          finish();
          return;
        }
        forced = true;
        try {
          child.kill('SIGKILL');
        } catch (error) {
          fail(new Error(`${this.name} falhou ao receber SIGKILL`, { cause: error }));
          return;
        }
        forceTimer = setTimeout(() => {
          if (exited()) finish();
          else fail(new Error(`${this.name} nao encerrou apos SIGKILL`));
        }, this.forceKillTimeoutMs);
      }, this.stopTimeoutMs);

      try {
        child.kill('SIGTERM');
      } catch (error) {
        if (exited()) finish();
        else fail(new Error(`${this.name} falhou ao receber SIGTERM`, { cause: error }));
      }
    });
    return this.stopPromise;
  }
}
