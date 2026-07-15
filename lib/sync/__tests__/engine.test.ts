import { describe, it, expect } from 'vitest';
import {
  runPull,
  runPush,
  PushError,
  SyncSchemaUnavailableError,
  EPOCH,
  PUSH_CONCURRENCY,
  type SyncDb,
  type Row,
} from '../engine';
import { mergeRow } from '../merge';
import { SYNC_TABLES, getSyncTable, type TwoWaySyncTable } from '../tables';

const pullPkCursorKey = (table: string) => `${table}.__pk`;

function pullPk(table: string, row: Row): string {
  const pk = getSyncTable(table)?.pk ?? 'id';
  const column = Array.isArray(pk) ? pk[pk.length - 1] : pk;
  return String(row[column] ?? '');
}

function comparePullPk(table: string, left: Row, right: Row): number {
  if (table === 'hiper_vendedor_map') {
    return Number(left.hiper_usuario_id) - Number(right.hiper_usuario_id);
  }
  return pullPk(table, left).localeCompare(pullPk(table, right));
}

function pullPkIsAfter(table: string, row: Row, cursorPk: string): boolean {
  if (cursorPk === '') return true;
  if (table === 'hiper_vendedor_map') {
    return Number(row.hiper_usuario_id) > Number(cursorPk);
  }
  return pullPk(table, row) > cursorPk;
}

function maxFieldTimestamp(row: Row): string {
  return Object.values((row.field_updated_at ?? {}) as Record<string, string>)
    .filter((value): value is string => typeof value === 'string')
    .sort()
    .at(-1) ?? EPOCH;
}

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
    async selectChanges(table, empresaId, cursor, limit, cursorPk?: string) {
      const rows = (store[table] ?? []).filter((r) => {
        const inScope = r.empresa_id === undefined ? true : r.empresa_id === empresaId;
        const updatedAt = String(r.updated_at ?? '');
        return inScope && (
          updatedAt > cursor ||
          (cursorPk !== undefined && updatedAt === cursor && pullPkIsAfter(table, r, cursorPk))
        );
      });
      rows.sort((a, b) => (
        String(a.updated_at).localeCompare(String(b.updated_at)) ||
        comparePullPk(table, a, b)
      ));
      return rows.slice(0, limit).map((r) => ({ ...r }));
    },
    async findCanonical(table: TwoWaySyncTable, empresaId, pk) {
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
    async findCanonicalGlobal(table: TwoWaySyncTable, pk) {
      // Existência GLOBAL por PK, SEM filtro de empresa.
      const found = (store[table.name] ?? []).find((r) => r[table.pk] === pk);
      return found ? { ...found } : null;
    },
    async parentBelongsToEmpresa(parentTable, parentId, empresaId) {
      return parentEmpresa[parentTable]?.[String(parentId)] === empresaId;
    },
    async findCanonicalMany(table: TwoWaySyncTable, empresaId, pks) {
      const map = new Map<string, Row>();
      for (const pk of pks) {
        const found = await this.findCanonical(table, empresaId, pk);
        if (found) map.set(String(pk), found);
      }
      return map;
    },
    async parentsInEmpresa(parentTable, parentIds, empresaId) {
      const set = new Set<string>();
      for (const id of parentIds) {
        if (parentEmpresa[parentTable]?.[String(id)] === empresaId) set.add(String(id));
      }
      return set;
    },
    async mergeAndUpsert(table, empresaId, row) {
      store[table.name] = store[table.name] ?? [];
      const idx = store[table.name].findIndex((candidate) => candidate[table.pk] === row[table.pk]);
      const existing = idx >= 0 ? store[table.name][idx] : null;

      if (existing?.empresa_id !== undefined && existing.empresa_id !== empresaId) return null;
      if (existing?.empresa_id === undefined && existing && table.parent) {
        const existingParentEmpresa = parentEmpresa[table.parent.table]?.[
          String(existing[table.parent.fk])
        ];
        if (existingParentEmpresa !== empresaId) return null;
      }
      if (table.parent) {
        const incomingParentEmpresa = parentEmpresa[table.parent.table]?.[
          String(row[table.parent.fk])
        ];
        if (incomingParentEmpresa !== empresaId) return null;
      }

      const saved = existing ? mergeRow(row, existing) as Row : { ...row };
      if (saved.empresa_id !== undefined) saved.empresa_id = empresaId;
      saved.updated_at = maxFieldTimestamp(saved);
      if (idx >= 0) store[table.name][idx] = saved;
      else store[table.name].push(saved);

      if (table.name === 'pedidos' || table.name === 'ordens_servico') {
        parentEmpresa[table.name][String(saved.id)] = empresaId;
      } else if (table.name === 'pedido_pontos_retirada') {
        parentEmpresa.pedido_pontos_retirada[String(saved.id)] = empresaId;
      }
      return { ...saved };
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
    async selectAuthUsers(empresaId, cursor, limit, cursorPk?: string) {
      // profiles da empresa → ids; depois filtra auth.users por esses ids.
      const profIds = new Set(
        (store.profiles ?? []).filter((p) => p.empresa_id === empresaId).map((p) => String(p.id)),
      );
      const rows = (store['auth.users'] ?? []).filter(
        (u) => {
          const updatedAt = String(u.updated_at ?? '');
          return profIds.has(String(u.id)) && (
            updatedAt > cursor ||
            (cursorPk !== undefined && updatedAt === cursor && String(u.id) > cursorPk)
          );
        },
      );
      rows.sort((a, b) => (
        String(a.updated_at).localeCompare(String(b.updated_at)) ||
        String(a.id).localeCompare(String(b.id))
      ));
      return rows.slice(0, limit).map((r) => ({ ...r }));
    },
  };
  return { db, store, replicaCalls };
}

