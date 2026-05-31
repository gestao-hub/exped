import { describe, it, expect } from 'vitest';
import { isNewer, checkAndUpdate } from '../updater.mjs';

describe('updater.isNewer', () => {
  it('detecta versão mais nova (semver)', () => {
    expect(isNewer('1.2.0', '1.1.9')).toBe(true);
    expect(isNewer('1.10.0', '1.9.0')).toBe(true);
    expect(isNewer('1.1.0', '1.1.0')).toBe(false);
    expect(isNewer('1.0.0', '1.2.0')).toBe(false);
  });
});

describe('updater.checkAndUpdate', () => {
  it('no-op quando não há manifestUrl', async () => {
    const res = await checkAndUpdate({}, {
      getCurrentVersion: () => '1.0.0',
      restart: async () => {},
      health: async () => {},
      logger: { info() {}, error() {} },
    });
    expect(res).toEqual({ updated: false, reason: 'sem manifest' });
  });

  it('no-op quando a versão do manifesto não é mais nova', async () => {
    let restarts = 0;
    const res = await checkAndUpdate(
      { manifestUrl: 'http://x/manifest.json' },
      {
        getCurrentVersion: () => '2.0.0',
        restart: async () => { restarts++; },
        health: async () => {},
        logger: { info() {}, error() {} },
      },
      { fetchManifest: async () => ({ versao: '1.5.0', url: 'http://x/a.zip', sha256: 'abc' }) },
    );
    expect(res.updated).toBe(false);
    expect(restarts).toBe(0);
  });

  it('aborta sem trocar quando o sha256 não bate', async () => {
    let pointer = '1.0.0';
    const res = await checkAndUpdate(
      { manifestUrl: 'http://x/manifest.json' },
      {
        getCurrentVersion: () => '1.0.0',
        restart: async () => {},
        health: async () => {},
        logger: { info() {}, error() {} },
      },
      {
        fetchManifest: async () => ({ versao: '1.1.0', url: 'http://x/a.zip', sha256: 'sha-esperado' }),
        download: async () => {},
        verifySha: async () => 'sha-DIFERENTE',
        extract: async () => {},
        setPointer: async (v) => { pointer = v; },
        getPointer: async () => pointer,
      },
    );
    expect(res).toEqual({ updated: false, reason: 'sha mismatch' });
    expect(pointer).toBe('1.0.0');
  });

  it('atualiza com sucesso quando health passa', async () => {
    let pointer = '1.0.0';
    const restartCalls = [];
    const res = await checkAndUpdate(
      { manifestUrl: 'http://x/manifest.json' },
      {
        getCurrentVersion: () => '1.0.0',
        restart: async () => { restartCalls.push(pointer); },
        health: async () => {},
        logger: { info() {}, error() {} },
      },
      {
        fetchManifest: async () => ({ versao: '1.1.0', url: 'http://x/a.zip', sha256: 'ok' }),
        download: async () => {},
        verifySha: async () => 'ok',
        extract: async () => {},
        setPointer: async (v) => { pointer = v; },
        getPointer: async () => pointer,
      },
    );
    expect(res).toEqual({ updated: true, versao: '1.1.0' });
    expect(pointer).toBe('1.1.0');
    expect(restartCalls.length).toBe(1);
  });

  it('faz rollback (restart 2x) quando o health da nova versão lança', async () => {
    let pointer = '1.0.0';
    let restarts = 0;
    const res = await checkAndUpdate(
      { manifestUrl: 'http://x/manifest.json' },
      {
        getCurrentVersion: () => '1.0.0',
        restart: async () => { restarts++; },
        health: async () => { throw new Error('app não respondeu'); },
        logger: { info() {}, error() {} },
      },
      {
        fetchManifest: async () => ({ versao: '1.1.0', url: 'http://x/a.zip', sha256: 'ok' }),
        download: async () => {},
        verifySha: async () => 'ok',
        extract: async () => {},
        setPointer: async (v) => { pointer = v; },
        getPointer: async () => pointer,
      },
    );
    expect(res.updated).toBe(false);
    expect(res.rolledBack).toBe(true);
    // trocou pra 1.1.0 e voltou pro 1.0.0 anterior
    expect(pointer).toBe('1.0.0');
    // restart chamado 2x: troca + volta
    expect(restarts).toBe(2);
  });
});
