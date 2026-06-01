import { describe, it, expect, beforeEach } from 'vitest';

import { syncOnce, getState, SYNC_TABLES } from '../sync.mjs';
import { TWO_WAY_TABLES } from '../sync-tables.mjs';

// ---------------------------------------------------------------------------
// "db" local in-memory implementando a interface mínima esperada por sync.mjs:
//   selectChanged(table, cursor, limit) -> rows (updated_at > cursor, asc)
//   upsert(table, pk, row)              -> grava por PK (idempotente)
//   getCursor(table)                    -> { pull_at, push_at }
//   setCursor(table, { pull_at?, push_at? })
//   ensureCursorTable()                 -> idempotente
// Soft-delete é apenas um upsert de uma linha com deleted_at preenchido.
// ---------------------------------------------------------------------------
function makeMemDb() {
  const tables = new Map(); // table -> Map(pk -> row)
  const cursors = new Map(); // table -> { pull_at, push_at }
  let cursorTableEnsured = false;

  const tbl = (name) => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name);
  };

  return {
    _raw: tables,
    async ensureCursorTable() {
      cursorTableEnsured = true;
    },
    isCursorTableEnsured: () => cursorTableEnsured,
    async getCursor(table) {
      return cursors.get(table) || { pull_at: '1970-01-01T00:00:00Z', push_at: '1970-01-01T00:00:00Z' };
    },
    async setCursor(table, patch) {
      const cur = cursors.get(table) || { pull_at: '1970-01-01T00:00:00Z', push_at: '1970-01-01T00:00:00Z' };
      cursors.set(table, { ...cur, ...patch });
    },
    async selectChanged(table, cursor, limit) {
      const rows = [...tbl(table).values()]
        .filter((r) => String(r.updated_at ?? '') > String(cursor ?? ''))
        .sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)));
      return rows.slice(0, limit);
    },
    async upsert(table, pk, row) {
      tbl(table).set(row[pk], { ...row });
    },
    async upsertAuthUser(row) {
      tbl('auth.users').set(row.id, { ...row });
    },
    // helpers de teste
    get(table, id) {
      return tbl(table).get(id);
    },
    count(table) {
      return tbl(table).size;
    },
    seed(table, row) {
      tbl(table).set(row.id, { ...row });
    },
  };
}

const apiBase = 'http://cloud.example';
const deviceToken = 'dev-token-xyz';

describe('syncOnce — pull', () => {
  let db;
  beforeEach(() => {
    db = makeMemDb();
  });

  it('faz upsert das linhas recebidas e avança pull_at pro maior updated_at', async () => {
    const pullFn = async () => ({
      tables: {
        clientes: [
          { id: 'c1', nome: 'Ana', updated_at: '2026-01-01T10:00:00Z' },
          { id: 'c2', nome: 'Bia', updated_at: '2026-01-02T10:00:00Z' },
        ],
      },
      nextCursors: { clientes: '2026-01-02T10:00:00Z' },
    });
    const pushFn = async () => ({ tables: {} });

    const res = await syncOnce({ db, apiBase, deviceToken, pullFn, pushFn });

    expect(res.ok).toBe(true);
    expect(db.get('clientes', 'c1').nome).toBe('Ana');
    expect(db.get('clientes', 'c2').nome).toBe('Bia');
    expect((await db.getCursor('clientes')).pull_at).toBe('2026-01-02T10:00:00Z');
  });

  it('aplica soft-delete local quando a linha vem com deleted_at', async () => {
    db.seed('clientes', { id: 'c1', nome: 'Ana', updated_at: '2026-01-01T10:00:00Z', deleted_at: null });
    const pullFn = async () => ({
      tables: {
        clientes: [{ id: 'c1', nome: 'Ana', updated_at: '2026-01-03T10:00:00Z', deleted_at: '2026-01-03T10:00:00Z' }],
      },
      nextCursors: { clientes: '2026-01-03T10:00:00Z' },
    });
    const pushFn = async () => ({ tables: {} });

    await syncOnce({ db, apiBase, deviceToken, pullFn, pushFn });

    expect(db.get('clientes', 'c1').deleted_at).toBe('2026-01-03T10:00:00Z');
  });

  it('envia os cursores pull_at atuais no request', async () => {
    await db.setCursor('clientes', { pull_at: '2026-05-01T00:00:00Z' });
    let received = null;
    const pullFn = async ({ cursors }) => {
      received = cursors;
      return { tables: {}, nextCursors: {} };
    };
    const pushFn = async () => ({ tables: {} });

    await syncOnce({ db, apiBase, deviceToken, pullFn, pushFn });

    expect(received.clientes).toBe('2026-05-01T00:00:00Z');
  });
});

