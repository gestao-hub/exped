import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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
