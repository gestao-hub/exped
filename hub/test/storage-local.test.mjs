import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startStorage } from '../storage-local.mjs';
import { mintJwt } from '../keys.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';

const SECRET = 'segredo-de-teste-storage-com-mais-de-32-chars';
let srv, base, dir, token, auth;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(),'stg-'));
  srv = await startStorage({ port: 0, root: dir, secret: SECRET });
  base = `http://127.0.0.1:${srv.port}`;
  token = mintJwt('service_role', SECRET);
  auth = { Authorization: `Bearer ${token}` };
});
afterAll(() => { srv.close(); rmSync(dir, { recursive: true, force: true }); });

describe('storage-local', () => {
  it('exige secret no startStorage', async () => {
    await expect(startStorage({ port: 0, root: dir })).rejects.toThrow();
  });

  it('upload grava e download devolve o mesmo conteúdo', async () => {
    const body = Buffer.from('%PDF-1.4 teste');
    const up = await fetch(`${base}/storage/v1/object/pedidos-pdfs/x/y.pdf`, { method: 'POST', body, headers: auth });
    expect(up.status).toBeLessThan(300);
    const down = await fetch(`${base}/storage/v1/object/pedidos-pdfs/x/y.pdf`, { headers: auth });
    expect(Buffer.from(await down.arrayBuffer()).equals(body)).toBe(true);
  });

  it('download de inexistente dá 404', async () => {
    const r = await fetch(`${base}/storage/v1/object/pedidos-pdfs/nao/existe.pdf`, { headers: auth });
    expect(r.status).toBe(404);
  });

  it('request sem token dá 401', async () => {
    const r = await fetch(`${base}/storage/v1/object/pedidos-pdfs/x/y.pdf`);
    expect(r.status).toBe(401);
    const up = await fetch(`${base}/storage/v1/object/pedidos-pdfs/z.pdf`, { method: 'POST', body: Buffer.from('x') });
    expect(up.status).toBe(401);
  });

  it('request com token inválido dá 401', async () => {
    const bad = { Authorization: 'Bearer token.invalido.aqui' };
    const r = await fetch(`${base}/storage/v1/object/pedidos-pdfs/x/y.pdf`, { headers: bad });
    expect(r.status).toBe(401);
  });
});
