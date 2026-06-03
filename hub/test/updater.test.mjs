import { describe, it, expect } from 'vitest';
import { isNewer, checkAndUpdate, validVersion } from '../updater.mjs';

describe('updater.validVersion', () => {
  it('aceita versões semver simples', () => {
    expect(validVersion('1.2.3')).toBe(true);
    expect(validVersion('1.2')).toBe(true);
    expect(validVersion('1')).toBe(true);
  });
  it('rejeita injeção de comando', () => {
    expect(validVersion('1.2.3; rm -rf /')).toBe(false);
  });
  it('rejeita path traversal', () => {
    expect(validVersion('../x')).toBe(false);
  });
  it('rejeita vazio/lixo', () => {
    expect(validVersion('')).toBe(false);
    expect(validVersion('v1.2.3')).toBe(false);
    expect(validVersion('1.2.3.4')).toBe(false);
    expect(validVersion(undefined)).toBe(false);
  });
});

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

  it('rejeita manifesto com versão inválida sem baixar/extrair', async () => {
    let downloaded = false;
    let extracted = false;
    const res = await checkAndUpdate(
      { manifestUrl: 'http://x/manifest.json' },
      {
        getCurrentVersion: () => '1.0.0',
        restart: async () => {},
        health: async () => {},
        logger: { info() {}, error() {} },
      },
      {
        fetchManifest: async () => ({ versao: '1.1.0; rm -rf /', url: 'http://x/a.zip', sha256: 'ok' }),
        download: async () => { downloaded = true; },
        verifySha: async () => 'ok',
        extract: async () => { extracted = true; },
        setPointer: async () => {},
        getPointer: async () => '1.0.0',
      },
    );
    expect(res.updated).toBe(false);
    expect(res.reason).toBe('versão inválida');
    expect(downloaded).toBe(false);
    expect(extracted).toBe(false);
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

describe('updater.checkAndUpdate migrate', () => {
  const baseDeps = {
    fetchManifest: async () => ({ versao: '1.1.0', url: 'http://x/a.zip', sha256: 'ok' }),
    download: async () => {},
    verifySha: async () => 'ok',
    extract: async () => {},
  };
  it('chama migrate(releaseDir) depois de extrair e antes de restart; sucesso', async () => {
    const order = [];
    let pointer = '1.0.0';
    const res = await checkAndUpdate(
      { manifestUrl: 'http://x/m.json', paths: { releasesDir: '/r' } },
      {
        getCurrentVersion: () => '1.0.0',
        migrate: async (dir) => { order.push(`migrate:${dir}`); },
        restart: async () => { order.push('restart'); },
        health: async () => {},
        logger: { info() {}, error() {} },
      },
      {
        ...baseDeps,
        extract: async () => { order.push('extract'); },
        setPointer: async (v) => { pointer = v; },
        getPointer: async () => pointer,
      },
    );
    expect(res).toEqual({ updated: true, versao: '1.1.0' });
    const iMig = order.findIndex((s) => s.startsWith('migrate:'));
    const iRes = order.indexOf('restart');
    expect(iMig).toBeGreaterThan(order.indexOf('extract'));
    expect(iMig).toBeLessThan(iRes);
    expect(order[iMig]).toBe('migrate:/r/1.1.0');
  });
  it('rollback no health-fail NÃO chama migrate de novo', async () => {
    let migrates = 0;
    let pointer = '1.0.0';
    const res = await checkAndUpdate(
      { manifestUrl: 'http://x/m.json', paths: { releasesDir: '/r' } },
      {
        getCurrentVersion: () => '1.0.0',
        migrate: async () => { migrates++; },
        restart: async () => {},
        health: async () => { throw new Error('health falhou'); },
        logger: { info() {}, error() {} },
      },
      { ...baseDeps, setPointer: async (v) => { pointer = v; }, getPointer: async () => pointer },
    );
    expect(res).toEqual({ updated: false, rolledBack: true });
    expect(migrates).toBe(1); // só na ida, não no rollback
  });
});
