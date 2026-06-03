import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listMigrations } from '../bootstrap.mjs';

let dir;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'mig-'));
  writeFileSync(path.join(dir, '20260102_b.sql'), 'select 1');
  writeFileSync(path.join(dir, '20260101_a.sql'), 'select 1');
  writeFileSync(path.join(dir, 'readme.txt'), 'nope');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('listMigrations(dir)', () => {
  it('lê do dir passado, só .sql, ordenado', () => {
    const ms = listMigrations(dir);
    expect(ms.map((m) => m.name)).toEqual(['20260101_a.sql', '20260102_b.sql']);
    expect(ms[0].file).toBe(path.join(dir, '20260101_a.sql'));
  });
});
