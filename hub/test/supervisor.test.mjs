import { describe, it, expect, vi } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Supervisor } from '../supervisor.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(10);
  }
  throw new Error('timeout esperando processo de teste');
}

async function forceCleanup(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await Promise.race([exited, sleep(1000)]);
}

describe('Supervisor', () => {
  it('rotaciona o log acima do limite antes de iniciar o processo', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'exped-supervisor-log-'));
    const logPath = path.join(dir, 'gateway.log');
    writeFileSync(logPath, 'x'.repeat(128));
    writeFileSync(`${logPath}.1`, 'backup-anterior');

    const sup = new Supervisor({
      name: 'log-rotation',
      cmd: process.execPath,
      args: ['-e', "process.stdout.write('log-novo')"],
      logPath,
      logMaxBytes: 64,
      logBackups: 2,
      maxRestarts: 0,
    }).start();

    try {
      await waitUntil(() => sup.child === null);
      expect(readFileSync(logPath, 'utf8')).toBe('log-novo');
      expect(readFileSync(`${logPath}.1`, 'utf8')).toBe('x'.repeat(128));
      expect(readFileSync(`${logPath}.2`, 'utf8')).toBe('backup-anterior');
    } finally {
      await sup.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('inicia o processo mesmo quando a rotacao de log lanca excecao', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'exped-supervisor-log-failure-'));
    const logPath = path.join(dir, 'app.log');
    const logRotateImpl = vi.fn(() => { throw new Error('falha injetada'); });
    const sup = new Supervisor({
      name: 'log-rotation-failure',
      cmd: process.execPath,
      args: ['-e', "process.stdout.write('processo-iniciado')"],
      logPath,
      logRotateImpl,
      maxRestarts: 0,
    }).start();

    try {
      await waitUntil(() => sup.child === null);
      expect(logRotateImpl).toHaveBeenCalledOnce();
      expect(readFileSync(logPath, 'utf8')).toBe('processo-iniciado');
    } finally {
      await sup.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reinicia um processo que sai, respeitando maxRestarts', async () => {
    const sup = new Supervisor({ name: 'eco', cmd: process.execPath,
      args: ['-e', 'process.exit(1)'], maxRestarts: 2, backoffMs: 50 });
    sup.start();
    await sleep(700);
    expect(sup.restarts).toBeGreaterThanOrEqual(1);
    expect(sup.restarts).toBeLessThanOrEqual(2);
    await sup.stop();
  });
  it('stop() impede novos restarts', async () => {
    const sup = new Supervisor({ name: 'eco2', cmd: process.execPath,
      args: ['-e', 'process.exit(1)'], maxRestarts: 10, backoffMs: 30 });
    sup.start(); await sleep(120); await sup.stop();
    const r1 = sup.restarts; await sleep(200);
    expect(sup.restarts).toBe(r1);
  });

  it.skipIf(process.platform === 'win32')(
    'stop() aguarda o exit real depois de SIGTERM',
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'exped-supervisor-graceful-'));
      const ready = path.join(dir, 'ready');
      const sup = new Supervisor({
        name: 'graceful',
        cmd: process.execPath,
        args: [
          '-e',
          [
            "const fs = require('node:fs')",
            'process.on(\'SIGTERM\', () => setTimeout(() => process.exit(0), 150))',
            'fs.writeFileSync(process.argv[1], \'ready\')',
            'setInterval(() => {}, 1000)',
          ].join(';'),
          ready,
        ],
        stopTimeoutMs: 1000,
      }).start();
      const child = sup.child;

      try {
        await waitUntil(() => existsSync(ready));
        let settled = false;
        const startedAt = Date.now();
        const stopping = sup.stop().then((result) => {
          settled = true;
          return result;
        });

        await sleep(40);
        expect(settled).toBe(false);
        const result = await stopping;
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(120);
        expect(result).toMatchObject({ forced: false, exitCode: 0 });
      } finally {
        await Promise.resolve(sup.stop()).catch(() => {});
        await forceCleanup(child);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'forca SIGKILL no timeout e so resolve depois do exit confirmado',
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'exped-supervisor-forced-'));
      const ready = path.join(dir, 'ready');
      const sup = new Supervisor({
        name: 'stubborn',
        cmd: process.execPath,
        args: [
          '-e',
          [
            "const fs = require('node:fs')",
            "process.on('SIGTERM', () => {})",
            "fs.writeFileSync(process.argv[1], 'ready')",
            'setInterval(() => {}, 1000)',
          ].join(';'),
          ready,
        ],
        stopTimeoutMs: 50,
        forceKillTimeoutMs: 1000,
      }).start();
      const child = sup.child;

      try {
        await waitUntil(() => existsSync(ready));
        const result = await sup.stop();
        expect(result).toMatchObject({ forced: true, signalCode: 'SIGKILL' });
        expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      } finally {
        await Promise.resolve(sup.stop()).catch(() => {});
        await forceCleanup(child);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
