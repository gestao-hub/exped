import { describe, it, expect } from 'vitest';

import { runPull, runPush, type SyncDb, type Row } from '../engine';
import { mergeRow } from '../merge';
import type { SyncTable, TwoWaySyncTable } from '../tables';
// hub client é .mjs (contrato estável — ver hub/sync.mjs).
import { getState, syncOnce } from '../../../hub/sync.mjs';

/**
 * Simulação E2E em memória: uma "nuvem" (db in-memory que roda a lógica REAL de
 * runPush/runPull + mergeRow) e N "hubs" (cada um com seu db local + cursores),
 * trocando lotes via funções injetadas em syncOnce (pushFn/pullFn) — SEM rede.
 *
 * A nuvem é a MESMA implementação de produção (lib/sync/engine.ts). O cliente é o
 * MESMO de produção (hub/sync.mjs). Só os transportes (pushFn/pullFn) e os "db"
 * são fakes em memória — é aí que mora a simulação, não na lógica.
 */

// ---------------------------------------------------------------------------
// CLOUD — SyncDb em memória rodando runPush/runPull reais. Reaproveita o padrão
// do engine.test.ts (escopo por empresa direto via empresa_id ou via pais).
// ---------------------------------------------------------------------------
function makeCloud(seed: Record<string, Row[]> = {}) {
  const store: Record<string, Row[]> = {};
  for (const [k, v] of Object.entries(seed)) store[k] = v.map((r) => ({ ...r }));

  // empresa_id de cada id de pai (pra validar/escopar filhas). Recalculado on-demand
  // pra refletir pais inseridos durante o teste.
  function parentEmpresaOf(parentTable: string, parentId: unknown): string | undefined {
    const p = (store[parentTable] ?? []).find((r) => String(r.id) === String(parentId));
    if (!p) return undefined;
    if (p.empresa_id !== undefined) return String(p.empresa_id);
    // pai também é filha (cadeia): resolve recursivamente pelos parents conhecidos.
    for (const [pt, fk] of PARENT_CHAIN[parentTable] ?? []) {
      const r = parentEmpresaOf(pt, p[fk]);
      if (r) return r;
    }
    return undefined;
  }

  const pullPk = (table: string, row: Row) => {
    const pk = TABLE_BY_NAME[table]?.pk ?? 'id';
    const column = Array.isArray(pk) ? pk[pk.length - 1] : pk;
    return String(row[column] ?? '');
  };

  const db: SyncDb = {
    async selectChanges(table, empresaId, cursor, limit, cursorPk?: string) {
      const rows = (store[table] ?? []).filter((r) => {
        let inScope: boolean;
        if (r.empresa_id !== undefined) inScope = r.empresa_id === empresaId;
        else {
          // filha: escopo via ancestral
          const t = TABLE_BY_NAME[table];
          inScope = t?.parent
            ? parentEmpresaOf(t.parent.table, r[t.parent.fk]) === empresaId
            : true;
        }
        const updatedAt = String(r.updated_at ?? '');
        return inScope && (
          updatedAt > cursor ||
          (cursorPk !== undefined && updatedAt === cursor && pullPk(table, r) > cursorPk)
        );
      });
      rows.sort((a, b) => (
        String(a.updated_at).localeCompare(String(b.updated_at)) ||
        pullPk(table, a).localeCompare(pullPk(table, b))
      ));
      return rows.slice(0, limit).map((r) => ({ ...r }));
    },
    async findCanonical(table: TwoWaySyncTable, empresaId, pk) {
      const found = (store[table.name] ?? []).find((r) => r[table.pk] === pk);
      if (!found) return null;
      if (found.empresa_id !== undefined && found.empresa_id !== empresaId) return null;
      if (found.empresa_id === undefined && table.parent) {
        if (parentEmpresaOf(table.parent.table, found[table.parent.fk]) !== empresaId) return null;
      }
      return { ...found };
    },
    async findCanonicalGlobal(table: TwoWaySyncTable, pk) {
      const found = (store[table.name] ?? []).find((r) => r[table.pk] === pk);
      return found ? { ...found } : null;
    },
    async parentBelongsToEmpresa(parentTable, parentId, empresaId) {
      return parentEmpresaOf(parentTable, parentId) === empresaId;
    },
    async findCanonicalMany(table: TwoWaySyncTable, empresaId, pks) {
      const map = new Map<string, Row>();
      for (const pk of pks) {
        const f = await this.findCanonical(table, empresaId, pk);
        if (f) map.set(String(pk), f);
      }
      return map;
    },
    async parentsInEmpresa(parentTable, parentIds, empresaId) {
      const set = new Set<string>();
      for (const id of parentIds) {
        if (await this.parentBelongsToEmpresa(parentTable, id, empresaId)) set.add(String(id));
      }
      return set;
    },
    async mergeAndUpsert(table, empresaId, row) {
      store[table.name] = store[table.name] ?? [];
      const idx = store[table.name].findIndex((candidate) => candidate[table.pk] === row[table.pk]);
      const existing = idx >= 0 ? store[table.name][idx] : null;

      if (existing?.empresa_id !== undefined && existing.empresa_id !== empresaId) return null;
      if (existing?.empresa_id === undefined && existing && table.parent) {
        if (parentEmpresaOf(table.parent.table, existing[table.parent.fk]) !== empresaId) return null;
      }
      if (table.parent && parentEmpresaOf(table.parent.table, row[table.parent.fk]) !== empresaId) {
        return null;
      }

      const saved = existing ? mergeRow(row, existing) as Row : { ...row };
      if (saved.empresa_id !== undefined) saved.empresa_id = empresaId;
      saved.updated_at = Object.values(
        (saved.field_updated_at ?? {}) as Record<string, string>,
      ).filter((value): value is string => typeof value === 'string').sort().at(-1) ?? EPOCH;
      if (idx >= 0) store[table.name][idx] = saved;
      else store[table.name].push(saved);
      return { ...saved };
    },
    async upsertRaw(table, row) {
      store[table] = store[table] ?? [];
      const idx = store[table].findIndex((r) => r.id === row.id);
      if (idx >= 0) {
        const existing = store[table][idx];
        if (
          existing.empresa_id !== undefined &&
          row.empresa_id !== undefined &&
          existing.empresa_id !== row.empresa_id
        ) {
          return null; // guarda where empresa_id do RPC → 0 linhas
        }
        store[table][idx] = { ...row };
      } else {
        store[table].push({ ...row });
      }
      return { ...row };
    },
    async setSyncReplica() {
      /* no-op: o fake não tem trigger */
    },
    async selectAuthUsers(empresaId, cursor, limit, cursorPk?: string) {
      const profIds = new Set(
        (store.profiles ?? []).filter((p) => p.empresa_id === empresaId).map((p) => String(p.id)),
      );
      const rows = (store['auth.users'] ?? []).filter((u) => {
        const updatedAt = String(u.updated_at ?? '');
        return profIds.has(String(u.id)) && (
          updatedAt > cursor ||
          (cursorPk !== undefined && updatedAt === cursor && String(u.id) > cursorPk)
        );
      });
      rows.sort((a, b) => (
        String(a.updated_at).localeCompare(String(b.updated_at)) ||
        String(a.id).localeCompare(String(b.id))
      ));
      return rows.slice(0, limit).map((r) => ({ ...r }));
    },
  };

  return { db, store };
}

