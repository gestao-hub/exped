import { describe, it, expect } from 'vitest';
import { runPull, runPush, PushError, EPOCH, type SyncDb, type Row } from '../engine';
import type { SyncTable } from '../tables';

/**
 * Fake in-memory de SyncDb. Guarda linhas por tabela e registra o estado do trigger
 * (set session_replication_role). Escopo por empresa simulado via campo empresa_id
 * direto ou via mapa de pais.
 */
function makeDb(seed: Record<string, Row[]> = {}) {
  const store: Record<string, Row[]> = {};
  for (const [k, v] of Object.entries(seed)) store[k] = v.map((r) => ({ ...r }));
  // empresa_id de cada id de pai (pra validar filhas)
  const parentEmpresa: Record<string, Record<string, string>> = {
    pedidos: {},
    pedido_pontos_retirada: {},
    ordens_servico: {},
  };
  // popula parentEmpresa a partir do seed
  for (const r of store.pedidos ?? []) parentEmpresa.pedidos[String(r.id)] = String(r.empresa_id);
  for (const r of store.ordens_servico ?? []) parentEmpresa.ordens_servico[String(r.id)] = String(r.empresa_id);

  const replicaCalls: boolean[] = [];

  const db: SyncDb = {
    async selectChanges(table, empresaId, cursor, limit) {
      const rows = (store[table] ?? []).filter((r) => {
        const inScope = r.empresa_id === undefined ? true : r.empresa_id === empresaId;
        return inScope && String(r.updated_at ?? '') > cursor;
      });
      rows.sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)));
      return rows.slice(0, limit).map((r) => ({ ...r }));
    },
    async findCanonical(table: SyncTable, empresaId, pk) {
      const found = (store[table.name] ?? []).find((r) => r[table.pk] === pk);
      if (!found) return null;
      if (found.empresa_id !== undefined && found.empresa_id !== empresaId) return null;
      // Filha: confere o ancestral (espelha a impl supabase).
      if (found.empresa_id === undefined && table.parent) {
        const parentEmp = parentEmpresa[table.parent.table]?.[String(found[table.parent.fk])];
        if (parentEmp !== empresaId) return null;
      }
      return { ...found };
    },
    async findCanonicalGlobal(table: SyncTable, pk) {
      // Existência GLOBAL por PK, SEM filtro de empresa.
      const found = (store[table.name] ?? []).find((r) => r[table.pk] === pk);
      return found ? { ...found } : null;
    },
    async parentBelongsToEmpresa(parentTable, parentId, empresaId) {
      return parentEmpresa[parentTable]?.[String(parentId)] === empresaId;
    },
    async upsertRaw(table, row) {
      store[table] = store[table] ?? [];
      const idx = store[table].findIndex((r) => r.id === row.id);
      if (idx >= 0) {
        // Espelha a guarda `where empresa_id` do RPC: se a linha EXISTENTE for de
        // outra empresa, o UPDATE afeta 0 linhas → RETURNING vazio (null).
        const existing = store[table][idx];
        if (
          existing.empresa_id !== undefined &&
          row.empresa_id !== undefined &&
          existing.empresa_id !== row.empresa_id
        ) {
          return null;
        }
        store[table][idx] = { ...row };
      } else {
        store[table].push({ ...row });
      }
      return { ...row };
    },
    async setSyncReplica(on) {
      replicaCalls.push(on);
    },
  };
  return { db, store, replicaCalls };
}

describe('runPull', () => {
  it('devolve linhas > cursor por tabela, incl. deleted_at, e calcula nextCursor', async () => {
    const { db } = makeDb({
      clientes: [
        { id: 'c1', empresa_id: 'E1', nome: 'A', updated_at: '2026-01-02T00:00:00Z', deleted_at: null },
        { id: 'c2', empresa_id: 'E1', nome: 'B', updated_at: '2026-01-05T00:00:00Z', deleted_at: '2026-01-05T00:00:00Z' },
        { id: 'c3', empresa_id: 'E2', nome: 'outra empresa', updated_at: '2026-01-09T00:00:00Z' },
      ],
    });
    const res = await runPull(db, 'E1', { clientes: '2026-01-01T00:00:00Z' });
    const ids = res.tables.clientes.map((r) => r.id);
    expect(ids).toEqual(['c1', 'c2']); // c3 é de outra empresa
    // deleted_at incluída (c2)
    expect(res.tables.clientes.find((r) => r.id === 'c2')?.deleted_at).toBe('2026-01-05T00:00:00Z');
    expect(res.nextCursors.clientes).toBe('2026-01-05T00:00:00Z');
  });

  it('cursor default epoch quando não informado', async () => {
    const { db } = makeDb({
      clientes: [{ id: 'c1', empresa_id: 'E1', updated_at: '2020-01-01T00:00:00Z' }],
    });
    const res = await runPull(db, 'E1', {});
    expect(res.tables.clientes.map((r) => r.id)).toEqual(['c1']);
    expect(res.nextCursors.clientes).toBe('2020-01-01T00:00:00Z');
  });
});

