import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startStorage } from '../storage-local.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';

let srv, base, dir;
beforeAll(async () => { dir = mkdtempSync(join(tmpdir(),'stg-')); srv = await startStorage({ port: 0, root: dir }); base = `http://127.0.0.1:${srv.port}`; });
afterAll(() => { srv.close(); rmSync(dir, { recursive: true, force: true }); });

describe('storage-local', () => {
  it('upload grava e download devolve o mesmo conteúdo', async () => {
    const body = Buffer.from('%PDF-1.4 teste');
    const up = await fetch(`${base}/storage/v1/object/pedidos-pdfs/x/y.pdf`, { method: 'POST', body });
    expect(up.status).toBeLessThan(300);
    const down = await fetch(`${base}/storage/v1/object/pedidos-pdfs/x/y.pdf`);
    expect(Buffer.from(await down.arrayBuffer()).equals(body)).toBe(true);
  });
  it('download de inexistente dá 404', async () => {
    const r = await fetch(`${base}/storage/v1/object/pedidos-pdfs/nao/existe.pdf`);
    expect(r.status).toBe(404);
  });
});