const PARENT_CHAIN: Record<string, [string, string][]> = {
  pedido_pontos_retirada: [['pedidos', 'pedido_id']],
  pedido_itens: [['pedido_pontos_retirada', 'ponto_retirada_id']],
  os_itens: [['ordens_servico', 'os_id']],
  os_servicos: [['ordens_servico', 'os_id']],
};
const TABLE_BY_NAME: Record<string, SyncTable> = Object.fromEntries(
  [
    { name: 'clientes', pk: 'id', dir: 'two-way' },
    { name: 'pedidos', pk: 'id', dir: 'two-way' },
    { name: 'pedido_pontos_retirada', pk: 'id', dir: 'two-way', parent: { table: 'pedidos', fk: 'pedido_id' } },
    { name: 'pedido_itens', pk: 'id', dir: 'two-way', parent: { table: 'pedido_pontos_retirada', fk: 'ponto_retirada_id' } },
    { name: 'ordens_servico', pk: 'id', dir: 'two-way' },
    { name: 'os_itens', pk: 'id', dir: 'two-way', parent: { table: 'ordens_servico', fk: 'os_id' } },
    { name: 'os_servicos', pk: 'id', dir: 'two-way', parent: { table: 'ordens_servico', fk: 'os_id' } },
    { name: 'os_notificacoes', pk: 'id', dir: 'two-way' },
  ].map((t) => [t.name, t as SyncTable]),
);

