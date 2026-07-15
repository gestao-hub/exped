import { describe, it, expect } from 'vitest';
import {
  assertCompleteHubStatus,
  projectAgentReadiness,
  waitForHttp,
  waitForProbe,
  tcpAlive,
} from '../health.mjs';
import http from 'node:http';
import net from 'node:net';

describe('health', () => {
  it('waitForHttp resolve quando o endpoint responde <500', async () => {
    const srv = http.createServer((_, res) => { res.statusCode = 200; res.end('ok'); }).listen(0);
    const port = srv.address().port;
    await expect(waitForHttp(`http://127.0.0.1:${port}/`, 2000)).resolves.toBe(true);
    srv.close();
  });
  it('waitForHttp rejeita se nunca responde', async () => {
    await expect(waitForHttp('http://127.0.0.1:1/', 800)).rejects.toThrow();
  });

  it('waitForProbe aguarda a prontidao real, nao apenas o primeiro sinal parcial', async () => {
    let attempts = 0;

    await expect(waitForProbe(
      async () => ++attempts >= 3,
      { label: 'postgres accepting connections', timeoutMs: 100, intervalMs: 1 },
    )).resolves.toBe(true);

    expect(attempts).toBe(3);
  });

  it('waitForProbe rejeita com o nome do componente no timeout', async () => {
    await expect(waitForProbe(
      async () => false,
      { label: 'postgres accepting connections', timeoutMs: 5, intervalMs: 1 },
    )).rejects.toThrow('postgres accepting connections');
  });

  it('tcpAlive resolve true quando a porta aceita conexão', async () => {
    const srv = net.createServer((s) => s.end()).listen(0);
    const port = srv.address().port;
    await expect(tcpAlive('127.0.0.1', port, 1000)).resolves.toBe(true);
    srv.close();
  });
  it('tcpAlive resolve false (sem lançar) quando nada escuta na porta', async () => {
    const srv = net.createServer().listen(0);
    const port = srv.address().port;
    await new Promise((r) => srv.close(r)); // libera a porta antes do probe
    await expect(tcpAlive('127.0.0.1', port, 500)).resolves.toBe(false);
  });
});

describe('health completo do instalador', () => {
  const complete = () => ({
    storage: { running: true },
    peers: ['postgres', 'postgrest', 'gotrue', 'gateway', 'app', 'events', 'frontdoor']
      .map((name) => ({ name, running: true })),
    agent: {
      enabled: true,
      startupMode: 'interactive_logon',
      survivesRebootWithoutLogon: false,
      running: true,
      syncNowPort: 5005,
      syncNowReady: true,
      hiper: {
        connected: true,
        queryOk: true,
        schemaCompatible: true,
        targetSchema: 'Exped Agent schema v1',
      },
    },
    sync: {
      enabled: true,
      lastError: null,
      lastSyncOk: true,
      lastSyncAt: '2026-07-14T13:39:27.312Z',
    },
  });

  it('aceita storage, peers, Agent/Hiper e sync saudaveis', () => {
    expect(assertCompleteHubStatus(complete())).toBe(true);
  });

  it.each([
    ['storage', (s) => { s.storage.running = false; }],
    ['peer', (s) => { s.peers[0].running = false; }],
    ['Agent', (s) => { s.agent.running = false; }],
    ['botao Sincronizar', (s) => { s.agent.syncNowReady = false; }],
    ['Hiper', (s) => { s.agent.hiper.queryOk = false; }],
    ['contrato de schema Hiper', (s) => { s.agent.hiper.targetSchema = 'outro contrato'; }],
    ['sync', (s) => { s.sync.lastError = 'cloud bloqueado'; }],
    ['sync sem ciclo concluido', (s) => { s.sync.lastSyncOk = null; }],
    ['sync sem horario valido', (s) => { s.sync.lastSyncAt = null; }],
  ])('rejeita status incompleto em %s', (_, mutate) => {
    const status = complete();
    mutate(status);
    expect(() => assertCompleteHubStatus(status)).toThrow();
  });

  it('aceita hub-only somente quando o Agent esta explicitamente disabled', () => {
    const status = complete();
    status.agent = {
      enabled: false,
      running: false,
      startupMode: 'disabled',
      survivesRebootWithoutLogon: false,
      syncNowPort: 0,
      syncNowReady: false,
    };
    expect(assertCompleteHubStatus(status)).toBe(true);
  });

  it('nao confunde Agent em execucao com consulta Hiper funcionando', () => {
    const now = Date.parse('2026-07-14T12:00:00.000Z');
    const status = projectAgentReadiness({
      pid: 197,
      checkedAt: '2026-07-14T11:59:55.000Z',
      agentVersion: '1.4.5',
      hiper: {
        connected: true,
        queryOk: false,
        schemaCompatible: false,
        targetSchema: 'Exped Agent schema v1',
        error: 'coluna ausente',
      },
    }, { now, maxAgeMs: 30_000 });

    expect(status.running).toBe(true);
    expect(status.hiper.queryOk).toBe(false);
    expect(status.hiper.schemaCompatible).toBe(false);
  });

  it('projeta a conclusao causal mais recente do controle Sincronizar', () => {
    const status = projectAgentReadiness({
      pid: 197,
      checkedAt: '2026-07-14T12:00:05.000Z',
      agentVersion: '1.4.5',
      lastSyncNowAt: '2026-07-14T12:00:04.000Z',
      lastSyncNowOk: true,
      lastSyncNowSynced: 3,
      hiper: {},
    }, { now: Date.parse('2026-07-14T12:00:10.000Z') });

    expect(status.lastSyncNowAt).toBe('2026-07-14T12:00:04.000Z');
    expect(status.lastSyncNowOk).toBe(true);
    expect(status.lastSyncNowSynced).toBe(3);
  });
});