describe('runPull', () => {
  it('identityOnly consulta somente profiles e auth.users e sinaliza o contrato aditivo', async () => {
    const { db } = makeDb({
      clientes: [
        { id: 'c1', empresa_id: 'E1', updated_at: '2026-07-14T10:00:00Z' },
      ],
      profiles: [
        { id: 'u1', empresa_id: 'E1', updated_at: '2026-07-14T11:00:00Z' },
      ],
      'auth.users': [
        { id: 'u1', email: 'u1@example.test', updated_at: '2026-07-14T12:00:00Z' },
      ],
    });
    const selectedTables: string[] = [];
    const selectChanges = db.selectChanges.bind(db);
    db.selectChanges = async (...args) => {
      selectedTables.push(args[0]);
      return selectChanges(...args);
    };

    const result = await runPull(db, 'E1', {}, { identityOnly: true });

    expect(selectedTables).toEqual(['profiles']);
    expect(Object.keys(result.tables)).toEqual(['profiles']);
    expect(result.tables.profiles.map((row) => row.id)).toEqual(['u1']);
    expect(result.auth_users.map((row) => row.id)).toEqual(['u1']);
    expect(result.identityOnly).toBe(true);
    expect(result.nextCursors.clientes).toBeUndefined();
  });

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

  it('auth_users: só usuários cujo profile é da empresa, com cursor próprio', async () => {
    const { db } = makeDb({
      profiles: [
        { id: 'u1', empresa_id: 'E1' },
        { id: 'u2', empresa_id: 'E2' }, // outra empresa
      ],
      'auth.users': [
        { id: 'u1', email: 'a@e1', encrypted_password: 'h1', updated_at: '2026-01-03T00:00:00Z' },
        { id: 'u2', email: 'b@e2', encrypted_password: 'h2', updated_at: '2026-01-04T00:00:00Z' },
      ],
    });
    const res = await runPull(db, 'E1', {});
    expect(res.auth_users.map((u) => u.id)).toEqual(['u1']); // u2 é de E2, nunca vem
    expect(res.auth_users[0].encrypted_password).toBe('h1');
    expect(res.nextCursors['auth.users']).toBe('2026-01-03T00:00:00Z');
  });

  it('auth_users: respeita o cursor (só > cursor)', async () => {
    const { db } = makeDb({
      profiles: [{ id: 'u1', empresa_id: 'E1' }],
      'auth.users': [{ id: 'u1', email: 'a@e1', updated_at: '2026-01-01T00:00:00Z' }],
    });
    const res = await runPull(db, 'E1', { 'auth.users': '2026-06-01T00:00:00Z' });
    expect(res.auth_users).toEqual([]);
    expect(res.nextCursors['auth.users']).toBe('2026-06-01T00:00:00Z');
  });

  it('pagina 530 empates por PK em todas as tabelas, filhas e auth.users', async () => {
    const timestamp = '2026-07-14T12:00:00.123456Z';
    const seed: Record<string, Row[]> = {};

    for (const table of SYNC_TABLES) {
      seed[table.name] = Array.from({ length: 530 }, (_, index) => {
        const suffix = String(index).padStart(4, '0');
        if (typeof table.pk !== 'string') {
          return {
            empresa_id: 'E1',
            hiper_usuario_id: index,
            updated_at: timestamp,
          };
        }
        return {
          [table.pk]: `${table.name}-${suffix}`,
          ...(table.name === 'profiles' ? { empresa_id: 'E1' } : {}),
          updated_at: timestamp,
        };
      });
    }
    seed['auth.users'] = seed.profiles.map((profile) => ({
      id: profile.id,
      email: `${profile.id}@example.test`,
      updated_at: timestamp,
    }));

    const { db } = makeDb(seed);
    const cursors: Record<string, string> = {};
    for (const table of SYNC_TABLES) {
      cursors[table.name] = EPOCH;
      cursors[pullPkCursorKey(table.name)] = '';
    }
    cursors['auth.users'] = EPOCH;
    cursors[pullPkCursorKey('auth.users')] = '';

    const first = await runPull(db, 'E1', cursors);
    const second = await runPull(db, 'E1', first.nextCursors);

    for (const table of SYNC_TABLES) {
      expect(first.tables[table.name], `${table.name} pagina 1`).toHaveLength(500);
      expect(second.tables[table.name], `${table.name} pagina 2`).toHaveLength(30);
      expect(new Set(
        [...first.tables[table.name], ...second.tables[table.name]]
          .map((row) => pullPk(table.name, row)),
      ).size, `${table.name} sem perdas`).toBe(530);
    }
    expect(first.auth_users).toHaveLength(500);
    expect(second.auth_users).toHaveLength(30);
    expect(new Set([...first.auth_users, ...second.auth_users].map((row) => row.id)).size).toBe(530);
  });
});