// ---------------------------------------------------------------------------
// HUB — db local em memória (mesma interface mínima do hub/test/sync.test.mjs).
// ---------------------------------------------------------------------------
const EPOCH = '1970-01-01T00:00:00Z';
type HubCursor = { pull_at: string; pull_pk: string; push_at: string; push_pk: string };
type PushCursor = { at: string; pk: string };

function makeHubDb() {
  const tables = new Map<string, Map<unknown, Row>>();
  const cursors = new Map<string, HubCursor>();
  const tbl = (name: string) => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name)!;
  };
  const changedRows = (table: string, pk: string, cursor: PushCursor) => (
    [...tbl(table).values()]
      .filter((row) => {
        const at = String(row.updated_at ?? '');
        const rowPk = String(row[pk] ?? '');
        return at > cursor.at || (at === cursor.at && rowPk > cursor.pk);
      })
      .sort((a, b) => {
        const byTime = String(a.updated_at).localeCompare(String(b.updated_at));
        return byTime || String(a[pk]).localeCompare(String(b[pk]));
      })
  );
  return {
    async ensureCursorTable() {},
    async getCursor(table: string) {
      return cursors.get(table) || { pull_at: EPOCH, pull_pk: '', push_at: EPOCH, push_pk: '' };
    },
    async setCursor(
      table: string,
      patch: { pull_at?: string; pull_pk?: string; push_at?: string; push_pk?: string },
    ) {
      const cur = cursors.get(table) || { pull_at: EPOCH, pull_pk: '', push_at: EPOCH, push_pk: '' };
      cursors.set(table, { ...cur, ...patch });
    },
    async selectChanged(table: string, pk: string, cursor: PushCursor, limit: number) {
      return changedRows(table, pk, cursor).slice(0, limit).map((row) => ({ ...row }));
    },
    async countChanged(table: string, pk: string, cursor: PushCursor) {
      return changedRows(table, pk, cursor).length;
    },
    async upsert(table: string, pk: string, row: Row) {
      tbl(table).set(row[pk], { ...row });
    },
    async applyCanonicalPage(
      table: string,
      pk: string,
      rows: Row[],
      cursor: { pull_at?: string; pull_pk?: string; push_at?: string; push_pk?: string },
    ) {
      const rowsBefore = new Map(
        [...tbl(table)].map(([key, row]) => [key, { ...row }]),
      );
      const hadCursor = cursors.has(table);
      const cursorBefore = hadCursor ? { ...cursors.get(table)! } : null;
      try {
        for (const row of rows) await this.upsert(table, pk, row);
        await this.setCursor(table, cursor);
      } catch (error) {
        tables.set(table, rowsBefore);
        if (hadCursor && cursorBefore) cursors.set(table, cursorBefore);
        else cursors.delete(table);
        throw error;
      }
    },
    async upsertAuthUser(row: Row) {
      tbl('auth.users').set(row.id, { ...row });
    },
    async listPendingIdentityAliases() {
      return [];
    },
    // helpers de teste
    get(table: string, id: unknown) {
      return tbl(table).get(id);
    },
    count(table: string) {
      return tbl(table).size;
    },
    seed(table: string, row: Row) {
      tbl(table).set(row[(TABLE_BY_NAME[table]?.pk ?? 'id') as string], { ...row });
    },
  };
}

// ---------------------------------------------------------------------------
// Transportes que ligam hub↔nuvem usando a lógica REAL do engine, sem rede.
// `as` = empresa do dispositivo (escopo aplicado server-side pelo engine).
// ---------------------------------------------------------------------------
function makeTransports(cloud: ReturnType<typeof makeCloud>, empresaId: string) {
  return {
    pushFn: async ({ rows }: { rows: Record<string, Row[]> }) => {
      // runPush pode lançar PushError(status) — o syncOnce trata 403 e relança o resto.
      return await runPush(cloud.db, empresaId, rows);
    },
    pullFn: async ({
      cursors,
      identityOnly,
    }: {
      cursors: Record<string, string>;
      identityOnly?: boolean;
    }) => {
      return await runPull(cloud.db, empresaId, cursors, { identityOnly });
    },
  };
}

