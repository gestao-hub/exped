import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  agentHttpReady,
  agentRuntimeStatus,
  appRuntimeEnv,
  currentAppVersion,
  needsInitdb,
  postgresAcceptingConnections,
  publicSyncStatus,
  readPointerSync,
  replaceAppSupervisor,
  resolveAppEntrypoint,
  stopSupervisorsInOrder,
  waitForPostgresReady,
} from '../maestro.mjs';

const maestroSource = readFileSync(new URL('../maestro.mjs', import.meta.url), 'utf8');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

describe('recuperacao apos boot', () => {
  const cfg = {
    ports: { pg: 54329 },
    paths: { pgHost: '127.0.0.1', user: 'postgres' },
    agent: { syncNowPort: 5005, startupMode: 'interactive_logon' },
  };

  it('usa pg_isready para distinguir porta aberta de conexoes aceitas', () => {
    const calls = [];
    const ready = postgresAcceptingConnections(cfg, (...args) => calls.push(args));

    expect(ready).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatch(/pg_isready(?:\.exe)?$/);
    expect(calls[0][1]).toEqual([
      '-h', '127.0.0.1',
      '-p', '54329',
      '-d', 'postgres',
      '-U', 'postgres',
      '-q',
    ]);
  });

  it('continua aguardando enquanto o Postgres rejeita conexoes durante recovery', async () => {
    let attempts = 0;

    await expect(waitForPostgresReady(cfg, {
      timeoutMs: 100,
      intervalMs: 1,
      probe: () => ++attempts >= 3,
    })).resolves.toBe(true);

    expect(attempts).toBe(3);
  });

  it('aguarda o Postgres aceitar conexoes antes do bootstrap', () => {
    const startup = maestroSource.slice(maestroSource.indexOf('export async function startMaestro'));
    expect(startup.indexOf('waitForPostgresReady')).toBeGreaterThanOrEqual(0);
    expect(startup.indexOf('waitForPostgresReady')).toBeLessThan(startup.indexOf('bootstrap(cfg)'));
  });

  it('health do updater exige o /status completo antes de confirmar', () => {
    const updateHealth = maestroSource.slice(maestroSource.indexOf('const health = async'));
    expect(updateHealth).toContain('waitForCompleteHubStatus');
    expect(updateHealth).toMatch(/\/status/);
  });

  it('publica que o agente interativo nao sobrevive ao reboot sem logon', async () => {
    const status = await agentRuntimeStatus(
      { ...cfg.agent, healthPath: 'health.json', healthMaxAgeMs: 90_000 },
      async () => true,
      async () => ({
        running: true,
        pid: 197,
        hiper: { connected: true, queryOk: true, schemaCompatible: true },
      }),
    );
    expect(status).toMatchObject({
      enabled: true,
      running: true,
      syncNowPort: 5005,
      syncNowReady: true,
      startupMode: 'interactive_logon',
      requiresInteractiveLogon: true,
      survivesRebootWithoutLogon: false,
    });
    expect(status.recovery.guaranteedBeforeLogon).toBe(false);
    expect(status.hiper.queryOk).toBe(true);
  });

  it('probe do agente exige o contrato JSON conhecido, nao qualquer HTTP 400', async () => {
    const valid = async () => new Response(
      JSON.stringify({ success: false, synced: 0, error: 'Nenhum usuario informado.' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
    const generic = async () => new Response(
      JSON.stringify({ error: 'bad request' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );

    await expect(agentHttpReady(5005, valid)).resolves.toBe(true);
    await expect(agentHttpReady(5005, generic)).resolves.toBe(false);
  });

  it('nao faz probe quando o sync local esta desativado', async () => {
    let probes = 0;
    await expect(agentRuntimeStatus(
      { syncNowPort: 0, startupMode: 'disabled' },
      async () => { probes += 1; return true; },
    )).resolves.toMatchObject({
      enabled: false,
      running: false,
      syncNowPort: 0,
      syncNowReady: false,
      startupMode: 'disabled',
      requiresInteractiveLogon: false,
      survivesRebootWithoutLogon: false,
    });
    expect(probes).toBe(0);
  });
});

describe('ciclo do app supervisionado', () => {
  it('aguarda o app antigo sair antes de criar e iniciar o novo', async () => {
    const stopped = deferred();
    const order = [];
    const current = {
      stop: () => {
        order.push('stop:old');
        return stopped.promise;
      },
    };
    const next = {
      start: () => {
        order.push('start:new');
        return next;
      },
    };

    const replacing = replaceAppSupervisor(current, () => {
      order.push('create:new');
      return next;
    });
    await Promise.resolve();
    expect(order).toEqual(['stop:old']);

    stopped.resolve({ forced: false });
    await expect(replacing).resolves.toBe(next);
    expect(order).toEqual(['stop:old', 'create:new', 'start:new']);
  });

  it('shutdown aguarda cada supervisor na ordem recebida', async () => {
    const appStopped = deferred();
    const order = [];
    const app = {
      stop: () => {
        order.push('stop:app');
        return appStopped.promise;
      },
    };
    const gateway = {
      stop: async () => { order.push('stop:gateway'); },
    };

    const stopping = stopSupervisorsInOrder([app, gateway]);
    await Promise.resolve();
    expect(order).toEqual(['stop:app']);

    appStopped.resolve({ forced: false });
    await stopping;
    expect(order).toEqual(['stop:app', 'stop:gateway']);
  });
});

describe('publicSyncStatus', () => {
  it('publica somente a telemetria aprovada sem extras ou segredos aninhados', () => {
    const inherited = {
      deviceToken: 'token-herdado',
      rawError: { authorization: 'Bearer segredo-herdado' },
    };
    const pendingByTable = Object.assign(Object.create(inherited), {
      pedidos: 30,
      clientes: { rawError: 'sql-aninhado-no-pending' },
      empresas: 99,
      deviceToken: 'token-no-pending',
      rawError: { authorization: 'bearer-pending-secreto' },
    });
    const lastBlockedRow = Object.assign(Object.create(inherited), {
      table: 'pedidos',
      pk: 'pedido-1',
      deviceToken: 'token-no-blocked-row',
      rawError: { sql: 'select segredo no blocked row' },
    });
    const state = Object.assign(Object.create(inherited), {
      lastSyncOk: false,
      pendingPush: 30,
      pendingByTable,
      caughtUp: false,
      phase: 'error',
      runningSince: null,
      lastSyncAt: '2026-07-14T13:39:27.312Z',
      lastSuccessAt: '2026-07-14T13:30:00.000Z',
      consecutiveFailures: 1,
      lastError: 'Falha no ciclo de sincronizacao',
      lastBlockedRow,
      lastSkipped: 2,
      email: 'nao-pode-sair@franzoni.local',
      diagnostics: {
        cloud: { deviceToken: 'token-aninhado' },
        rawError: { sql: 'select segredo from auth.users' },
      },
    });

    const publicState = publicSyncStatus(true, state);

    expect(publicState).toEqual({
      enabled: true,
      lastSyncOk: false,
      pendingPush: 30,
      pendingByTable: { pedidos: 30 },
      caughtUp: false,
      phase: 'error',
      runningSince: null,
      lastSyncAt: '2026-07-14T13:39:27.312Z',
      lastSuccessAt: '2026-07-14T13:30:00.000Z',
      consecutiveFailures: 1,
      lastError: 'Falha no ciclo de sincronizacao',
      lastBlockedRow: { table: 'pedidos', pk: 'pedido-1' },
      lastSkipped: 2,
    });
    expect(JSON.stringify(publicState)).not.toMatch(
      /token-herdado|segredo-herdado|nao-pode-sair|token-aninhado|token-no-pending|bearer-pending-secreto|token-no-blocked-row|select segredo|sql-aninhado/,
    );
  });

  it('ignora propriedades publicas herdadas mesmo quando os valores parecem validos', () => {
    const state = Object.create({
      lastSyncOk: true,
      pendingPush: 99,
      pendingByTable: { pedidos: 99 },
      caughtUp: true,
      phase: 'pulling',
      runningSince: '2026-07-14T13:39:27.312Z',
      lastSyncAt: '2026-07-14T13:39:27.312Z',
      lastSuccessAt: '2026-07-14T13:39:27.312Z',
      consecutiveFailures: 99,
      lastError: 'Bearer segredo-herdado',
      lastBlockedRow: { table: 'pedidos', pk: 'pedido-herdado' },
      lastSkipped: 99,
    });

    const publicState = publicSyncStatus(true, state);

    expect(publicState).toEqual({
      enabled: true,
      lastSyncOk: null,
      pendingPush: 0,
      pendingByTable: {},
      caughtUp: false,
      phase: 'error',
      runningSince: null,
      lastSyncAt: null,
      lastSuccessAt: null,
      consecutiveFailures: 0,
      lastError: null,
      lastBlockedRow: null,
      lastSkipped: 0,
    });
    expect(JSON.stringify(publicState)).not.toMatch(/segredo-herdado|pedido-herdado/);
  });

  it('substitui tipos e formatos invalidos por valores publicos seguros', () => {
    const pendingArray = Object.assign([], { pedidos: 12 });
    const blockedArray = Object.assign([], { table: 'pedidos', pk: 'pedido-array' });
    const state = {
      lastSyncOk: { raw: true },
      pendingPush: 1.5,
      pendingByTable: pendingArray,
      caughtUp: 'true',
      phase: 'paused',
      runningSince: ['2026-07-14T13:39:27.312Z'],
      lastSyncAt: '2026-07-14',
      lastSuccessAt: '2026-02-30T13:39:27.312Z',
      consecutiveFailures: -1,
      lastError: { authorization: 'Bearer segredo-no-erro' },
      lastBlockedRow: blockedArray,
      lastSkipped: Number.MAX_SAFE_INTEGER + 1,
    };

    const publicState = publicSyncStatus('true', state);

    expect(publicState).toEqual({
      enabled: false,
      lastSyncOk: null,
      pendingPush: 0,
      pendingByTable: {},
      caughtUp: false,
      phase: 'error',
      runningSince: null,
      lastSyncAt: null,
      lastSuccessAt: null,
      consecutiveFailures: 0,
      lastError: null,
      lastBlockedRow: null,
      lastSkipped: 0,
    });
    expect(JSON.stringify(publicState)).not.toMatch(/segredo-no-erro|pedido-array/);
  });

  it.each(['idle', 'pushing', 'pulling', 'error'])(
    'preserva a fase publica %s e booleanos ou nulos validos',
    (phase) => {
      expect(
        publicSyncStatus(true, {
          lastSyncOk: null,
          caughtUp: true,
          phase,
          runningSince: null,
          lastError: null,
        }),
      ).toMatchObject({
        enabled: true,
        lastSyncOk: null,
        caughtUp: true,
        phase,
        runningSince: null,
        lastError: null,
      });
    },
  );

  it('limita strings publicas e aceita apenas timestamps canonicos', () => {
    const maxError = 'x'.repeat(240);

    expect(publicSyncStatus(true, { lastError: maxError }).lastError).toBe(
      'Falha no ciclo de sincronizacao',
    );
    expect(publicSyncStatus(true, { lastError: 'x'.repeat(241) }).lastError).toBeNull();
    expect(publicSyncStatus(true, { lastError: 'linha 1\nlinha 2' }).lastError).toBeNull();
    expect(publicSyncStatus(true, { lastError: ['erro-publico'] }).lastError).toBeNull();
    expect(
      publicSyncStatus(true, {
        lastError: 'select encrypted_password from auth.users where email=private@example.com',
      }).lastError,
    ).toBe('Falha no ciclo de sincronizacao');
    expect(
      publicSyncStatus(true, { lastSyncAt: '2026-07-14T13:39:27.312Z' }).lastSyncAt,
    ).toBe('2026-07-14T13:39:27.312Z');
    expect(
      publicSyncStatus(true, { lastSyncAt: '2026-07-14T10:39:27.312-03:00' }).lastSyncAt,
    ).toBeNull();
  });

  it('descarta blockedRow fora do contrato seguro', () => {
    const state = {
      lastBlockedRow: {
        table: 'empresas',
        pk: 'pedido-1 token=segredo',
        rawError: { authorization: 'Bearer segredo' },
      },
    };

    expect(publicSyncStatus(true, state).lastBlockedRow).toBeNull();
  });
});

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
    expect(resolveAppEntrypoint(ROOT, null, null, exists)).toBe(installer);
  });

  it('usa .next/standalone/server.js (dev) quando o do instalador nao existe', () => {
    const exists = (p) => p === dev;
    expect(resolveAppEntrypoint(ROOT, null, null, exists)).toBe(dev);
  });

  it('prefere o do instalador quando ambos existem', () => {
    const exists = () => true;
    expect(resolveAppEntrypoint(ROOT, null, null, exists)).toBe(installer);
  });

  it('cai no layout dev quando nenhum existe (mensagem de erro aponta o esperado)', () => {
    const exists = () => false;
    expect(resolveAppEntrypoint(ROOT, null, null, exists)).toBe(dev);
  });
});

describe('resolveAppEntrypoint com ponteiro', () => {
  const root = '/srv';
  const rel = '/srv/releases';
  it('ponteiro presente + release existe → releases/<v>/server.js', () => {
    const exists = (p) => p === path.join(rel, '1.2.0', 'server.js');
    expect(resolveAppEntrypoint(root, rel, '1.2.0', exists)).toBe(path.join(rel, '1.2.0', 'server.js'));
  });
  it('ponteiro presente mas release não existe falha fechado', () => {
    const exists = (p) => p === path.join(root, 'app', 'server.js');
    expect(() => resolveAppEntrypoint(root, rel, '1.2.0', exists))
      .toThrow(/release.*1\.2\.0.*server\.js/i);
  });
  it('sem ponteiro → app/server.js quando existe', () => {
    const exists = (p) => p === path.join(root, 'app', 'server.js');
    expect(resolveAppEntrypoint(root, rel, null, exists)).toBe(path.join(root, 'app', 'server.js'));
  });
  it('sem ponteiro e sem app → dev standalone', () => {
    const exists = () => false;
    expect(resolveAppEntrypoint(root, rel, null, exists)).toBe(path.join(root, '.next', 'standalone', 'server.js'));
  });
});

describe('coordenação do auto-update', () => {
  it('não sobrepõe timers e aguarda a atualização ativa no shutdown', () => {
    const startup = maestroSource.slice(maestroSource.indexOf('export async function startMaestro'));
    expect(startup).toContain('let activeUpdate = null');
    expect(startup).toMatch(/if\s*\(activeUpdate\)\s*return\s+activeUpdate/);
    expect(startup).toMatch(/activeUpdate\s*=\s*checkAndUpdate/);
    expect(startup).toMatch(/if\s*\(activeUpdate\)\s*await\s+activeUpdate/);
  });

  it('health exige /status completo e confirma a versão esperada do ponteiro', () => {
    const autoUpdate = maestroSource.slice(maestroSource.indexOf('// 5. auto-update periódico'));
    expect(autoUpdate).toMatch(/preflight[\s\S]*assertCompleteHubStatus[\s\S]*status\(\)/);
    expect(autoUpdate).toMatch(/health\s*=\s*async\s*\(expectedVersion\)/);
    expect(autoUpdate).toMatch(/waitForCompleteHubStatus[\s\S]*\/status/);
    expect(autoUpdate).toMatch(/readPointerSync\(ptrPath\)[\s\S]*expectedVersion/);
  });
});

describe('readPointerSync', () => {
  it('lê e trima o ponteiro; ausente → null', () => {
    expect(readPointerSync('/x', () => '  1.2.0\n')).toBe('1.2.0');
    expect(readPointerSync('/x', () => { throw new Error('enoent'); })).toBe(null);
    expect(readPointerSync('/x', () => '   ')).toBe(null);
  });
});

describe('currentAppVersion', () => {
  it('ponteiro tem precedência; senão cfg.version; senão 0.0.0', () => {
    expect(currentAppVersion('1.3.0', '1.0.0')).toBe('1.3.0');
    expect(currentAppVersion(null, '1.0.0')).toBe('1.0.0');
    expect(currentAppVersion(null, undefined)).toBe('0.0.0');
  });
});

describe('appRuntimeEnv', () => {
  const cfg = {
    ports: { app: 3000, gateway: 54320 },
    agent: { syncNowPort: 5005 },
  };
  const keys = { anon: 'anon-key', service: 'service-key' };

  it('liga o botão Sincronizar ao agente local por padrão', () => {
    expect(appRuntimeEnv(cfg, keys, undefined)).toMatchObject({
      EXPED_HUB: '1',
      AGENT_SYNC_URL: 'http://127.0.0.1:5005',
    });
  });

  it('aceita porta customizada pelo contrato do Hub', () => {
    const env = appRuntimeEnv(
      { ...cfg, agent: { syncNowPort: 6005 } },
      keys,
      undefined,
    );
    expect(env.AGENT_SYNC_URL).toBe('http://127.0.0.1:6005');
  });

  it('ignora AGENT_SYNC_URL herdada e mantém a porta canônica', () => {
    expect(appRuntimeEnv(cfg, keys, 'http://127.0.0.1:6005').AGENT_SYNC_URL).toBe(
      'http://127.0.0.1:5005',
    );
  });

  it('não expõe a ação quando o sync sob demanda está desativado', () => {
    const env = appRuntimeEnv(
      { ...cfg, agent: { syncNowPort: 0 } },
      keys,
      undefined,
    );
    expect(env).not.toHaveProperty('AGENT_SYNC_URL');
  });

  it('zero sempre desativa, mesmo com AGENT_SYNC_URL herdada', () => {
    const env = appRuntimeEnv(
      { ...cfg, agent: { syncNowPort: 0 } },
      keys,
      'http://127.0.0.1:6005',
    );
    expect(env).not.toHaveProperty('AGENT_SYNC_URL');
  });
});