describe('runPush', () => {
  it('recusa tabela down com 403', async () => {
    const { db } = makeDb();
    await expect(runPush(db, 'E1', { empresas: [{ id: 'x', nome: 'X' }] })).rejects.toMatchObject({
      status: 403,
    });
  });

  it('linha nova → INSERT com empresa_id forçado ao escopo', async () => {
    const { db, store } = makeDb();
    const res = await runPush(db, 'E1', {
      clientes: [
        {
          id: 'c1',
          empresa_id: 'HACK', // tentativa de escrever em outra empresa → deve ser ignorada
          nome: 'Novo',
          field_updated_at: { nome: '2026-03-01T00:00:00Z' },
        },
      ],
    });
    expect(store.clientes).toHaveLength(1);
    expect(store.clientes[0].empresa_id).toBe('E1'); // forçado
    expect(store.clientes[0].nome).toBe('Novo');
    expect(store.clientes[0].updated_at).toBe('2026-03-01T00:00:00Z');
    expect(res.tables.clientes[0].id).toBe('c1');
  });

  it('linha existente: merge aplica a coluna com field_updated_at mais novo', async () => {
    const { db, store } = makeDb({
      clientes: [
        {
          id: 'c1',
          empresa_id: 'E1',
          endereco: 'CANONICO',
          telefone: 'T-CANON',
          updated_at: '2026-01-01T00:00:00Z',
          field_updated_at: { endereco: '2026-01-01T00:00:00Z', telefone: '2026-01-10T00:00:00Z' },
        },
      ],
    });
    await runPush(db, 'E1', {
      clientes: [
        {
          id: 'c1',
          empresa_id: 'E1',
          endereco: 'NOVO',
          telefone: 'T-VELHO',
          field_updated_at: { endereco: '2026-02-01T00:00:00Z', telefone: '2026-01-05T00:00:00Z' },
        },
      ],
    });
    const saved = store.clientes[0];
    expect(saved.endereco).toBe('NOVO'); // incoming mais novo nessa coluna
    expect(saved.telefone).toBe('T-CANON'); // canonico mais novo nessa coluna
    expect(saved.updated_at).toBe('2026-02-01T00:00:00Z'); // máximo do field_updated_at
  });

  it('idempotente por PK: reenviar o mesmo lote não duplica', async () => {
    const { db, store } = makeDb();
    const lote = {
      clientes: [{ id: 'c1', empresa_id: 'E1', nome: 'X', field_updated_at: { nome: '2026-03-01T00:00:00Z' } }],
    };
    await runPush(db, 'E1', lote);
    await runPush(db, 'E1', lote);
    expect(store.clientes).toHaveLength(1);
  });

  it('filha: valida que o pai pertence à empresa (403 se fora do escopo)', async () => {
    const { db } = makeDb({
      pedidos: [{ id: 'p1', empresa_id: 'E2', updated_at: '2026-01-01T00:00:00Z' }],
    });
    await expect(
      runPush(db, 'E1', {
        pedido_pontos_retirada: [
          { id: 'pp1', pedido_id: 'p1', field_updated_at: { tipo: '2026-03-01T00:00:00Z' } },
        ],
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('filha: aceita quando o pai pertence à empresa', async () => {
    const { db, store } = makeDb({
      pedidos: [{ id: 'p1', empresa_id: 'E1', updated_at: '2026-01-01T00:00:00Z' }],
    });
    await runPush(db, 'E1', {
      pedido_pontos_retirada: [
        { id: 'pp1', pedido_id: 'p1', tipo: 'loja', field_updated_at: { tipo: '2026-03-01T00:00:00Z' } },
      ],
    });
    expect(store.pedido_pontos_retirada).toHaveLength(1);
    expect(store.pedido_pontos_retirada[0].pedido_id).toBe('p1');
  });

  it('liga e desliga o trigger (session_replication_role) em volta da gravação', async () => {
    const { db, replicaCalls } = makeDb();
    await runPush(db, 'E1', { clientes: [{ id: 'c1', empresa_id: 'E1', field_updated_at: {} }] });
    expect(replicaCalls).toEqual([true, false]);
  });

  it('reabilita o trigger mesmo em erro', async () => {
    const { db, replicaCalls } = makeDb();
    // pedido_pontos_retirada com pai inexistente → erro no meio
    await expect(
      runPush(db, 'E1', {
        pedido_pontos_retirada: [{ id: 'pp1', pedido_id: 'inexistente', field_updated_at: {} }],
      }),
    ).rejects.toBeInstanceOf(PushError);
    expect(replicaCalls[replicaCalls.length - 1]).toBe(false);
  });

  it('SEGURANÇA: PK existente em OUTRA empresa → 403 (não INSERT, não sobrescreve)', async () => {
    const { db, store } = makeDb({
      clientes: [
        {
          id: 'c1',
          empresa_id: 'E2', // pertence à empresa B
          nome: 'DA EMPRESA B',
          updated_at: '2026-01-01T00:00:00Z',
          field_updated_at: { nome: '2026-01-01T00:00:00Z' },
        },
      ],
    });
    // Dispositivo da empresa E1 tenta mandar uma linha com a PK da E2.
    await expect(
      runPush(db, 'E1', {
        clientes: [{ id: 'c1', nome: 'SEQUESTRO', field_updated_at: { nome: '2026-09-01T00:00:00Z' } }],
      }),
    ).rejects.toMatchObject({ status: 403 });
    // A linha da empresa B continua intacta.
    expect(store.clientes).toHaveLength(1);
    expect(store.clientes[0].empresa_id).toBe('E2');
    expect(store.clientes[0].nome).toBe('DA EMPRESA B');
  });

  it('SEGURANÇA filha: PK existente cujo pai é de OUTRA empresa → 403', async () => {
    const { db, store } = makeDb({
      pedidos: [
        { id: 'p2', empresa_id: 'E2', updated_at: '2026-01-01T00:00:00Z' },
        { id: 'p1', empresa_id: 'E1', updated_at: '2026-01-01T00:00:00Z' },
      ],
      pedido_pontos_retirada: [
        { id: 'pp1', pedido_id: 'p2', tipo: 'B', updated_at: '2026-01-01T00:00:00Z', field_updated_at: { tipo: '2026-01-01T00:00:00Z' } },
      ],
    });
    // E1 tenta reescrever pp1 (cujo pai p2 é da E2), inclusive trocando o pai pra um seu.
    await expect(
      runPush(db, 'E1', {
        pedido_pontos_retirada: [
          { id: 'pp1', pedido_id: 'p1', tipo: 'SEQUESTRO', field_updated_at: { tipo: '2026-09-01T00:00:00Z' } },
        ],
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(store.pedido_pontos_retirada[0].pedido_id).toBe('p2'); // intacto
    expect(store.pedido_pontos_retirada[0].tipo).toBe('B');
  });

  it('SEGURANÇA: PK inexistente em lugar nenhum → INSERT normal', async () => {
    const { db, store } = makeDb({
      clientes: [{ id: 'cX', empresa_id: 'E2', nome: 'outra', updated_at: '2026-01-01T00:00:00Z' }],
    });
    await runPush(db, 'E1', {
      clientes: [{ id: 'c1', nome: 'Novo', field_updated_at: { nome: '2026-03-01T00:00:00Z' } }],
    });
    expect(store.clientes.find((r) => r.id === 'c1')?.empresa_id).toBe('E1');
    expect(store.clientes.find((r) => r.id === 'c1')?.nome).toBe('Novo');
  });

  it('allowlist: chave estranha no payload não quebra o push (filtrada no RPC por information_schema)', async () => {
    // O descarte real de colunas inexistentes acontece no RPC sync_push_upsert
    // (allowlist via information_schema) — validado contra o Postgres. No engine,
    // a chave estranha apenas trafega sem causar erro.
    const { db, store } = makeDb();
    await runPush(db, 'E1', {
      clientes: [
        {
          id: 'c1',
          nome: 'Novo',
          coluna_inexistente_maliciosa: 'DROP',
          field_updated_at: { nome: '2026-03-01T00:00:00Z' },
        },
      ],
    });
    expect(store.clientes).toHaveLength(1);
    expect(store.clientes[0].nome).toBe('Novo');
  });

  it('rejeita lote acima do limite', async () => {
    const { db } = makeDb();
    const rows = Array.from({ length: 501 }, (_, i) => ({ id: `c${i}`, field_updated_at: {} }));
    await expect(runPush(db, 'E1', { clientes: rows })).rejects.toMatchObject({ status: 413 });
  });
});

describe('constants', () => {
  it('EPOCH é o início do tempo', () => {
    expect(EPOCH).toBe('1970-01-01T00:00:00Z');
  });
});