/** Um ciclo completo de sync de um hub (push+pull) contra a nuvem. */
async function cycle(hubDb: ReturnType<typeof makeHubDb>, cloud: ReturnType<typeof makeCloud>, empresaId: string) {
  const { pushFn, pullFn } = makeTransports(cloud, empresaId);
  return syncOnce({ db: hubDb, apiBase: 'mem://cloud', deviceToken: 'tok', pushFn, pullFn });
}

const E1 = 'E1';

/** Deep clone de uma Row (inclui field_updated_at aninhado) — evita seeds compartilharem referência. */
function clone(r: Row): Row {
  return JSON.parse(JSON.stringify(r));
}

describe('E2E sync — cenários multi-hub + nuvem (lógica real)', () => {
  it('adapter keyset envia 530 empates em duas páginas sem perder backlog', async () => {
    const cloud = makeCloud();
    const hub = makeHubDb();
    const timestamp = '2026-07-14T12:00:00.123456Z';
    for (let i = 0; i < 530; i += 1) {
      hub.seed('clientes', {
        id: `c${String(i).padStart(4, '0')}`,
        empresa_id: E1,
        nome: `Cliente ${i}`,
        updated_at: timestamp,
        field_updated_at: { nome: timestamp },
      });
    }
    const transports = makeTransports(cloud, E1);
    const pageSizes: number[] = [];

    const first = await syncOnce({
      db: hub,
      apiBase: 'mem://cloud',
      deviceToken: 'tok',
      maxPushPages: 1,
      pushFn: async ({ rows }: { rows: Record<string, Row[]> }) => {
        pageSizes.push(rows.clientes.length);
        return transports.pushFn({ rows });
      },
      pullFn: transports.pullFn,
    });

    expect(first.ok).toBe(true);
    expect(pageSizes).toEqual([500]);
    expect(cloud.store.clientes).toHaveLength(500);
    expect(getState()).toMatchObject({
      pendingByTable: expect.objectContaining({ clientes: 30 }),
      pendingPush: 30,
      caughtUp: false,
    });

    const second = await syncOnce({
      db: hub,
      apiBase: 'mem://cloud',
      deviceToken: 'tok',
      pushFn: async ({ rows }: { rows: Record<string, Row[]> }) => {
        pageSizes.push(rows.clientes.length);
        return transports.pushFn({ rows });
      },
      pullFn: transports.pullFn,
    });

    expect(second.ok).toBe(true);
    expect(pageSizes).toEqual([500, 30]);
    expect(cloud.store.clientes).toHaveLength(530);
    expect(new Set(cloud.store.clientes.map((row) => row.id)).size).toBe(530);
    expect(await hub.getCursor('clientes')).toMatchObject({
      push_at: timestamp,
      push_pk: 'c0529',
    });
    expect(getState()).toMatchObject({ pendingPush: 0, caughtUp: true });
  });

  it('conflito por campo: A muda endereco, B muda telefone do MESMO cliente → ambos sobrevivem', async () => {
    // Nuvem tem o cliente canônico; os dois hubs partem dele já sincronizado.
    const base: Row = {
      id: 'c1',
      empresa_id: E1,
      nome: 'Ana',
      endereco: 'Rua Velha',
      telefone: '1111',
      updated_at: '2026-01-01T00:00:00Z',
      field_updated_at: {
        nome: '2026-01-01T00:00:00Z',
        endereco: '2026-01-01T00:00:00Z',
        telefone: '2026-01-01T00:00:00Z',
      },
    };
    const cloud = makeCloud({ clientes: [clone(base)] });
    const hubA = makeHubDb();
    const hubB = makeHubDb();
    hubA.seed('clientes', clone(base));
    hubB.seed('clientes', clone(base));

    // Hub A edita endereco
    hubA.get('clientes', 'c1')!.endereco = 'Rua Nova A';
    hubA.get('clientes', 'c1')!.updated_at = '2026-02-01T00:00:00Z';
    (hubA.get('clientes', 'c1')!.field_updated_at as Record<string, string>).endereco = '2026-02-01T00:00:00Z';

    // Hub B edita telefone
    hubB.get('clientes', 'c1')!.telefone = '9999';
    hubB.get('clientes', 'c1')!.updated_at = '2026-02-02T00:00:00Z';
    (hubB.get('clientes', 'c1')!.field_updated_at as Record<string, string>).telefone = '2026-02-02T00:00:00Z';

    // Ambos sincronizam (push→cloud→pull). Roda 2 rodadas pra propagar o que o outro subiu.
    await cycle(hubA, cloud, E1);
    await cycle(hubB, cloud, E1);
    await cycle(hubA, cloud, E1);
    await cycle(hubB, cloud, E1);

    const cCloud = cloud.store.clientes[0];
    expect(cCloud.endereco).toBe('Rua Nova A');
    expect(cCloud.telefone).toBe('9999');
    expect(hubA.get('clientes', 'c1')!.endereco).toBe('Rua Nova A');
    expect(hubA.get('clientes', 'c1')!.telefone).toBe('9999');
    expect(hubB.get('clientes', 'c1')!.endereco).toBe('Rua Nova A');
    expect(hubB.get('clientes', 'c1')!.telefone).toBe('9999');
  });

  it('3 sites: 3 hubs editam campos diferentes do mesmo pedido → todos + cloud convergem idênticos', async () => {
    const base: Row = {
      id: 'p1',
      empresa_id: E1,
      observacao: 'obs',
      forma_pagamento: 'pix',
      vendedor: 'V0',
      updated_at: '2026-01-01T00:00:00Z',
      field_updated_at: {
        observacao: '2026-01-01T00:00:00Z',
        forma_pagamento: '2026-01-01T00:00:00Z',
        vendedor: '2026-01-01T00:00:00Z',
      },
    };
    const cloud = makeCloud({ pedidos: [{ ...base }] });
    const hubs = [makeHubDb(), makeHubDb(), makeHubDb()];
    for (const h of hubs) h.seed('pedidos', clone(base));

    const edits: [number, string, unknown, string][] = [
      [0, 'observacao', 'obs-A', '2026-03-01T00:00:00Z'],
      [1, 'forma_pagamento', 'boleto', '2026-03-02T00:00:00Z'],
      [2, 'vendedor', 'V-C', '2026-03-03T00:00:00Z'],
    ];
    for (const [i, col, val, ts] of edits) {
      const row = hubs[i].get('pedidos', 'p1')!;
      row[col] = val;
      row.updated_at = ts as string;
      (row.field_updated_at as Record<string, string>)[col] = ts as string;
    }

    // 2 rodadas completas garantem convergência total entre os 3.
    for (let r = 0; r < 2; r++) for (const h of hubs) await cycle(h, cloud, E1);

    const expected = { observacao: 'obs-A', forma_pagamento: 'boleto', vendedor: 'V-C' };
    const cCloud = cloud.store.pedidos[0];
    expect({ observacao: cCloud.observacao, forma_pagamento: cCloud.forma_pagamento, vendedor: cCloud.vendedor }).toEqual(expected);
    for (const h of hubs) {
      const row = h.get('pedidos', 'p1')!;
      expect({ observacao: row.observacao, forma_pagamento: row.forma_pagamento, vendedor: row.vendedor }).toEqual(expected);
    }
  });

  it('última-edição-vence no MESMO campo: vence field_updated_at maior; ambos convergem', async () => {
    const base: Row = {
      id: 'c1',
      empresa_id: E1,
      nome: 'Ana',
      updated_at: '2026-01-01T00:00:00Z',
      field_updated_at: { nome: '2026-01-01T00:00:00Z' },
    };
    const cloud = makeCloud({ clientes: [{ ...base }] });
    const hubA = makeHubDb();
    const hubB = makeHubDb();
    hubA.seed('clientes', clone(base));
    hubB.seed('clientes', clone(base));

    // A edita nome mais cedo, B mais tarde — B deve vencer.
    const a = hubA.get('clientes', 'c1')!;
    a.nome = 'Ana-A';
    a.updated_at = '2026-04-01T00:00:00Z';
    (a.field_updated_at as Record<string, string>).nome = '2026-04-01T00:00:00Z';
    const b = hubB.get('clientes', 'c1')!;
    b.nome = 'Ana-B';
    b.updated_at = '2026-05-01T00:00:00Z';
    (b.field_updated_at as Record<string, string>).nome = '2026-05-01T00:00:00Z';

    // A sobe primeiro, depois B sobrescreve no campo; rodadas extras propagam.
    await cycle(hubA, cloud, E1);
    await cycle(hubB, cloud, E1);
    await cycle(hubA, cloud, E1);
    await cycle(hubB, cloud, E1);

    expect(cloud.store.clientes[0].nome).toBe('Ana-B');
    expect(hubA.get('clientes', 'c1')!.nome).toBe('Ana-B');
    expect(hubB.get('clientes', 'c1')!.nome).toBe('Ana-B');
  });

  it('queda no meio: push confirma mas o pull seguinte falha; re-executa → sem duplicar, estado correto', async () => {
    const cloud = makeCloud();
    const hub = makeHubDb();
    hub.seed('clientes', {
      id: 'c1',
      empresa_id: E1,
      nome: 'Novo',
      updated_at: '2026-02-01T00:00:00Z',
      field_updated_at: { nome: '2026-02-01T00:00:00Z' },
    });

    const { pushFn } = makeTransports(cloud, E1);
    // 1º ciclo: push OK, pull LANÇA (rede caiu logo após confirmar o push).
    const failingPull = async ({
      cursors,
      identityOnly,
    }: {
      cursors: Record<string, string>;
      identityOnly?: boolean;
    }) => {
      if (identityOnly) {
        return runPull(cloud.db, E1, cursors, { identityOnly: true });
      }
      throw new Error('ECONNRESET no pull');
    };
    const res1 = await syncOnce({ db: hub, apiBase: 'mem://cloud', deviceToken: 'tok', pushFn, pullFn: failingPull });
    expect(res1.ok).toBe(false); // pull falhou
    // O push JÁ confirmou na nuvem.
    expect(cloud.store.clientes).toHaveLength(1);
    expect(cloud.store.clientes[0].nome).toBe('Novo');

    // 2º ciclo: ciclo completo normal. Não pode duplicar nem regredir.
    await cycle(hub, cloud, E1);
    expect(cloud.store.clientes).toHaveLength(1); // sem duplicata
    expect(hub.count('clientes')).toBe(1);
    expect(hub.get('clientes', 'c1')!.nome).toBe('Novo');
  });

  it('fila acumulada: 50 mudanças offline → ao reconectar, um ciclo sobe todas', async () => {
    const cloud = makeCloud();
    const hub = makeHubDb();
    // 50 clientes criados "offline" (cloud nunca foi tocado ainda).
    for (let i = 0; i < 50; i++) {
      const n = String(i).padStart(2, '0');
      hub.seed('clientes', {
        id: `c${n}`,
        empresa_id: E1,
        nome: `Cliente ${n}`,
        updated_at: `2026-02-01T00:${n}:00Z`,
        field_updated_at: { nome: `2026-02-01T00:${n}:00Z` },
      });
    }
    // Reconectou: um único ciclo.
    const res = await cycle(hub, cloud, E1);
    expect(res.ok).toBe(true);
    expect(cloud.store.clientes).toHaveLength(50);
    const nomes = cloud.store.clientes.map((r) => r.nome).sort();
    expect(nomes[0]).toBe('Cliente 00');
    expect(nomes[49]).toBe('Cliente 49');
  });

  it('soft-delete propaga: A marca deleted_at; B vê deletado e não ressuscita num push posterior', async () => {
    const base: Row = {
      id: 'c1',
      empresa_id: E1,
      nome: 'Ana',
      deleted_at: null,
      updated_at: '2026-01-01T00:00:00Z',
      field_updated_at: { nome: '2026-01-01T00:00:00Z', deleted_at: '2026-01-01T00:00:00Z' },
    };
    const cloud = makeCloud({ clientes: [{ ...base }] });
    const hubA = makeHubDb();
    const hubB = makeHubDb();
    hubA.seed('clientes', clone(base));
    hubB.seed('clientes', clone(base));

    // A marca deleted_at.
    const a = hubA.get('clientes', 'c1')!;
    a.deleted_at = '2026-03-01T00:00:00Z';
    a.updated_at = '2026-03-01T00:00:00Z';
    (a.field_updated_at as Record<string, string>).deleted_at = '2026-03-01T00:00:00Z';

    await cycle(hubA, cloud, E1);
    await cycle(hubB, cloud, E1); // B baixa a remoção
    expect(cloud.store.clientes[0].deleted_at).toBe('2026-03-01T00:00:00Z');
    expect(hubB.get('clientes', 'c1')!.deleted_at).toBe('2026-03-01T00:00:00Z');

    // B agora edita OUTRO campo (sem saber que removeu antes? ele já baixou). Mesmo que
    // B reenvie a linha, deleted_at (field_updated_at mais novo) NÃO ressuscita.
    const b = hubB.get('clientes', 'c1')!;
    b.nome = 'Ana-editada-por-B';
    b.updated_at = '2026-04-01T00:00:00Z';
    (b.field_updated_at as Record<string, string>).nome = '2026-04-01T00:00:00Z';
    await cycle(hubB, cloud, E1);
    await cycle(hubA, cloud, E1);

    // deleted_at permanece (a edição de B no nome não toca deleted_at).
    expect(cloud.store.clientes[0].deleted_at).toBe('2026-03-01T00:00:00Z');
    expect(cloud.store.clientes[0].nome).toBe('Ana-editada-por-B');
    expect(hubA.get('clientes', 'c1')!.deleted_at).toBe('2026-03-01T00:00:00Z');
  });

  it('agregado atômico: pedido + filhas no MESMO lote chegam juntos no cloud (nunca pai sem filhos)', async () => {
    const cloud = makeCloud();
    const hub = makeHubDb();
    const ts = '2026-02-01T00:00:00Z';
    hub.seed('pedidos', {
      id: 'p1',
      empresa_id: E1,
      observacao: 'pedido novo',
      updated_at: ts,
      field_updated_at: { observacao: ts },
    });
    hub.seed('pedido_pontos_retirada', {
      id: 'pp1',
      pedido_id: 'p1',
      tipo: 'loja',
      updated_at: ts,
      field_updated_at: { tipo: ts },
    });
    hub.seed('pedido_itens', {
      id: 'pi1',
      ponto_retirada_id: 'pp1',
      descricao: 'item',
      quantidade: 2,
      updated_at: ts,
      field_updated_at: { descricao: ts, quantidade: ts },
    });

    const res = await cycle(hub, cloud, E1);
    expect(res.ok).toBe(true);
    // Pai e filhas presentes no cloud após o ciclo.
    expect(cloud.store.pedidos?.find((r) => r.id === 'p1')).toBeTruthy();
    expect(cloud.store.pedido_pontos_retirada?.find((r) => r.id === 'pp1')?.pedido_id).toBe('p1');
    expect(cloud.store.pedido_itens?.find((r) => r.id === 'pi1')?.ponto_retirada_id).toBe('pp1');
  });

  it('cross-tenant bloqueado: hub da empresa A tenta push de PK que no cloud é da empresa B → rejeitado, linha da B intacta', async () => {
    const cloud = makeCloud({
      clientes: [
        {
          id: 'c1',
          empresa_id: 'EB', // pertence à empresa B
          nome: 'DA EMPRESA B',
          updated_at: '2026-01-01T00:00:00Z',
          field_updated_at: { nome: '2026-01-01T00:00:00Z' },
        },
      ],
    });
    // Hub da empresa A tem uma linha com a MESMA PK (tentativa de takeover).
    const hubA = makeHubDb();
    hubA.seed('clientes', {
      id: 'c1',
      empresa_id: 'EA',
      nome: 'SEQUESTRO',
      updated_at: '2026-09-01T00:00:00Z',
      field_updated_at: { nome: '2026-09-01T00:00:00Z' },
    });

    // O 403 preserva o dado da outra empresa e não avança o cursor, mas o ciclo
    // precisa sinalizar falha: a linha continua pendente e exige diagnóstico.
    const res = await cycle(hubA, cloud, 'EA');
    expect(res.ok).toBe(false);

    // A linha da empresa B continua intacta no cloud.
    expect(cloud.store.clientes).toHaveLength(1);
    expect(cloud.store.clientes[0].empresa_id).toBe('EB');
    expect(cloud.store.clientes[0].nome).toBe('DA EMPRESA B');

    // O cursor de push de clientes do hub A NÃO avançou (linha pendente, não confirmada).
    expect((await hubA.getCursor('clientes')).push_at).toBe(EPOCH);
  });
});