describe('syncOnce — push', () => {
  let db;
  beforeEach(() => {
    db = makeMemDb();
  });

  it('seleciona linhas two-way com updated_at > push_at, envia e avança push_at', async () => {
    db.seed('clientes', { id: 'c1', nome: 'Ana', updated_at: '2026-02-01T10:00:00Z' });
    let pushed = null;
    const pushFn = async ({ rows }) => {
      pushed = rows;
      // nuvem devolve a canônica (eco simples)
      return { tables: rows };
    };
    const pullFn = async () => ({ tables: {}, nextCursors: {} });

    const res = await syncOnce({ db, apiBase, deviceToken, pullFn, pushFn });

    expect(pushed.clientes).toHaveLength(1);
    expect(pushed.clientes[0].id).toBe('c1');
    expect((await db.getCursor('clientes')).push_at).toBe('2026-02-01T10:00:00Z');
    expect(res.ok).toBe(true);
  });

  it('aplica as canônicas retornadas (upsert local)', async () => {
    db.seed('clientes', { id: 'c1', nome: 'Ana', updated_at: '2026-02-01T10:00:00Z' });
    const pushFn = async () => ({
      tables: { clientes: [{ id: 'c1', nome: 'Ana-merged', updated_at: '2026-02-01T10:00:00Z' }] },
    });
    const pullFn = async () => ({ tables: {}, nextCursors: {} });

    await syncOnce({ db, apiBase, deviceToken, pullFn, pushFn });

    expect(db.get('clientes', 'c1').nome).toBe('Ana-merged');
  });

  it('NÃO faz push de tabelas down', async () => {
    db.seed('empresas', { id: 'e1', nome: 'ACME', updated_at: '2026-02-01T10:00:00Z' });
    let pushed = null;
    const pushFn = async ({ rows }) => {
      pushed = rows;
      return { tables: rows };
    };
    const pullFn = async () => ({ tables: {}, nextCursors: {} });

    await syncOnce({ db, apiBase, deviceToken, pullFn, pushFn });

    // empresas é down → não deve aparecer no payload de push
    expect(pushed === null || pushed.empresas === undefined).toBe(true);
  });

  it('reenviar o mesmo lote é idempotente (push_at não regride, sem duplicar)', async () => {
    db.seed('clientes', { id: 'c1', nome: 'Ana', updated_at: '2026-02-01T10:00:00Z' });
    let calls = 0;
    const pushFn = async ({ rows }) => {
      calls += 1;
      return { tables: rows };
    };
    const pullFn = async () => ({ tables: {}, nextCursors: {} });

    await syncOnce({ db, apiBase, deviceToken, pullFn, pushFn });
    const pushAt1 = (await db.getCursor('clientes')).push_at;
    // segundo ciclo: a linha já está abaixo do cursor → nada a enviar
    await syncOnce({ db, apiBase, deviceToken, pullFn, pushFn });
    const pushAt2 = (await db.getCursor('clientes')).push_at;

    expect(calls).toBe(1); // só o primeiro ciclo enviou
    expect(pushAt2).toBe(pushAt1);
    expect(db.count('clientes')).toBe(1); // sem duplicata
  });

  it('403 numa tabela não trava o resto (loga e segue)', async () => {
    db.seed('clientes', { id: 'c1', nome: 'Ana', updated_at: '2026-02-01T10:00:00Z' });
    db.seed('pedidos', { id: 'p1', total: 10, updated_at: '2026-02-01T11:00:00Z' });
    const pushFn = async ({ rows }) => {
      if (rows.clientes) {
        const err = new Error('403');
        err.status = 403;
        throw err;
      }
      return { tables: rows };
    };
    const pullFn = async () => ({ tables: {}, nextCursors: {} });

    const res = await syncOnce({ db, apiBase, deviceToken, pullFn, pushFn });

    // clientes rejeitado → cursor não avança; pedidos passou → avançou
    expect((await db.getCursor('clientes')).push_at).toBe('1970-01-01T00:00:00Z');
    expect((await db.getCursor('pedidos')).push_at).toBe('2026-02-01T11:00:00Z');
    expect(res.ok).toBe(true);
  });
});

