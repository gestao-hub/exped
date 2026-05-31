import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';

/**
 * Supervisiona um processo filho: inicia, vigia e reinicia (com backoff) se
 * ele sair, respeitando maxRestarts. stop() impede novos restarts e mata o
 * filho atual.
 */
export class Supervisor {
  constructor({ name, cmd, args = [], env = {}, cwd, logPath, maxRestarts = Infinity, backoffMs = 1000 }) {
    Object.assign(this, { name, cmd, args, env, cwd, logPath, maxRestarts, backoffMs });
    this.restarts = 0;
    this.child = null;
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    this._spawn();
    return this;
  }

  _spawn() {
    // Para stdio o child_process exige um fd (não um WriteStream ainda não
    // aberto). Abrimos o arquivo de log em modo append e passamos o fd.
    const out = this.logPath ? openSync(this.logPath, 'a') : 'inherit';
    this.child = spawn(this.cmd, this.args, {
      env: { ...process.env, ...this.env },
      cwd: this.cwd,
      stdio: ['ignore', out, out],
    });
    this.child.on('exit', () => {
      if (this.stopped) return;
      if (this.restarts >= this.maxRestarts) return;
      this.restarts++;
      setTimeout(() => {
        if (!this.stopped) this._spawn();
      }, this.backoffMs);
    });
  }

  stop() {
    this.stopped = true;
    if (this.child) this.child.kill();
  }
}
