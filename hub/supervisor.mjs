import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';

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