describe('syncOnce — offline-safe', () => {
  let db;
  beforeEach(() => {
    db = makeMemDb();
  });

  it('pushFn lança (sem rede) → nada quebra e cursores NÃO avançam', async () => {
    db.seed('clientes', { id: 'c1', nome: 'Ana', updated_at: '2026-02-01T10:00:00Z' });
    const pushFn = async () => {
      throw new Error('ECONNREFUSED');
    };
    const pullFn = async () => ({ tables: {}, nextCursors: {} });

    const res = await syncOnce({ db, apiBase, deviceToken, pullFn, pushFn });

    expect(res.ok).toBe(false);
    expect((await db.getCursor('clientes')).push_at).toBe('1970-01-01T00:00:00Z');
    expect(db.count('clientes')).toBe(1); // intacto
  });

  it('pullFn lança (sem rede) → nada quebra e pull_at NÃO avança', async () => {
    await db.setCursor('clientes', { pull_at: '1970-01-01T00:00:00Z' });
    const pushFn = async () => ({ tables: {} });
    const pullFn = async () => {
      throw new Error('fetch failed');
    };

    const res = await syncOnce({ db, apiBase, deviceToken, pullFn, pushFn });

    expect(res.ok).toBe(false);
    expect((await db.getCursor('clientes')).pull_at).toBe('1970-01-01T00:00:00Z');
  });

  it('estado de erro fica acessível via getState após falha', async () => {
    db.seed('clientes', { id: 'c1', nome: 'Ana', updated_at: '2026-02-01T10:00:00Z' });
    const pushFn = async () => {
      throw new Error('boom-offline');
    };
    const pullFn = async () => ({ tables: {}, nextCursors: {} });

    await syncOnce({ db, apiBase, deviceToken, pullFn, pushFn });
    const st = getState();
    expect(st.lastSyncOk).toBe(false);
    expect(String(st.lastError)).toContain('boom-offline');
  });
});

