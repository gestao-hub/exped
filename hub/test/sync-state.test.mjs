import { describe, expect, it } from 'vitest';

import { createSyncState, finishAttempt, sanitizeSyncError } from '../sync-state.mjs';

describe('sync state', () => {
  it('distingue sucesso com backlog de caught up', () => {
    const state = createSyncState(['clientes', 'pedidos']);

    finishAttempt(state, {
      ok: true,
      error: null,
      pendingByTable: { clientes: 0, pedidos: 30 },
      lastSkipped: 0,
      lastBlockedRow: null,
      at: '2026-07-14T13:39:27.312Z',
    });

    expect(state).toMatchObject({
      lastSyncOk: true,
      pendingPush: 30,
      caughtUp: false,
      phase: 'idle',
      runningSince: null,
      lastSuccessAt: '2026-07-14T13:39:27.312Z',
      consecutiveFailures: 0,
    });
  });

  it('conta falhas consecutivas e sanitiza SQL, caminhos e multilinha', () => {
    const state = createSyncState(['pedidos']);

    for (let i = 0; i < 2; i += 1) {
      finishAttempt(state, {
        ok: false,
        error: 'psql C:\\TEMP\\x.sql\nduplicate key detail secreto@example.com bearer abc',
        pendingByTable: { pedidos: 1 },
        lastSkipped: 0,
        lastBlockedRow: { table: 'pedidos', pk: 'p1' },
        at: `2026-07-14T13:39:2${i}.000Z`,
      });
    }

    expect(state).toMatchObject({
      consecutiveFailures: 2,
      phase: 'error',
      caughtUp: false,
      runningSince: null,
    });
    expect(sanitizeSyncError(state.lastError)).toBe('Falha no ciclo de sincronizacao');
    expect(state.lastError).not.toMatch(/TEMP|duplicate key|example\.com|bearer/i);
  });

  it('não anuncia caught up quando a contagem exata falha', () => {
    const state = createSyncState(['pedidos']);

    finishAttempt(state, {
      ok: false,
      error: 'select count(*) from pedidos where email = private@example.com',
      pendingByTable: { pedidos: 0 },
      backlogCounted: false,
      lastSkipped: 0,
      lastBlockedRow: null,
      at: '2026-07-14T13:40:00.000Z',
    });

    expect(state).toMatchObject({
      lastSyncOk: false,
      pendingPush: 0,
      caughtUp: false,
      lastSuccessAt: null,
      lastError: 'Falha no ciclo de sincronizacao',
    });
  });

  it('não anuncia caught up quando o ciclo falha com backlog contado em zero', () => {
    const state = createSyncState(['pedidos']);

    finishAttempt(state, {
      ok: false,
      error: 'push HTTP 503',
      pendingByTable: { pedidos: 0 },
      backlogCounted: true,
      lastSkipped: 0,
      lastBlockedRow: null,
      at: '2026-07-14T13:41:00.000Z',
    });

    expect(state).toMatchObject({
      lastSyncOk: false,
      pendingPush: 0,
      caughtUp: false,
      lastError: 'push HTTP 503',
    });
  });

  it('registra a janela Retry-After sem aceitar valores arbitrários', () => {
    const state = createSyncState(['pedidos']);

    finishAttempt(state, {
      ok: false,
      error: 'push HTTP 503',
      retryAfterMs: 30_000,
      pendingByTable: { pedidos: 1 },
      at: '2026-07-14T13:41:00.000Z',
    });

    expect(state.retryAfterUntil).toBe('2026-07-14T13:41:30.000Z');

    finishAttempt(state, {
      ok: false,
      error: 'push HTTP 503',
      retryAfterMs: Number.POSITIVE_INFINITY,
      pendingByTable: { pedidos: 1 },
      at: '2026-07-14T13:42:00.000Z',
    });
    expect(state.retryAfterUntil).toBeNull();
  });

  it.each([undefined, null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'falha fechado quando a contagem de backlog e invalida: %s',
    (invalidCount) => {
      const state = createSyncState(['pedidos']);

      finishAttempt(state, {
        ok: true,
        error: null,
        pendingByTable: { pedidos: invalidCount },
        backlogCounted: true,
        lastSkipped: 0,
        lastBlockedRow: null,
        at: '2026-07-14T13:42:00.000Z',
      });

      expect(state).toMatchObject({
        lastSyncOk: false,
        caughtUp: false,
        phase: 'error',
        lastError: 'Falha no ciclo de sincronizacao',
      });
    },
  );

  it.each([
    "falha ao abrir '/srv/exped/private/arquivo'",
    'upstream em http://127.0.0.1:5432/admin',
    ['cabecalho-falso', 'payload-falso', 'assinatura-falsa']
      .map((part) => Buffer.from(part).toString('base64url'))
      .join('.'),
    'boom-offline arbitrario',
  ])('remove detalhe sensível isolado do estado: %s', (message) => {
    const sanitized = sanitizeSyncError(message);
    expect(sanitized).toBe('Falha no ciclo de sincronizacao');
    expect(sanitized).not.toContain(message);
  });

  it.each([
    'ECONNREFUSED',
    'ETIMEDOUT',
    'fetch failed',
    'push HTTP 403',
    'pull HTTP 503',
  ])('preserva somente diagnóstico operacional allowlisted: %s', (message) => {
    expect(sanitizeSyncError(message)).toBe(message);
  });
});
