import { describe, it, expect } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  acquireUpdateLock,
  isNewer,
  checkAndUpdate,
  promoteExtractedRelease,
  validVersion,
} from '../updater.mjs';

describe('updater release atomica', () => {
  it('promove staging validado por rename sem extrair sobre o destino', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'exped-release-promote-'));
    const staging = path.join(root, '.staging');
    const release = path.join(root, '1.1.0');
    try {
      mkdirSync(staging);
      writeFileSync(path.join(staging, 'server.js'), 'server');

      await promoteExtractedRelease(staging, release, {
        version: '1.1.0',
        sha256: 'a'.repeat(64),
      });

      expect(existsSync(staging)).toBe(false);
      expect(readFileSync(path.join(release, 'server.js'), 'utf8')).toBe('server');
      expect(readFileSync(path.join(release, '.exped-release.json'), 'utf8'))
        .toContain('"sha256":"' + 'a'.repeat(64) + '"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('recusa sobrescrever release existente com outra identidade', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'exped-release-conflict-'));
    const staging = path.join(root, '.staging');
    const release = path.join(root, '1.1.0');
    try {
      mkdirSync(staging);
      mkdirSync(release);
      writeFileSync(path.join(staging, 'server.js'), 'novo');
      writeFileSync(path.join(release, 'server.js'), 'ativo');

      await expect(promoteExtractedRelease(staging, release, {
        version: '1.1.0',
        sha256: 'b'.repeat(64),
      })).rejects.toThrow(/release existente.*identidade/i);

      expect(readFileSync(path.join(release, 'server.js'), 'utf8')).toBe('ativo');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

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

  it('completa segmentos ausentes com zero', () => {
    expect(isNewer('1.1', '1')).toBe(true);
    expect(isNewer('1.0.1', '1')).toBe(true);
    expect(isNewer('1', '1.0.0')).toBe(false);
  });
});

describe('updater lock com owner token', () => {
  it('mantem heartbeat e faz compare-and-delete no release', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'exped-update-lease-'));
    const lockPath = path.join(root, '.update-lock');
    const lease = await acquireUpdateLock(lockPath, {
      heartbeatMs: 20,
      staleMs: 5_000,
    });
    try {
      expect(lease.acquired).toBe(true);
      const owner = JSON.parse(readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
      const heartbeatPath = path.join(lockPath, `heartbeat-${lease.token}.json`);
      const first = JSON.parse(readFileSync(heartbeatPath, 'utf8'));
      expect(owner.token).toBe(lease.token);

      await new Promise((resolve) => setTimeout(resolve, 50));
      const second = JSON.parse(readFileSync(heartbeatPath, 'utf8'));
      expect(Date.parse(second.heartbeatAt)).toBeGreaterThanOrEqual(Date.parse(first.heartbeatAt));

      writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
        token: 'outro-owner',
        heartbeatAt: new Date().toISOString(),
      }));
      await expect(lease.release()).resolves.toBe(false);
      expect(readFileSync(path.join(lockPath, 'owner.json'), 'utf8')).toContain('outro-owner');
    } finally {
      await lease.stopHeartbeat?.();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('recupera lock orfao antigo sem owner valido apos queda', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'exped-update-orphan-'));
    const lockPath = path.join(root, '.update-lock');
    mkdirSync(lockPath);
    writeFileSync(path.join(lockPath, 'owner.json'), '{corrompido');
    const old = new Date(Date.now() - 120_000);
    utimesSync(lockPath, old, old);

    const lease = await acquireUpdateLock(lockPath, { staleMs: 1_000 });
    try {
      expect(lease.acquired).toBe(true);
    } finally {
      await lease.release?.();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('nao toma lock orfao ainda recente', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'exped-update-fresh-orphan-'));
    const lockPath = path.join(root, '.update-lock');
    mkdirSync(lockPath);

    try {
      await expect(acquireUpdateLock(lockPath, { staleMs: 60_000 })).resolves.toEqual({
        acquired: false,
        reason: 'atualizacao em andamento',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('libera o lock em memoria quando nao consegue criar o diretorio pai', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'exped-update-parent-error-'));
    const blockedParent = path.join(root, 'arquivo-no-lugar-do-diretorio');
    const lockPath = path.join(blockedParent, '.update-lock');
    writeFileSync(blockedParent, 'bloqueado');

    try {
      await expect(acquireUpdateLock(lockPath)).rejects.toMatchObject({
        code: expect.stringMatching(/EEXIST|ENOTDIR/),
      });
      await expect(acquireUpdateLock(lockPath)).rejects.toMatchObject({
        code: expect.stringMatching(/EEXIST|ENOTDIR/),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('updater.checkAndUpdate', () => {
  it('serializa atualizações concorrentes para o mesmo ponteiro', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'exped-update-lock-'));
    const pointerPath = path.join(root, 'current');
    let releaseManifest;
    const manifestGate = new Promise((resolve) => { releaseManifest = resolve; });
    const deps = {
      fetchManifest: async () => {
        await manifestGate;
        return { versao: '1.1.0', url: 'http://x/a.zip', sha256: 'ok' };
      },
      download: async () => {},
      verifySha: async () => 'ok',
      extract: async () => {},
    };
    const cb = {
      getCurrentVersion: () => '1.0.0',
      restart: async () => {},
      health: async () => {},
      logger: { info() {}, error() {} },
    };
    const cfg = {
      manifestUrl: 'http://x/manifest.json',
      paths: { releasesDir: root, releasesPtr: pointerPath },
    };

    try {
      const first = checkAndUpdate(cfg, cb, deps);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const second = await Promise.race([
        checkAndUpdate(cfg, cb, deps),
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 100)),
      ]);
      expect(second).toEqual({
        updated: false,
        reason: 'atualizacao em andamento',
      });
      releaseManifest();
      await expect(first).resolves.toEqual({ updated: true, versao: '1.1.0' });
      expect(readFileSync(pointerPath, 'utf8')).toBe('1.1.0');
      expect(readdirSync(root).some((name) => name.includes('.tmp'))).toBe(false);
      expect(existsSync(`${pointerPath}.lock`)).toBe(false);
    } finally {
      releaseManifest();
      rmSync(root, { recursive: true, force: true });
    }
  });

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

  it('adia antes do download quando o sistema ainda nao esta operacional', async () => {
    let downloads = 0;
    let restarts = 0;
    const res = await checkAndUpdate(
      { manifestUrl: 'http://x/manifest.json' },
      {
        getCurrentVersion: () => '1.0.0',
        preflight: async () => { throw new Error('Agent aguarda logon'); },
        restart: async () => { restarts += 1; },
        health: async () => {},
        logger: { info() {}, error() {} },
      },
      {
        fetchManifest: async () => ({
          versao: '1.1.0', url: 'http://x/a.zip', sha256: 'ok',
        }),
        download: async () => { downloads += 1; },
      },
    );

    expect(res).toEqual({
      updated: false,
      reason: 'sistema ainda nao esta pronto para atualizar',
    });
    expect(downloads).toBe(0);
    expect(restarts).toBe(0);
  });

  it('rejeita downgrade comum e allowDowngrade que nao seja booleano true', async () => {
    let downloads = 0;
    const run = (allowDowngrade) => checkAndUpdate(
      { manifestUrl: 'http://x/manifest.json' },
      {
        getCurrentVersion: () => '2.0.0',
        restart: async () => {},
        health: async () => {},
        logger: { info() {}, error() {} },
      },
      {
        fetchManifest: async () => ({
          versao: '1.5.0', url: 'http://x/a.zip', sha256: 'ok', allowDowngrade,
        }),
        download: async () => { downloads += 1; },
      },
    );

    await expect(run(undefined)).resolves.toEqual({ updated: false });
    await expect(run('true')).resolves.toEqual({ updated: false });
    expect(downloads).toBe(0);
  });

  it('aceita downgrade do app quando allowDowngrade e booleano true', async () => {
    let pointer = '2.0.0';
    const res = await checkAndUpdate(
      { manifestUrl: 'http://x/manifest.json', version: '0.3.21' },
      {
        getCurrentVersion: () => '2.0.0',
        restart: async () => {},
        health: async () => {},
        logger: { info() {}, error() {} },
      },
      {
        fetchManifest: async () => ({
          versao: '1.5.0',
          url: 'http://x/a.zip',
          sha256: 'ok',
          allowDowngrade: true,
          minimumHubVersion: '0.3.21',
        }),
        download: async () => {},
        verifySha: async () => 'ok',
        extract: async () => {},
        setPointer: async (v) => { pointer = v; },
        getPointer: async () => pointer,
      },
    );

    expect(res).toEqual({ updated: true, versao: '1.5.0' });
    expect(pointer).toBe('1.5.0');
  });

  it('recusa downgrade sem minimumHubVersion valido antes do download', async () => {
    let downloads = 0;
    const res = await checkAndUpdate(
      { manifestUrl: 'http://x/manifest.json', version: '0.3.21' },
      {
        getCurrentVersion: () => '2.0.0',
        restart: async () => {},
        health: async () => {},
        logger: { info() {}, error() {} },
      },
      {
        fetchManifest: async () => ({
          versao: '1.5.0',
          url: 'http://x/a.zip',
          sha256: 'ok',
          allowDowngrade: true,
        }),
        download: async () => { downloads += 1; },
        verifySha: async () => 'ok',
        extract: async () => {},
        setPointer: async () => {},
        getPointer: async () => '2.0.0',
      },
    );

    expect(res).toEqual({
      updated: false,
      reason: 'downgrade sem minimumHubVersion valido',
    });
    expect(downloads).toBe(0);
  });

  it('recusa downgrade quando o ExpedSetup/Hub instalado e antigo', async () => {
    let downloads = 0;
    const res = await checkAndUpdate(
      { manifestUrl: 'http://x/manifest.json', version: '0.3.20' },
      {
        getCurrentVersion: () => '2.0.0',
        restart: async () => {},
        health: async () => {},
        logger: { info() {}, error() {} },
      },
      {
        fetchManifest: async () => ({
          versao: '1.5.0',
          url: 'http://x/a.zip',
          sha256: 'ok',
          allowDowngrade: true,
          minimumHubVersion: '0.3.21',
        }),
        download: async () => { downloads += 1; },
        verifySha: async () => 'ok',
        extract: async () => {},
        setPointer: async () => {},
        getPointer: async () => '2.0.0',
      },
    );

    expect(res).toEqual({
      updated: false,
      reason: 'hub incompativel: requer ExpedSetup/Hub >= 0.3.21',
    });
    expect(downloads).toBe(0);
  });

  it('mantem versao igual como no-op mesmo com allowDowngrade true', async () => {
    let downloads = 0;
    const res = await checkAndUpdate(
      { manifestUrl: 'http://x/manifest.json', version: '0.3.21' },
      {
        getCurrentVersion: () => '2.0.0',
        restart: async () => {},
        health: async () => {},
        logger: { info() {}, error() {} },
      },
      {
        fetchManifest: async () => ({
          versao: '2.0.0',
          url: 'http://x/a.zip',
          sha256: 'ok',
          allowDowngrade: true,
          minimumHubVersion: '0.3.21',
        }),
        download: async () => { downloads += 1; },
      },
    );

    expect(res).toEqual({ updated: false });
    expect(downloads).toBe(0);
  });

  it('forceSameVersion reinstala somente quando a versao e igual', async () => {
    let pointer = '2.0.0';
    let downloads = 0;
    const res = await checkAndUpdate(
      { manifestUrl: 'http://x/manifest.json' },
      {
        getCurrentVersion: () => '2.0.0',
        forceSameVersion: true,
        restart: async () => {},
        health: async () => {},
        logger: { info() {}, error() {} },
      },
      {
        fetchManifest: async () => ({
          versao: '2.0.0', url: 'http://x/a.zip', sha256: 'ok',
        }),
        download: async () => { downloads += 1; },
        verifySha: async () => 'ok',
        extract: async () => {},
        setPointer: async (v) => { pointer = v; },
        getPointer: async () => pointer,
      },
    );

    expect(res).toEqual({ updated: true, versao: '2.0.0' });
    expect(downloads).toBe(1);
  });

  it('forceSameVersion nao transforma downgrade comum em upgrade', async () => {
    let downloads = 0;
    const res = await checkAndUpdate(
      { manifestUrl: 'http://x/manifest.json' },
      {
        getCurrentVersion: () => '2.0.0',
        forceSameVersion: true,
        restart: async () => {},
        health: async () => {},
        logger: { info() {}, error() {} },
      },
      {
        fetchManifest: async () => ({
          versao: '1.9.0', url: 'http://x/a.zip', sha256: 'ok',
        }),
        download: async () => { downloads += 1; },
      },
    );

    expect(res).toEqual({ updated: false });
    expect(downloads).toBe(0);
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
    const expectedHealthVersions = [];
    const res = await checkAndUpdate(
      { manifestUrl: 'http://x/manifest.json' },
      {
        getCurrentVersion: () => '1.0.0',
        restart: async () => { restartCalls.push(pointer); },
        health: async (expectedVersion) => { expectedHealthVersions.push(expectedVersion); },
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
    expect(expectedHealthVersions).toEqual(['1.1.0']);
  });

  it('falha fechado se o ponteiro gravado não confirmar a versão desejada', async () => {
    let pointer = '1.0.0';
    let restarts = 0;
    await expect(checkAndUpdate(
      { manifestUrl: 'http://x/manifest.json' },
      {
        getCurrentVersion: () => '1.0.0',
        restart: async () => { restarts += 1; },
        health: async () => {},
        logger: { info() {}, error() {} },
      },
      {
        fetchManifest: async () => ({ versao: '1.1.0', url: 'http://x/a.zip', sha256: 'ok' }),
        download: async () => {},
        verifySha: async () => 'ok',
        extract: async () => {},
        setPointer: async () => {},
        getPointer: async () => pointer,
      },
    )).rejects.toThrow(/ponteiro.*1\.1\.0/i);
    expect(pointer).toBe('1.0.0');
    expect(restarts).toBe(0);
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
    let healthCalls = 0;
    const expectedHealthVersions = [];
    const res = await checkAndUpdate(
      { manifestUrl: 'http://x/manifest.json' },
      {
        getCurrentVersion: () => '1.0.0',
        restart: async () => { restarts++; },
        health: async (expectedVersion) => {
          expectedHealthVersions.push(expectedVersion);
          healthCalls += 1;
          if (healthCalls === 1) throw new Error('app não respondeu');
        },
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
    expect(healthCalls).toBe(2);
    expect(expectedHealthVersions).toEqual(['1.1.0', '1.0.0']);
  });

  it('faz rollback e valida health antigo quando o primeiro restart falha', async () => {
    let pointer = '1.0.0';
    const pointerAtRestart = [];
    let healthCalls = 0;
    const res = await checkAndUpdate(
      { manifestUrl: 'http://x/manifest.json' },
      {
        getCurrentVersion: () => '1.0.0',
        restart: async () => {
          pointerAtRestart.push(pointer);
          if (pointerAtRestart.length === 1) throw new Error('restart novo falhou');
        },
        health: async () => { healthCalls += 1; },
        logger: { info() {}, error() {} },
      },
      {
        fetchManifest: async () => ({
          versao: '1.1.0', url: 'http://x/a.zip', sha256: 'ok',
        }),
        download: async () => {},
        verifySha: async () => 'ok',
        extract: async () => {},
        setPointer: async (v) => { pointer = v; },
        getPointer: async () => pointer,
      },
    );

    expect(res).toEqual({ updated: false, rolledBack: true });
    expect(pointer).toBe('1.0.0');
    expect(pointerAtRestart).toEqual(['1.1.0', '1.0.0']);
    expect(healthCalls).toBe(1);
  });

  it('propaga a falha do restart de rollback em vez de declarar sucesso', async () => {
    let pointer = '1.0.0';
    let restarts = 0;
    const update = checkAndUpdate(
      { manifestUrl: 'http://x/manifest.json' },
      {
        getCurrentVersion: () => '1.0.0',
        restart: async () => {
          restarts += 1;
          if (restarts === 2) throw new Error('restart anterior falhou');
        },
        health: async () => { throw new Error('health falhou'); },
        logger: { info() {}, error() {} },
      },
      {
        fetchManifest: async () => ({
          versao: '1.1.0', url: 'http://x/a.zip', sha256: 'ok',
        }),
        download: async () => {},
        verifySha: async () => 'ok',
        extract: async () => {},
        setPointer: async (v) => { pointer = v; },
        getPointer: async () => pointer,
      },
    );

    await expect(update).rejects.toThrow(/rollback falhou.*restart anterior falhou/);
    expect(pointer).toBe('1.0.0');
    expect(restarts).toBe(2);
  });

  it('propaga erro explicito quando o rollback reinicia mas nao fica saudavel', async () => {
    let pointer = '1.0.0';
    let healthCalls = 0;
    const update = checkAndUpdate(
      { manifestUrl: 'http://x/manifest.json' },
      {
        getCurrentVersion: () => '1.0.0',
        restart: async () => {},
        health: async () => {
          healthCalls += 1;
          throw new Error(healthCalls === 1 ? 'nova doente' : 'rollback doente');
        },
        logger: { info() {}, error() {} },
      },
      {
        fetchManifest: async () => ({
          versao: '1.1.0', url: 'http://x/a.zip', sha256: 'ok',
        }),
        download: async () => {},
        verifySha: async () => 'ok',
        extract: async () => {},
        setPointer: async (v) => { pointer = v; },
        getPointer: async () => pointer,
      },
    );

    await expect(update).rejects.toThrow(/rollback falhou.*rollback doente/);
    expect(pointer).toBe('1.0.0');
    expect(healthCalls).toBe(2);
  });

  it('usa clearPointer injetavel quando nao havia ponteiro anterior', async () => {
    let pointer = null;
    let clears = 0;
    let healthCalls = 0;
    const pointerAtRestart = [];
    const res = await checkAndUpdate(
      { manifestUrl: 'http://x/manifest.json' },
      {
        getCurrentVersion: () => '1.0.0',
        restart: async () => { pointerAtRestart.push(pointer); },
        health: async () => {
          healthCalls += 1;
          if (healthCalls === 1) throw new Error('app nao respondeu');
        },
        logger: { info() {}, error() {} },
      },
      {
        fetchManifest: async () => ({
          versao: '1.1.0', url: 'http://x/a.zip', sha256: 'ok',
        }),
        download: async () => {},
        verifySha: async () => 'ok',
        extract: async () => {},
        setPointer: async (v) => { pointer = v; },
        getPointer: async () => pointer,
        clearPointer: async () => { clears += 1; pointer = null; },
      },
    );

    expect(res).toEqual({ updated: false, rolledBack: true });
    expect(clears).toBe(1);
    expect(pointerAtRestart).toEqual(['1.1.0', null]);
    expect(healthCalls).toBe(2);
  });

  it('clearPointer real remove o arquivo antes do segundo restart', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'exped-pointer-'));
    const pointerPath = path.join(root, 'current');
    const pointerAtRestart = [];
    let healthCalls = 0;

    try {
      const res = await checkAndUpdate(
        {
          manifestUrl: 'http://x/manifest.json',
          paths: { releasesDir: root, releasesPtr: pointerPath },
        },
        {
          getCurrentVersion: () => '1.0.0',
          restart: async () => {
            pointerAtRestart.push(
              existsSync(pointerPath) ? readFileSync(pointerPath, 'utf8') : null,
            );
          },
          health: async () => {
            healthCalls += 1;
            if (healthCalls === 1) throw new Error('app nao respondeu');
          },
          logger: { info() {}, error() {} },
        },
        {
          fetchManifest: async () => ({
            versao: '1.1.0', url: 'http://x/a.zip', sha256: 'ok',
          }),
          download: async () => {},
          verifySha: async () => 'ok',
          extract: async () => {},
        },
      );

      expect(res).toEqual({ updated: false, rolledBack: true });
      expect(pointerAtRestart).toEqual(['1.1.0', null]);
      expect(existsSync(pointerPath)).toBe(false);
      expect(healthCalls).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('updater.checkAndUpdate migrate', () => {
  const baseDeps = {
    fetchManifest: async () => ({ versao: '1.1.0', url: 'http://x/a.zip', sha256: 'ok' }),
    download: async () => {},
    verifySha: async () => 'ok',
    extract: async () => {},
    acquireLock: async () => ({
      acquired: true,
      assertOwned: async () => true,
      release: async () => true,
    }),
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
    expect(order[iMig]).toBe(`migrate:${path.join('/r', '1.1.0')}`);
  });
  it('rollback no health-fail NÃO chama migrate de novo', async () => {
    let migrates = 0;
    let pointer = '1.0.0';
    let healthCalls = 0;
    const res = await checkAndUpdate(
      { manifestUrl: 'http://x/m.json', paths: { releasesDir: '/r' } },
      {
        getCurrentVersion: () => '1.0.0',
        migrate: async () => { migrates++; },
        restart: async () => {},
        health: async () => {
          healthCalls += 1;
          if (healthCalls === 1) throw new Error('health falhou');
        },
        logger: { info() {}, error() {} },
      },
      { ...baseDeps, setPointer: async (v) => { pointer = v; }, getPointer: async () => pointer },
    );
    expect(res).toEqual({ updated: false, rolledBack: true });
    expect(migrates).toBe(1); // só na ida, não no rollback
    expect(healthCalls).toBe(2);
  });
});