describe('runPush', () => {
  it('preserva campos de dois pushes concorrentes delegando o merge ao banco atomico', async () => {
    const initial: Row = {
      id: 'c1',
      empresa_id: 'E1',
      endereco_padrao: 'Rua antiga',
      telefone_padrao: '1111',
      updated_at: '2026-07-14T10:00:00Z',
      field_updated_at: {
        endereco_padrao: '2026-07-14T10:00:00Z',
        telefone_padrao: '2026-07-14T10:00:00Z',
      },
    };
    const { db, store } = makeDb({ clientes: [initial] });

    // Reproduz a corrida antiga: os dois requests leem o mesmo snapshot antes
    // de qualquer escrita. Um read/merge/write fora da transacao perde um campo.
    let snapshotReads = 0;
    let releaseSnapshots!: () => void;
    const bothSnapshotsStarted = new Promise<void>((resolve) => {
      releaseSnapshots = resolve;
    });
    db.findCanonicalMany = async () => {
      snapshotReads += 1;
      if (snapshotReads === 2) releaseSnapshots();
      await bothSnapshotsStarted;
      return new Map([['c1', { ...initial }]]);
    };

    // Contrato novo: cada chamada le, mescla e grava a canônica corrente como
    // uma unica operacao. O fake e sincrono; a implementacao real e uma RPC SQL.
    const atomicDb = db as SyncDb & {
      mergeAndUpsert: (
        table: TwoWaySyncTable,
        empresaId: string,
        row: Row,
      ) => Promise<Row | null>;
    };
    atomicDb.mergeAndUpsert = async (table, empresaId, row) => {
      const current = store[table.name].find((candidate) => candidate.id === row.id);
      if (!current || current.empresa_id !== empresaId) return null;
      const merged = mergeRow(row, current) as Row;
      merged.empresa_id = empresaId;
      merged.updated_at = Object.values(
        (merged.field_updated_at ?? {}) as Record<string, string>,
      ).sort().at(-1) ?? EPOCH;
      store[table.name][0] = merged;
      return { ...merged };
    };

    await Promise.all([
      runPush(db, 'E1', {
        clientes: [{
          id: 'c1',
          endereco_padrao: 'Rua nova',
          field_updated_at: { endereco_padrao: '2026-07-14T11:00:00Z' },
        }],
      }),
      runPush(db, 'E1', {
        clientes: [{
          id: 'c1',
          telefone_padrao: '2222',
          field_updated_at: { telefone_padrao: '2026-07-14T12:00:00Z' },
        }],
      }),
    ]);

    expect(store.clientes[0].endereco_padrao).toBe('Rua nova');
    expect(store.clientes[0].telefone_padrao).toBe('2222');
  });

  it('envolve falha de escrita com tabela/PK e sem mensagem interna', async () => {
    const { db } = makeDb();
    db.mergeAndUpsert = async () => {
      throw new Error('duplicate key value violates secret_constraint');
    };

    await expect(
      runPush(db, 'E1', {
        pedidos: [{ id: 'p-4079', field_updated_at: {} }],
      }),
    ).rejects.toMatchObject({
      status: 500,
      message: 'Falha ao gravar linha de sync',
      blockedRow: { table: 'pedidos', pk: 'p-4079' },
    });
  });

  it('falha fechada com 503 quando a migration atomica ainda nao foi aplicada', async () => {
    const { db } = makeDb();
    db.mergeAndUpsert = async () => {
      throw new SyncSchemaUnavailableError('sync_merge_upsert indisponivel');
    };

    await expect(
      runPush(db, 'E1', {
        pedidos: [{ id: 'p-4079', field_updated_at: {} }],
      }),
    ).rejects.toMatchObject({
      status: 503,
      message: 'Sincronizacao aguardando atualizacao do banco',
      blockedRow: { table: 'pedidos', pk: 'p-4079' },
    });
  });

  it('grava uma pagina com concorrencia limitada e preserva a ordem canonica', async () => {
    const { db } = makeDb();
    let active = 0;
    let maxActive = 0;
    db.mergeAndUpsert = async (_table, empresaId, row) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { ...row, empresa_id: empresaId };
    };
    const rows = Array.from({ length: 24 }, (_, index) => ({
      id: `c-${String(index).padStart(2, '0')}`,
      field_updated_at: {},
    }));

    const result = await runPush(db, 'E1', { clientes: rows });

    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(PUSH_CONCURRENCY);
    expect(result.tables.clientes.map((row) => row.id)).toEqual(
      rows.map((row) => row.id),
    );
  });

  it('em erro para de agendar linhas e espera as operacoes iniciadas', async () => {
    const { db } = makeDb();
    const started: string[] = [];
    const finished: string[] = [];
    db.mergeAndUpsert = async (_table, empresaId, row) => {
      const id = String(row.id);
      started.push(id);
      if (id === 'c-02') {
        await new Promise((resolve) => setTimeout(resolve, 30));
        throw new Error('falha controlada');
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      finished.push(id);
      return { ...row, empresa_id: empresaId };
    };
    const rows = Array.from({ length: PUSH_CONCURRENCY * 2 }, (_, index) => ({
      id: `c-${String(index).padStart(2, '0')}`,
      field_updated_at: {},
    }));

    await expect(runPush(db, 'E1', { clientes: rows })).rejects.toMatchObject({
      status: 500,
      blockedRow: { table: 'clientes', pk: 'c-02' },
    });

    expect(started).toHaveLength(PUSH_CONCURRENCY);
    expect(finished).toHaveLength(PUSH_CONCURRENCY - 1);
    expect(started).not.toContain('c-08');
  });

  it('sanitiza e limita a PK antes de expor o diagnóstico', async () => {
    const { db } = makeDb();
    db.mergeAndUpsert = async () => {
      throw new Error('detalhe interno que não pode sair');
    };
    const hostilePk = `pedido\n<4079>${'x'.repeat(180)}`;

    await expect(
      runPush(db, 'E1', {
        pedidos: [{ id: hostilePk, field_updated_at: {} }],
      }),
    ).rejects.toMatchObject({
      status: 500,
      message: 'Falha ao gravar linha de sync',
      blockedRow: {
        table: 'pedidos',
        pk: `pedido4079${'x'.repeat(118)}`,
      },
    });
  });

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
    // O descarte real de colunas inexistentes acontece no RPC sync_merge_upsert
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

  it('rejeita lote com PK duplicada', async () => {
    const { db } = makeDb();
    const rows = [
      { id: 'dup', empresa_id: 'E1', field_updated_at: {} },
      { id: 'dup', empresa_id: 'E1', field_updated_at: {} },
    ];
    await expect(runPush(db, 'E1', { pedidos: rows })).rejects.toMatchObject({ status: 422 });
  });

  it('push atomico: merge da canônica existente + insert da nova (mesmas linhas)', async () => {
    const empresa = 'E1';
    const { db } = makeDb({
      pedidos: [
        { id: 'p1', empresa_id: empresa, cliente_nome: 'Antigo', updated_at: '2026-01-01T00:00:00Z', field_updated_at: {} },
      ],
    });
    const incoming = {
      pedidos: [
        {
          id: 'p1', empresa_id: empresa, cliente_nome: 'Novo', updated_at: '2026-02-01T00:00:00Z',
          field_updated_at: { cliente_nome: '2026-02-01T00:00:00Z' },
        },
        {
          id: 'p2', empresa_id: empresa, cliente_nome: 'Outro', updated_at: '2026-02-01T00:00:00Z',
          field_updated_at: { cliente_nome: '2026-02-01T00:00:00Z' },
        },
      ],
    };
    const r = await runPush(db, empresa, incoming);
    expect(r.tables.pedidos.map((x) => x.id).sort()).toEqual(['p1', 'p2']);
    expect(r.tables.pedidos.find((x) => x.id === 'p1')!.cliente_nome).toBe('Novo');
  });
});

describe('constants', () => {
  it('EPOCH é o início do tempo', () => {
    expect(EPOCH).toBe('1970-01-01T00:00:00Z');
  });
});
