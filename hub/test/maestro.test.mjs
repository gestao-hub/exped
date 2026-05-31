import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { needsInitdb, resolveAppEntrypoint } from '../maestro.mjs';

describe('needsInitdb', () => {
  const dirs = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('true quando o data dir nao tem PG_VERSION (cluster nao inicializado)', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'pgdata-'));
    dirs.push(d);
    expect(needsInitdb(d)).toBe(true);
  });

  it('false quando ja existe PG_VERSION (cluster valido)', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'pgdata-'));
    dirs.push(d);
    writeFileSync(path.join(d, 'PG_VERSION'), '16\n');
    expect(needsInitdb(d)).toBe(false);
  });

  it('true para caminho ausente/vazio', () => {
    expect(needsInitdb('')).toBe(true);
    expect(needsInitdb(undefined)).toBe(true);
  });
});

describe('resolveAppEntrypoint', () => {
  const ROOT = '/x/exped';
  const installer = path.join(ROOT, 'app', 'server.js');
  const dev = path.join(ROOT, '.next', 'standalone', 'server.js');

  it('prefere app/server.js (layout do instalador) quando existe', () => {
    const exists = (p) => p === installer;
    expect(resolveAppEntrypoint(ROOT, exists)).toBe(installer);
  });

  it('usa .next/standalone/server.js (dev) quando o do instalador nao existe', () => {
    const exists = (p) => p === dev;
    expect(resolveAppEntrypoint(ROOT, exists)).toBe(dev);
  });

  it('prefere o do instalador quando ambos existem', () => {
    const exists = () => true;
    expect(resolveAppEntrypoint(ROOT, exists)).toBe(installer);
  });

  it('cai no layout dev quando nenhum existe (mensagem de erro aponta o esperado)', () => {
    const exists = () => false;
    expect(resolveAppEntrypoint(ROOT, exists)).toBe(dev);
  });
});
