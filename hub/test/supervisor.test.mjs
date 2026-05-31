import { describe, it, expect } from 'vitest';
import { Supervisor } from '../supervisor.mjs';

describe('Supervisor', () => {
  it('reinicia um processo que sai, respeitando maxRestarts', async () => {
    const sup = new Supervisor({ name: 'eco', cmd: process.execPath,
      args: ['-e', 'process.exit(1)'], maxRestarts: 2, backoffMs: 50 });
    sup.start();
    await new Promise(r => setTimeout(r, 700));
    expect(sup.restarts).toBeGreaterThanOrEqual(1);
    expect(sup.restarts).toBeLessThanOrEqual(2);
    sup.stop();
  });
  it('stop() impede novos restarts', async () => {
    const sup = new Supervisor({ name: 'eco2', cmd: process.execPath,
      args: ['-e', 'process.exit(1)'], maxRestarts: 10, backoffMs: 30 });
    sup.start(); await new Promise(r => setTimeout(r, 120)); sup.stop();
    const r1 = sup.restarts; await new Promise(r => setTimeout(r, 200));
    expect(sup.restarts).toBe(r1);
  });
});