describe('syncOnce — paginação / cold start', () => {
  let db;
  beforeEach(() => {
    db = makeMemDb();
  });

  it('cold start: 2 páginas (500 + 30) → 2 requests, 530 linhas, cursor = max da última', async () => {
    // Página 1: 500 linhas (lote cheio → "tem mais"); página 2: 30 (< limite → fim).
    const page1 = Array.from({ length: 500 }, (_, i) => {
      const n = String(i + 1).padStart(4, '0');
      return { id: `c${n}`, nome: `N${n}`, updated_at: `2026-01-01T00:00:${(i % 60).toString().padStart(2, '0')}.${n}Z` };
    });
    // garante ordenação crescente determinística por updated_at
    page1.forEach((r, i) => {
      r.updated_at = `2026-01-01T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`;
    });
    const page2 = Array.from({ length: 30 }, (_, i) => {
      const n = String(500 + i + 1).padStart(4, '0');
      return { id: `c${n}`, nome: `N${n}`, updated_at: `2026-01-02T00:${String(i).padStart(2, '0')}:00.000Z` };
    });
    const lastCursor = page2[page2.length - 1].updated_at;

    let calls = 0;
    const pullFn = async ({ cursors }) => {
      calls += 1;
      if (calls === 1) {
        return { tables: { clientes: page1 }, nextCursors: { clientes: page1[499].updated_at } };
      }
      // 2ª chamada: o cliente deve ter avançado o cursor de clientes pro fim da pág1
      expect(cursors.clientes).toBe(page1[499].updated_at);
      return { tables: { clientes: page2 }, nextCursors: { clientes: lastCursor } };
    };
    const pushFn = async () => ({ tables: {} });

    const res = await syncOnce({ db, apiBase, deviceToken, pullFn, pushFn });

    expect(res.ok).toBe(true);
    expect(calls).toBe(2); // exatamente 2 requests (lote cheio → repetiu; 2º < limite → parou)
    expect(db.count('clientes')).toBe(530); // 500 + 30 aplicadas
    expect((await db.getCursor('clientes')).pull_at).toBe(lastCursor);
  });

  it('lote < limite numa única página → 1 request só', async () => {
    let calls = 0;
    const pullFn = async () => {
      calls += 1;
      return {
        tables: { clientes: [{ id: 'c1', updated_at: '2026-01-01T00:00:00Z' }] },
        nextCursors: { clientes: '2026-01-01T00:00:00Z' },
      };
    };
    const pushFn = async () => ({ tables: {} });
    await syncOnce({ db, apiBase, deviceToken, pullFn, pushFn });
    expect(calls).toBe(1);
  });
});

describe('syncOnce — auth.users (login offline)', () => {
  let db;
  beforeEach(() => {
    db = makeMemDb();
  });

  it('aplica auth_users via upsertAuthUser e avança cursor próprio auth.users', async () => {
    const pullFn = async () => ({
      tables: {},
      auth_users: [
        { id: 'u1', email: 'a@e1', encrypted_password: 'h1', updated_at: '2026-03-01T00:00:00Z' },
      ],
      nextCursors: { 'auth.users': '2026-03-01T00:00:00Z' },
    });
    const pushFn = async () => ({ tables: {} });

    const res = await syncOnce({ db, apiBase, deviceToken, pullFn, pushFn });

    expect(res.ok).toBe(true);
    expect(db.get('auth.users', 'u1').encrypted_password).toBe('h1');
    expect((await db.getCursor('auth.users')).pull_at).toBe('2026-03-01T00:00:00Z');
  });

  it('envia o cursor auth.users atual no request de pull', async () => {
    await db.setCursor('auth.users', { pull_at: '2026-02-15T00:00:00Z' });
    let received = null;
    const pullFn = async ({ cursors }) => {
      received = cursors;
      return { tables: {}, auth_users: [], nextCursors: {} };
    };
    const pushFn = async () => ({ tables: {} });
    await syncOnce({ db, apiBase, deviceToken, pullFn, pushFn });
    expect(received['auth.users']).toBe('2026-02-15T00:00:00Z');
  });

  it('NÃO faz push de auth.users (não está no registro de tabelas)', async () => {
    db.seed('auth.users', { id: 'u1', email: 'a@e1', updated_at: '2026-02-01T10:00:00Z' });
    let pushed = null;
    const pushFn = async ({ rows }) => {
      pushed = rows;
      return { tables: rows };
    };
    const pullFn = async () => ({ tables: {}, auth_users: [], nextCursors: {} });
    await syncOnce({ db, apiBase, deviceToken, pullFn, pushFn });
    expect(pushed === null || pushed['auth.users'] === undefined).toBe(true);
  });
});

describe('sync-tables espelho', () => {
  it('tem 12 tabelas (8 two-way + 4 down)', () => {
    expect(SYNC_TABLES).toHaveLength(12);
    expect(TWO_WAY_TABLES).toHaveLength(8);
    expect(SYNC_TABLES.filter((t) => t.dir === 'down')).toHaveLength(4);
  });
});
