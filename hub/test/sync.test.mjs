import { describe, it, expect, beforeEach, vi } from 'vitest';

const psqlCapture = vi.hoisted(() => ({ commands: [], outputs: [], scripts: [] }));

vi.mock('node:child_process', async () => {
  const { readFile } = await import('node:fs/promises');
  return {
    execFile(_command, args, _options, callback) {
      const fileFlag = args.indexOf('-f');
      if (fileFlag < 0) {
        psqlCapture.commands.push(args);
        callback(null, { stdout: psqlCapture.outputs.shift() || '', stderr: '' });
        return;
      }
      readFile(args[fileFlag + 1], 'utf8').then(
        (body) => {
          psqlCapture.scripts.push(body);
          callback(null, { stdout: '', stderr: '' });
        },
        callback,
      );
    },
  };
});

import { IDENTITY_REFERENCES } from '../identity-reconciliation.mjs';
import {
  syncOnce,
  start,
  getState,
  makeHttpPush,
  makePsqlDb,
  MAX_PUSH_PAGES_PER_CYCLE,
  SYNC_TABLES,
} from '../sync.mjs';
import { TWO_WAY_TABLES } from '../sync-tables.mjs';

// ---------------------------------------------------------------------------
// "db" local in-memory implementando a interface mínima esperada por sync.mjs:
//   selectChanged(table, pk, cursor, limit) -> rows ((updated_at, pk) > cursor)
//   countChanged(table, pk, cursor)          -> exact remaining row count
//   upsert(table, pk, row)              -> grava por PK (idempotente)
//   getCursor(table)                    -> { pull_at, push_at }
//   setCursor(table, { pull_at?, push_at? })
//   ensureCursorTable()                 -> idempotente
// Soft-delete é apenas um upsert de uma linha com deleted_at preenchido.
// ---------------------------------------------------------------------------
function makeMemDb() {
  const tables = new Map(); // table -> Map(pk -> row)
  const cursors = new Map(); // table -> { pull_at, pull_pk, push_at, push_pk }
  const identityAliases = new Map();
  let cursorTableEnsured = false;
  let nextIdentityFailure = null;
  let identityPropagationAt = null;

  const rowKey = (pk, row) => (
    Array.isArray(pk) ? JSON.stringify(pk.map((column) => row[column])) : row[pk]
  );
  const normalizedEmail = (value) => (
    typeof value === 'string' ? value.trim().toLowerCase() : ''
  );

  const tbl = (name) => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name);
  };

  const snapshot = () => JSON.parse(JSON.stringify({
    tables: [...tables].map(([name, rows]) => [name, [...rows]]),
    aliases: [...identityAliases],
  }));

  return {
    _raw: tables,
    async ensureCursorTable() {
      cursorTableEnsured = true;
    },
    isCursorTableEnsured: () => cursorTableEnsured,
    async getCursor(table) {
      return cursors.get(table) || {
        pull_at: '1970-01-01T00:00:00Z',
        pull_pk: '',
        push_at: '1970-01-01T00:00:00Z',
        push_pk: '',
      };
    },
    async setCursor(table, patch) {
      const cur = cursors.get(table) || {
        pull_at: '1970-01-01T00:00:00Z',
        pull_pk: '',
        push_at: '1970-01-01T00:00:00Z',
        push_pk: '',
      };
      cursors.set(table, { ...cur, ...patch });
    },
    async selectChanged(table, pk, cursor, limit) {
      const rows = [...tbl(table).values()]
        .filter((row) => {
          const at = String(row.updated_at ?? '');
          const pkText = String(rowKey(pk, row) ?? '');
          return at > cursor.at || (at === cursor.at && pkText > cursor.pk);
        })
        .sort((a, b) => {
          const byTime = String(a.updated_at).localeCompare(String(b.updated_at));
          return byTime || String(rowKey(pk, a)).localeCompare(String(rowKey(pk, b)));
        });
      return rows.slice(0, limit);
    },
    async countChanged(table, pk, cursor) {
      return (await this.selectChanged(table, pk, cursor, Number.MAX_SAFE_INTEGER)).length;
    },
    async upsert(table, pk, row) {
      tbl(table).set(rowKey(pk, row), { ...row });
    },
    async applyCanonicalPage(table, pk, rows, cursor, aliases = []) {
      const tablesBefore = new Map(
        [...tables].map(([name, entries]) => [
          name,
          new Map([...entries].map(([key, row]) => [key, { ...row }])),
        ]),
      );
      const hadCursor = cursors.has(table);
      const cursorBefore = hadCursor ? { ...cursors.get(table) } : null;
      try {
        for (const alias of aliases) {
          const old = tbl('clientes').get(alias.oldId);
          if (old) {
            tbl('clientes').set(alias.oldId, {
              ...old,
              deleted_at: old.deleted_at || alias.sourceUpdatedAt,
            });
          }
        }
        for (const row of rows) await this.upsert(table, pk, row);
        for (const alias of aliases) {
          for (const refTable of ['pedidos', 'ordens_servico', 'cliente_enderecos']) {
            for (const [key, row] of tbl(refTable)) {
              if (row.cliente_id === alias.oldId) {
                const canonicalHasDefault = refTable === 'cliente_enderecos' &&
                  row.is_padrao === true &&
                  [...tbl(refTable).values()].some((candidate) => (
                    candidate.cliente_id === alias.canonicalId && candidate.is_padrao === true
                  ));
                tbl(refTable).set(key, {
                  ...row,
                  cliente_id: alias.canonicalId,
                  ...(canonicalHasDefault ? { is_padrao: false } : {}),
                });
              }
            }
          }
        }
        await this.setCursor(table, cursor);
      } catch (error) {
        tables.clear();
        for (const [name, entries] of tablesBefore) tables.set(name, entries);
        if (hadCursor) cursors.set(table, cursorBefore);
        else cursors.delete(table);
        throw error;
      }
    },
    async findAuthUserByNormalizedEmail(email) {
      return [...tbl('auth.users').values()].find(
        (row) => normalizedEmail(row.email) === email,
      ) || null;
    },
    async upsertAuthUserById(row) {
      tbl('auth.users').set(row.id, { ...row });
    },
    async aliasAndUpsertAuthUser({
      oldUserId, canonicalUser, normalizedEmail: email, aliasEmail,
    }) {
      const old = tbl('auth.users').get(oldUserId);
      const currentAlias = identityAliases.get(oldUserId);
      const sameMapping = currentAlias?.canonical_user_id === canonicalUser.id;
      if (old) tbl('auth.users').set(oldUserId, { ...old, email: aliasEmail });
      tbl('auth.users').set(canonicalUser.id, { ...canonicalUser });
      identityAliases.set(oldUserId, {
        old_user_id: oldUserId,
        canonical_user_id: canonicalUser.id,
        normalized_email: email,
        canonical_profile_applied_at: sameMapping
          ? currentAlias.canonical_profile_applied_at
          : null,
        resolved_at: sameMapping ? currentAlias.resolved_at : null,
        last_error: sameMapping ? currentAlias.last_error : null,
      });
    },
    async markCanonicalProfileApplied(userId) {
      for (const [oldUserId, alias] of identityAliases) {
        if (alias.canonical_user_id !== userId || alias.resolved_at) continue;
        identityAliases.set(oldUserId, {
          ...alias,
          canonical_profile_applied_at: '2026-07-14T10:00:00Z',
        });
      }
    },
    async listPendingIdentityAliases() {
      return [...identityAliases.values()].filter((alias) => !alias.resolved_at);
    },
    async profileExists(userId) {
      return tbl('profiles').has(userId);
    },
    async repointIdentityAlias(alias) {
      if (nextIdentityFailure) {
        const error = nextIdentityFailure;
        nextIdentityFailure = null;
        throw error;
      }
      for (const ref of IDENTITY_REFERENCES) {
        for (const [key, row] of tbl(ref.table)) {
          if (row[ref.column] === alias.old_user_id) {
            tbl(ref.table).set(key, {
              ...row,
              [ref.column]: alias.canonical_user_id,
              ...(ref.propagate && identityPropagationAt
                ? { updated_at: identityPropagationAt }
                : {}),
            });
          }
        }
      }
      for (const [key, row] of tbl('provisioning_codes')) {
        if (row.created_by === alias.old_user_id) {
          tbl('provisioning_codes').set(key, {
            ...row,
            created_by: alias.canonical_user_id,
          });
        }
      }
      tbl('profiles').delete(alias.old_user_id);
      tbl('auth.users').delete(alias.old_user_id);
      identityAliases.set(alias.old_user_id, {
        ...identityAliases.get(alias.old_user_id),
        resolved_at: '2026-07-14T10:00:01Z',
        last_error: null,
      });
    },
    async markIdentityAliasError(oldUserId, message) {
      identityAliases.set(oldUserId, {
        ...identityAliases.get(oldUserId),
        last_error: message,
      });
    },
    // helpers de teste
    get(table, id) {
      return tbl(table).get(Array.isArray(id) ? JSON.stringify(id) : id);
    },
    count(table) {
      return tbl(table).size;
    },
    seed(table, row, pk = 'id') {
      tbl(table).set(rowKey(pk, row), { ...row });
    },
    identityAlias: (oldUserId) => identityAliases.get(oldUserId),
    snapshot,
    failNextIdentityTransaction(error) {
      nextIdentityFailure = error;
    },
    setIdentityPropagationAt(at) {
      identityPropagationAt = at;
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

const apiBase = 'http://cloud.example';
const deviceToken = 'dev-token-xyz';

describe('makePsqlDb — transações de identidade', () => {
  const cfg = {
    ports: { pg: 5432 },
    paths: { pgHost: 'localhost', user: 'postgres', db: 'exped' },
  };
  const oldId = '00000000-0000-0000-0000-000000000111';
  const canonicalId = '00000000-0000-0000-0000-000000000222';
  const normalizedEmail = 'eduardo@franzoni.local';

  beforeEach(() => {
    psqlCapture.scripts.length = 0;
  });

  async function capturedRepointScript() {
    const db = makePsqlDb(cfg);
    await db.repointIdentityAlias({
      old_user_id: oldId,
      canonical_user_id: canonicalId,
      normalized_email: normalizedEmail,
      canonical_profile_applied_at: '2026-07-14T10:00:00Z',
    });
    expect(psqlCapture.scripts).toHaveLength(1);
    return psqlCapture.scripts[0];
  }

  it('replay do mesmo mapeamento preserva marcador e resolução no upsert', async () => {
    const db = makePsqlDb(cfg);

    await db.aliasAndUpsertAuthUser({
      oldUserId: oldId,
      canonicalUser: { id: canonicalId, email: normalizedEmail },
      normalizedEmail,
      aliasEmail: `exped-alias+${oldId}@invalid.local`,
    });

    expect(psqlCapture.scripts).toHaveLength(1);
    const sql = psqlCapture.scripts[0];
    expect(sql).toMatch(
      /canonical_profile_applied_at\s*=\s*case when current_alias\.canonical_user_id\s*=\s*excluded\.canonical_user_id\s*then current_alias\.canonical_profile_applied_at\s*else null end/,
    );
    expect(sql).toMatch(
      /resolved_at\s*=\s*case when current_alias\.canonical_user_id\s*=\s*excluded\.canonical_user_id\s*then current_alias\.resolved_at\s*else null end/,
    );
  });

  it('reconciliação serializa por e-mail e revalida o alias sob o lock', async () => {
    const sql = await capturedRepointScript();
    const advisoryLock = `select pg_advisory_xact_lock(hashtext('exped.identity:${normalizedEmail}'));`;
    const aliasRecheck = `and normalized_email = '${normalizedEmail}'`;

    expect(sql.trimStart().startsWith('begin;')).toBe(true);
    expect(sql.trimEnd().endsWith('commit;')).toBe(true);
    expect(sql).toContain(advisoryLock);
    expect(sql).toContain(aliasRecheck);
    expect(sql.indexOf(advisoryLock)).toBeLessThan(sql.indexOf(aliasRecheck));
  });

  it('trava perfis antigo e canônico em ordem antes de varrer referências', async () => {
    const sql = await capturedRepointScript();
    const lockStart = sql.indexOf('perform p.id from public.profiles p');
    const lockEnd = sql.indexOf('for update;', lockStart);
    const profileLock = sql.slice(lockStart, lockEnd + 'for update;'.length);

    expect(lockStart).toBeGreaterThan(-1);
    expect(profileLock).toContain(`${oldId}'::uuid`);
    expect(profileLock).toContain(`${canonicalId}'::uuid`);
    expect(profileLock).toMatch(/order by p\.id for update;$/);
    expect(lockEnd).toBeLessThan(sql.indexOf('update public."pedidos"'));
  });

  it('limpa a FK de auditoria antes de excluir o auth antigo', async () => {
    const sql = await capturedRepointScript();
    const auditCleanup =
      `update public."provisioning_codes" set "created_by" = '${canonicalId}'::uuid ` +
      `where "created_by" = '${oldId}'::uuid;`;
    const authCleanup = `delete from auth.users where id = '${oldId}'::uuid;`;

    expect(sql).toContain(auditCleanup);
    expect(sql.indexOf(auditCleanup)).toBeLessThan(sql.indexOf(authCleanup));
  });
});

describe('makePsqlDb — cursores keyset', () => {
  const cfg = {
    ports: { pg: 5432 },
    paths: { pgHost: 'localhost', user: 'postgres', db: 'exped' },
  };

  beforeEach(() => {
    psqlCapture.commands.length = 0;
    psqlCapture.outputs.length = 0;
    psqlCapture.scripts.length = 0;
  });

  it('migra instalações existentes com pull_pk e push_pk não nulos', async () => {
    await makePsqlDb(cfg).ensureCursorTable();

    expect(psqlCapture.scripts).toHaveLength(1);
    expect(psqlCapture.scripts[0]).toMatch(
      /alter table public\._sync_cursors\s+add column if not exists pull_pk text not null default ''/i,
    );
    expect(psqlCapture.scripts[0]).toMatch(
      /alter table public\._sync_cursors\s+add column if not exists push_pk text not null default ''/i,
    );
  });

  it('seleciona e conta somente depois da tupla updated_at/PK', async () => {
    const db = makePsqlDb(cfg);
    const cursor = { at: '2026-07-14T12:00:00.000Z', pk: 'p0499' };

    await db.selectChanged('pedidos', 'id', cursor, 500);
    await db.countChanged('pedidos', 'id', cursor);

    const sql = psqlCapture.commands.map((args) => args.at(-1)).join('\n');
    expect(sql).toContain('(updated_at, "id"::text) >');
    expect(sql).toContain("'2026-07-14T12:00:00.000Z'::timestamptz, 'p0499'::text");
    expect(sql).toContain('order by updated_at asc, "id"::text asc limit 500');
    expect(sql).toContain('select count(*) from public."pedidos"');
  });

  it('preserva microssegundos de pull_at e push_at no round-trip keyset', async () => {
    psqlCapture.outputs.push(JSON.stringify({
      pull_at: '2026-07-14T11:59:59.123456Z',
      pull_pk: 'c0123',
      push_at: '2026-07-14T12:00:00.654321Z',
      push_pk: 'p0499',
    }));
    const db = makePsqlDb(cfg);

    const stored = await db.getCursor('pedidos');
    await db.selectChanged(
      'pedidos',
      'id',
      { at: stored.push_at, pk: stored.push_pk },
      500,
    );

    expect(stored).toEqual({
      pull_at: '2026-07-14T11:59:59.123456Z',
      pull_pk: 'c0123',
      push_at: '2026-07-14T12:00:00.654321Z',
      push_pk: 'p0499',
    });
    const cursorSql = psqlCapture.commands[0].at(-1);
    expect(cursorSql.match(/HH24:MI:SS\.US"Z"/g)).toHaveLength(2);
    const keysetSql = psqlCapture.commands[1].at(-1);
    expect(keysetSql).toContain("'2026-07-14T12:00:00.654321Z'::timestamptz");
    expect(keysetSql).not.toContain("'2026-07-14T12:00:00Z'::timestamptz");
  });

  it('rejeita tabela ou PK fora do registro antes de chamar psql', async () => {
    const db = makePsqlDb(cfg);
    const cursor = { at: '2026-07-14T12:00:00.000Z', pk: '' };

    await expect(db.selectChanged('auth.users', 'id', cursor, 500)).rejects.toThrow(
      'tabela de push não permitida',
    );
    await expect(db.countChanged('pedidos', 'empresa_id', cursor)).rejects.toThrow(
      'PK de push inválida',
    );
    expect(psqlCapture.commands).toHaveLength(0);
  });

  it('persiste push_at e push_pk na mesma escrita', async () => {
    await makePsqlDb(cfg).setCursor('pedidos', {
      push_at: '2026-07-14T12:00:00.000Z',
      push_pk: 'p0529',
    });

    expect(psqlCapture.commands).toHaveLength(1);
    const sql = psqlCapture.commands[0].at(-1);
    expect(sql).toContain('(table_name, pull_at, pull_pk, push_at, push_pk)');
    expect(sql).toContain("'2026-07-14T12:00:00.000Z', 'p0529'");
    expect(sql).toContain('push_at = excluded.push_at');
    expect(sql).toContain('push_pk = excluded.push_pk');
  });

  it('persiste pull_at e pull_pk na mesma escrita', async () => {
    await makePsqlDb(cfg).setCursor('clientes', {
      pull_at: '2026-07-14T12:00:00.000Z',
      pull_pk: 'c0529',
    });

    expect(psqlCapture.commands).toHaveLength(1);
    const sql = psqlCapture.commands[0].at(-1);
    expect(sql).toContain('(table_name, pull_at, pull_pk, push_at, push_pk)');
    expect(sql).toContain("'2026-07-14T12:00:00.000Z', 'c0529'");
    expect(sql).toContain('pull_at = excluded.pull_at');
    expect(sql).toContain('pull_pk = excluded.pull_pk');
  });

  it('aplica uma pagina de pull e o cursor na mesma transacao SQL', async () => {
    const db = makePsqlDb(cfg);
    expect(typeof db.applyPulledPage).toBe('function');
    if (typeof db.applyPulledPage !== 'function') return;

    await db.applyPulledPage(
      'clientes',
      'id',
      [
        { id: 'c1', nome: 'Ana', updated_at: '2026-07-14T12:00:00.000Z' },
        { id: 'c2', nome: 'Bia', updated_at: '2026-07-14T12:01:00.000Z' },
      ],
      { pull_at: '2026-07-14T12:01:00.000Z', pull_pk: 'c2' },
    );

    expect(psqlCapture.commands).toHaveLength(0);
    expect(psqlCapture.scripts).toHaveLength(1);
    const sql = psqlCapture.scripts[0];
    expect(sql.match(/insert into public\.clientes/g)).toHaveLength(2);
    expect(sql).toContain('pull_at = excluded.pull_at');
    expect(sql).toContain('pull_pk = excluded.pull_pk');
    expect(sql.indexOf('insert into public._sync_cursors')).toBeLessThan(sql.lastIndexOf('commit;'));
  });

  it('aplica todas as canônicas e o cursor de push em uma única transação SQL', async () => {
    await makePsqlDb(cfg).applyCanonicalPage(
      'pedidos',
      'id',
      [
        { id: 'p1', status: 'rascunho', updated_at: '2026-07-14T12:00:00.000Z' },
        { id: 'p2', status: 'finalizado', updated_at: '2026-07-14T12:01:00.000Z' },
      ],
      { push_at: '2026-07-14T12:01:00.000Z', push_pk: 'p2' },
    );

    expect(psqlCapture.commands).toHaveLength(0);
    expect(psqlCapture.scripts).toHaveLength(1);
    const sql = psqlCapture.scripts[0];
    expect(sql.match(/insert into public\.pedidos/g)).toHaveLength(2);
    expect(sql).toContain('insert into public._sync_cursors');
    expect(sql.indexOf('begin;')).toBeLessThan(sql.indexOf('insert into public.pedidos'));
    expect(sql.indexOf('insert into public._sync_cursors')).toBeLessThan(sql.lastIndexOf('commit;'));
  });

  it('reconcilia cliente local antes de inserir a PK canônica e só então avança o cursor', async () => {
    await makePsqlDb(cfg).applyCanonicalPage(
      'clientes',
      'id',
      [{
        id: '91000000-0000-0000-0000-000000000017',
        empresa_id: '91000000-0000-0000-0000-000000000001',
        cnpj_cpf: '12345678000190',
        updated_at: '2026-07-14T12:01:00.000Z',
      }],
      { push_at: '2026-07-14T12:00:00.000Z', push_pk: '91000000-0000-0000-0000-000000000018' },
      [{
        oldId: '91000000-0000-0000-0000-000000000018',
        canonicalId: '91000000-0000-0000-0000-000000000017',
        empresaId: '91000000-0000-0000-0000-000000000001',
        sourceUpdatedAt: '2026-07-14T12:00:00.000Z',
      }],
    );

    const sql = psqlCapture.scripts[0];
    const tombstone = sql.indexOf('update public.clientes set deleted_at');
    const canonical = sql.indexOf('insert into public.clientes');
    const repoint = sql.indexOf('update public.pedidos set cliente_id');
    const cursor = sql.indexOf('insert into public._sync_cursors');
    expect(sql).toContain('order by id for update');
    expect(tombstone).toBeGreaterThan(sql.indexOf('begin;'));
    expect(tombstone).toBeLessThan(canonical);
    expect(canonical).toBeLessThan(repoint);
    expect(repoint).toBeLessThan(cursor);
    expect(cursor).toBeLessThan(sql.lastIndexOf('commit;'));
  });
});

describe('makeHttpPush — diagnóstico seguro', () => {
  async function rejectedPush(response) {
    const push = makeHttpPush({
      apiBase,
      deviceToken,
      fetchImpl: vi.fn().mockResolvedValue(response),
    });

    try {
      await push({ rows: { pedidos: [{ id: 'p-4079' }] } });
      throw new Error('push deveria falhar');
    } catch (error) {
      return error;
    }
  }

  it('aceita somente tabela two-way e PK allowlisted', async () => {
    const json = vi.fn(async () => ({
      error: 'duplicate key value violates secret_constraint',
      blockedRow: { table: 'pedidos', pk: 'p-4079' },
      stack: '/srv/private/sync.mjs:99',
    }));
    const error = await rejectedPush({
      ok: false,
      status: 500,
      json,
    });

    expect(json).toHaveBeenCalledOnce();
    expect(error).toMatchObject({
      message: 'push HTTP 500',
      status: 500,
      blockedRow: { table: 'pedidos', pk: 'p-4079' },
    });
    expect(error.message).not.toContain('secret_constraint');
    expect(error).not.toHaveProperty('error');
  });

  it('converte Retry-After em uma espera limitada para o loop', async () => {
    const error = await rejectedPush({
      ok: false,
      status: 503,
      headers: { get: vi.fn(() => '30') },
      json: vi.fn(async () => ({ error: 'schema em rollout' })),
    });

    expect(error).toMatchObject({
      message: 'push HTTP 503',
      status: 503,
      retryAfterMs: 30_000,
    });
  });

  it.each([
    ['tabela desconhecida', { table: 'auth.users', pk: 'u-1' }],
    ['PK vazia', { table: 'pedidos', pk: '' }],
    ['PK com caractere proibido', { table: 'pedidos', pk: 'p 4079' }],
    ['PK longa', { table: 'pedidos', pk: 'p'.repeat(129) }],
    ['shape não textual', { table: 'pedidos', pk: 4079 }],
  ])('ignora blockedRow inválida: %s', async (_case, blockedRow) => {
    const json = vi.fn(async () => ({
      error: 'SQL detail with private@example.com and bearer-token',
      blockedRow,
    }));
    const error = await rejectedPush({
      ok: false,
      status: 409,
      json,
    });

    expect(json).toHaveBeenCalledOnce();
    expect(error).toMatchObject({ message: 'push HTTP 409', status: 409 });
    expect(error).not.toHaveProperty('blockedRow');
    expect(error.message).not.toContain('private@example.com');
    expect(error.message).not.toContain('bearer-token');
  });

  it('ignora body não JSON e preserva a falha HTTP', async () => {
    const json = vi.fn(async () => {
      throw new SyntaxError('Unexpected token < in /srv/private/error.html');
    });
    const error = await rejectedPush({
      ok: false,
      status: 502,
      json,
    });

    expect(json).toHaveBeenCalledOnce();
    expect(error).toMatchObject({ message: 'push HTTP 502', status: 502 });
    expect(error).not.toHaveProperty('blockedRow');
    expect(error.message).not.toContain('/srv/private/error.html');
  });
});

describe('syncOnce — pull', () => {
  let db;
  beforeEach(() => {
    db = makeMemDb();
  });

  it('não avança o cursor da tabela quando uma linha falha', async () => {
    const orig = db.upsert;
    db.upsert = async (table, pk, row) => {
      if (table === 'clientes' && row.id === 'c2') throw new Error('FK simulada');
      return orig(table, pk, row);
    };
    const pullFn = async () => ({
      tables: {
        clientes: [
          { id: 'c1', nome: 'Ana', updated_at: '2026-01-01T10:00:00Z' },
          { id: 'c2', nome: 'Bia', updated_at: '2026-01-02T10:00:00Z' },
          { id: 'c3', nome: 'Cid', updated_at: '2026-01-03T10:00:00Z' },
        ],
      },
      nextCursors: { clientes: '2026-01-03T10:00:00Z' },
    });
    const pushFn = async () => ({ tables: {} });

    const res = await syncOnce({ db, apiBase, deviceToken, pullFn, pushFn });

    // As linhas válidas podem ser idempotentemente reaplicadas no retry, mas a
    // página incompleta nunca pode ser descartada pelo avanço do cursor.
    expect(db.get('clientes', 'c1')).toBeTruthy();
    expect(db.get('clientes', 'c3')).toBeTruthy();
    expect(db.get('clientes', 'c2')).toBeFalsy();
    expect((await db.getCursor('clientes')).pull_at).toBe('1970-01-01T00:00:00Z');
    expect(res.ok).toBe(false);
    expect(getState().lastSkipped).toBe(1);
  });

  it('repete a página incompleta e avança o cursor após sucesso', async () => {
    const originalUpsert = db.upsert;
    let fail = true;
    db.upsert = async (table, pk, row) => {
      if (fail && table === 'clientes' && row.id === 'c2') throw new Error('FK simulada');
      return originalUpsert(table, pk, row);
    };
    const receivedCursors = [];
    const pullFn = async ({ cursors }) => {
      receivedCursors.push(cursors.clientes);
      return {
        tables: {
          clientes: [
            { id: 'c1', nome: 'Ana', updated_at: '2026-01-01T10:00:00Z' },
            { id: 'c2', nome: 'Bia', updated_at: '2026-01-02T10:00:00Z' },
          ],
        },
        nextCursors: { clientes: '2026-01-02T10:00:00Z' },
      };
    };
    const pushFn = async ({ rows }) => ({ tables: rows });

    const failed = await syncOnce({ db, apiBase, deviceToken, pullFn, pushFn });
    fail = false;
    const retried = await syncOnce({ db, apiBase, deviceToken, pullFn, pushFn });

    expect(failed.ok).toBe(false);
    expect(retried.ok).toBe(true);
    expect(receivedCursors).toEqual([
      '1970-01-01T00:00:00Z',
      '1970-01-01T00:00:00Z',
    ]);
    expect(db.get('clientes', 'c2').nome).toBe('Bia');
    expect((await db.getCursor('clientes')).pull_at).toBe('2026-01-02T10:00:00Z');
  });

  it('avança uma tabela bem-sucedida sem perder a página de outra tabela', async () => {
    const originalUpsert = db.upsert;
    db.upsert = async (table, pk, row) => {
      if (table === 'clientes') throw new Error('FK simulada');
      return originalUpsert(table, pk, row);
    };
    const pullFn = async () => ({
      tables: {
        empresas: [{ id: 'e1', nome: 'Franzoni', updated_at: '2026-01-01T09:00:00Z' }],
        clientes: [{ id: 'c1', nome: 'Ana', updated_at: '2026-01-01T10:00:00Z' }],
      },
      nextCursors: {
        empresas: '2026-01-01T09:00:00Z',
        clientes: '2026-01-01T10:00:00Z',
      },
    });

    const result = await syncOnce({
      db,
      apiBase,
      deviceToken,
      pullFn,
      pushFn: async () => ({ tables: {} }),
    });

    expect(result.ok).toBe(false);
    expect((await db.getCursor('empresas')).pull_at).toBe('2026-01-01T09:00:00Z');
    expect((await db.getCursor('clientes')).pull_at).toBe('1970-01-01T00:00:00Z');
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

  it('nao persiste pull_pk inferido quando o cloud legado devolve so timestamp', async () => {
    const timestamp = '2026-07-14T12:00:00.123456Z';
    const result = await syncOnce({
      db,
      apiBase,
      deviceToken,
      pullFn: async () => ({
        tables: {
          clientes: [{ id: 'c-legado', nome: 'Legado', updated_at: timestamp }],
        },
        nextCursors: { clientes: timestamp },
      }),
      pushFn: async () => ({ tables: {} }),
    });

    expect(result.ok).toBe(true);
    expect(await db.getCursor('clientes')).toMatchObject({
      pull_at: timestamp,
      pull_pk: '',
    });
  });

  it('persiste pull_at + pull_pk e baixa 530 empates em duas páginas', async () => {
    const timestamp = '2026-07-14T12:00:00.123456Z';
    const rows = Array.from({ length: 530 }, (_, index) => ({
      id: `c${String(index).padStart(4, '0')}`,
      nome: `Cliente ${index}`,
      updated_at: timestamp,
    }));
    const received = [];
    let calls = 0;
    const pullFn = async ({ cursors }) => {
      calls += 1;
      received.push({ at: cursors.clientes, pk: cursors['clientes.__pk'] });
      if (calls === 1) {
        return {
          tables: { clientes: rows.slice(0, 500) },
          nextCursors: {
            clientes: timestamp,
            'clientes.__pk': 'c0499',
          },
        };
      }
      if (cursors['clientes.__pk'] !== 'c0499') {
        throw new Error('pull_pk de clientes não foi reenviado');
      }
      return {
        tables: { clientes: rows.slice(500) },
        nextCursors: {
          clientes: timestamp,
          'clientes.__pk': 'c0529',
        },
      };
    };

    const result = await syncOnce({
      db,
      apiBase,
      deviceToken,
      pullFn,
      pushFn: async () => ({ tables: {} }),
    });

    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
    expect(received).toEqual([
      { at: '1970-01-01T00:00:00Z', pk: '' },
      { at: timestamp, pk: 'c0499' },
    ]);
    expect(db.count('clientes')).toBe(530);
    expect(await db.getCursor('clientes')).toMatchObject({
      pull_at: timestamp,
      pull_pk: 'c0529',
    });
  });

  it('preserva múltiplas linhas com PK composta no fake local', async () => {
    const pullFn = async () => ({
      tables: {
        hiper_vendedor_map: [
          {
            empresa_id: 'e1',
            hiper_usuario_id: 10,
            vendedor_id: 'v1',
            updated_at: '2026-05-01T00:00:00Z',
          },
          {
            empresa_id: 'e1',
            hiper_usuario_id: 20,
            vendedor_id: 'v2',
            updated_at: '2026-05-01T00:00:01Z',
          },
        ],
      },
      nextCursors: { hiper_vendedor_map: '2026-05-01T00:00:01Z' },
    });

    await syncOnce({
      db,
      apiBase,
      deviceToken,
      pullFn,
      pushFn: async () => ({ tables: {} }),
    });

    expect(db.count('hiper_vendedor_map')).toBe(2);
    expect(
      [...db._raw.get('hiper_vendedor_map').values()]
        .map((row) => row.hiper_usuario_id)
        .sort((a, b) => a - b),
    ).toEqual([10, 20]);
  });
});

describe('syncOnce — push', () => {
  let db;
  beforeEach(() => {
    db = makeMemDb();
  });

  function seedPedidos(count, timestampFor = () => '2026-07-14T12:00:00.000Z') {
    for (let i = 0; i < count; i += 1) {
      db.seed('pedidos', {
        id: `p${String(i).padStart(4, '0')}`,
        updated_at: timestampFor(i),
      });
    }
  }

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
    expect(await db.getCursor('clientes')).toMatchObject({
      push_at: '2026-02-01T10:00:00Z',
      push_pk: 'c1',
    });
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

  it('resposta 200 sem a tabela enviada não confirma nem avança o lote', async () => {
    db.seed('clientes', { id: 'c1', nome: 'Ana', updated_at: '2026-02-01T10:00:00Z' });

    const result = await syncOnce({
      db,
      apiBase,
      deviceToken,
      pushFn: async () => ({ tables: {} }),
      pullFn: async () => ({ tables: {}, nextCursors: {} }),
    });

    expect(result.ok).toBe(false);
    expect(db.get('clientes', 'c1').nome).toBe('Ana');
    expect(await db.getCursor('clientes')).toMatchObject({
      push_at: '1970-01-01T00:00:00Z',
      push_pk: '',
    });
  });

  it('resposta 200 com menos canônicas não aplica resposta parcial nem avança o lote', async () => {
    db.seed('clientes', { id: 'c1', nome: 'Ana', updated_at: '2026-02-01T10:00:00Z' });
    db.seed('clientes', { id: 'c2', nome: 'Bia', updated_at: '2026-02-01T11:00:00Z' });

    const result = await syncOnce({
      db,
      apiBase,
      deviceToken,
      pushFn: async () => ({
        tables: {
          clientes: [
            { id: 'c1', nome: 'Ana-parcial', updated_at: '2026-02-01T10:00:00Z' },
          ],
        },
      }),
      pullFn: async () => ({ tables: {}, nextCursors: {} }),
    });

    expect(result.ok).toBe(false);
    expect(db.get('clientes', 'c1').nome).toBe('Ana');
    expect(await db.getCursor('clientes')).toMatchObject({
      push_at: '1970-01-01T00:00:00Z',
      push_pk: '',
    });
  });

  it('resposta 200 com PK canônica diferente não aplica nem avança o lote', async () => {
    db.seed('clientes', { id: 'c1', nome: 'Ana', updated_at: '2026-02-01T10:00:00Z' });

    const result = await syncOnce({
      db,
      apiBase,
      deviceToken,
      pushFn: async () => ({
        tables: {
          clientes: [
            { id: 'c-outra', nome: 'Outra', updated_at: '2026-02-01T10:00:00Z' },
          ],
        },
      }),
      pullFn: async () => ({ tables: {}, nextCursors: {} }),
    });

    expect(result.ok).toBe(false);
    expect(db.get('clientes', 'c-outra')).toBeUndefined();
    expect(db.get('clientes', 'c1').nome).toBe('Ana');
    expect(await db.getCursor('clientes')).toMatchObject({
      push_at: '1970-01-01T00:00:00Z',
      push_pk: '',
    });
  });

  it('reconcilia alias de cliente quando a nuvem devolve a PK canônica do mesmo CNPJ', async () => {
    db.seed('clientes', {
      id: 'c-alias',
      empresa_id: 'e1',
      cnpj_cpf: '12.345.678/0001-90',
      nome: 'Cliente local',
      updated_at: '2026-02-01T10:00:00Z',
      deleted_at: null,
    });
    db.seed('pedidos', { id: 'p1', cliente_id: 'c-alias' });
    db.seed('ordens_servico', { id: 'os1', cliente_id: 'c-alias' });
    db.seed('cliente_enderecos', { id: 'end1', cliente_id: 'c-alias' });

    const result = await syncOnce({
      db,
      apiBase,
      deviceToken,
      pushFn: async () => ({
        tables: {
          clientes: [{
            id: 'c-canonico',
            empresa_id: 'e1',
            cnpj_cpf: '12345678000190',
            nome: 'Cliente local',
            updated_at: '2026-02-01T10:01:00Z',
            deleted_at: null,
          }],
        },
      }),
      pullFn: async () => ({ tables: {}, nextCursors: {} }),
    });

    expect(result.ok).toBe(true);
    expect(db.get('clientes', 'c-alias').deleted_at).toBeTruthy();
    expect(db.get('clientes', 'c-canonico').cnpj_cpf).toBe('12345678000190');
    expect(db.get('pedidos', 'p1').cliente_id).toBe('c-canonico');
    expect(db.get('ordens_servico', 'os1').cliente_id).toBe('c-canonico');
    expect(db.get('cliente_enderecos', 'end1').cliente_id).toBe('c-canonico');
    expect(await db.getCursor('clientes')).toMatchObject({
      push_at: '2026-02-01T10:00:00Z',
      push_pk: 'c-alias',
    });
  });

  it('confirma varios aliases locais quando a nuvem devolve a mesma PK canonica', async () => {
    db.seed('clientes', {
      id: 'c-alias-1',
      empresa_id: 'e1',
      cnpj_cpf: '12.345.678/0001-90',
      nome: 'Cliente local 1',
      updated_at: '2026-02-01T10:00:00Z',
      deleted_at: null,
    });
    db.seed('clientes', {
      id: 'c-alias-2',
      empresa_id: 'e1',
      cnpj_cpf: '12345678000190',
      nome: 'Cliente local 2',
      updated_at: '2026-02-01T11:00:00Z',
      deleted_at: null,
    });
    db.seed('pedidos', { id: 'p1', cliente_id: 'c-alias-1' });
    db.seed('ordens_servico', { id: 'os1', cliente_id: 'c-alias-2' });

    const canonicalBase = {
      id: 'c-canonico',
      empresa_id: 'e1',
      cnpj_cpf: '12345678000190',
      deleted_at: null,
    };
    const result = await syncOnce({
      db,
      apiBase,
      deviceToken,
      pushFn: async () => ({
        tables: {
          clientes: [
            {
              ...canonicalBase,
              nome: 'Cliente canonico inicial',
              updated_at: '2026-02-01T11:01:00Z',
            },
            {
              ...canonicalBase,
              nome: 'Cliente canonico final',
              updated_at: '2026-02-01T11:02:00Z',
            },
          ],
        },
      }),
      pullFn: async () => ({ tables: {}, nextCursors: {} }),
    });

    expect(result.ok).toBe(true);
    expect(db.get('clientes', 'c-alias-1').deleted_at).toBeTruthy();
    expect(db.get('clientes', 'c-alias-2').deleted_at).toBeTruthy();
    expect(db.get('clientes', 'c-canonico').nome).toBe('Cliente canonico final');
    expect(db.get('pedidos', 'p1').cliente_id).toBe('c-canonico');
    expect(db.get('ordens_servico', 'os1').cliente_id).toBe('c-canonico');
    expect(await db.getCursor('clientes')).toMatchObject({
      push_at: '2026-02-01T11:00:00Z',
      push_pk: 'c-alias-2',
    });
  });

  it('resposta 200 sem updated_at canônico não aplica nem avança o lote', async () => {
    db.seed('clientes', {
      id: 'c1',
      nome: 'Ana',
      bairro: 'Centro',
      updated_at: '2026-02-01T10:00:00Z',
    });

    const result = await syncOnce({
      db,
      apiBase,
      deviceToken,
      pushFn: async () => ({
        tables: { clientes: [{ id: 'c1', nome: 'Ana-cloud', bairro: 'Centro' }] },
      }),
      pullFn: async () => ({ tables: {}, nextCursors: {} }),
    });

    expect(result.ok).toBe(false);
    expect(db.get('clientes', 'c1')).toMatchObject({ nome: 'Ana', bairro: 'Centro' });
    expect(await db.getCursor('clientes')).toMatchObject({
      push_at: '1970-01-01T00:00:00Z',
      push_pk: '',
    });
  });

  it('resposta 200 sem coluna da linha enviada é canônica incompleta', async () => {
    db.seed('clientes', {
      id: 'c1',
      nome: 'Ana',
      bairro: 'Centro',
      updated_at: '2026-02-01T10:00:00Z',
    });

    const result = await syncOnce({
      db,
      apiBase,
      deviceToken,
      pushFn: async () => ({
        tables: {
          clientes: [
            { id: 'c1', nome: 'Ana-cloud', updated_at: '2026-02-01T10:00:00Z' },
          ],
        },
      }),
      pullFn: async () => ({ tables: {}, nextCursors: {} }),
    });

    expect(result.ok).toBe(false);
    expect(db.get('clientes', 'c1')).toMatchObject({ nome: 'Ana', bairro: 'Centro' });
    expect(await db.getCursor('clientes')).toMatchObject({
      push_at: '1970-01-01T00:00:00Z',
      push_pk: '',
    });
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

  it('403 falha o ciclo, preserva a página rejeitada e não trava o resto', async () => {
    db.seed('clientes', { id: 'c1', nome: 'Ana', updated_at: '2026-02-01T10:00:00Z' });
    db.seed('pedidos', { id: 'p1', total: 10, updated_at: '2026-02-01T11:00:00Z' });
    const pushFn = async ({ rows }) => {
      if (rows.clientes) {
        const err = new Error('403');
        err.status = 403;
        err.blockedRow = { table: 'clientes', pk: 'c1' };
        throw err;
      }
      return { tables: rows };
    };
    const pullFn = async () => ({ tables: {}, nextCursors: {} });

    const res = await syncOnce({ db, apiBase, deviceToken, pullFn, pushFn });

    // clientes rejeitado → cursor não avança; pedidos passou → avançou
    expect(await db.getCursor('clientes')).toMatchObject({
      push_at: '1970-01-01T00:00:00Z',
      push_pk: '',
    });
    expect(await db.getCursor('pedidos')).toMatchObject({
      push_at: '2026-02-01T11:00:00Z',
      push_pk: 'p1',
    });
    expect(res.ok).toBe(false);
    expect(getState()).toMatchObject({
      lastSyncOk: false,
      pendingPush: 1,
      caughtUp: false,
      lastBlockedRow: { table: 'clientes', pk: 'c1' },
    });
  });

  it('403 sem blockedRow da API não fabrica identidade a partir do lote', async () => {
    db.seed('clientes', { id: 'c1', updated_at: '2026-02-01T10:00:00Z' });

    const result = await syncOnce({
      db,
      apiBase,
      deviceToken,
      pushFn: async () => {
        const error = new Error('403');
        error.status = 403;
        throw error;
      },
      pullFn: async () => ({ tables: {}, nextCursors: {} }),
    });

    expect(result.ok).toBe(false);
    expect(await db.getCursor('clientes')).toMatchObject({
      push_at: '1970-01-01T00:00:00Z',
      push_pk: '',
    });
    expect(getState()).toMatchObject({
      pendingPush: 1,
      caughtUp: false,
      lastBlockedRow: null,
    });
  });

  it('push 500 + 500 + 30 envia três páginas e zera backlog', async () => {
    const base = Date.parse('2026-07-14T10:00:00.000Z');
    seedPedidos(1030, (i) => new Date(base + i).toISOString());
    const sizes = [];

    await syncOnce({
      db,
      apiBase,
      deviceToken,
      pushFn: async ({ rows }) => {
        sizes.push(rows.pedidos.length);
        return { tables: rows };
      },
      pullFn: async () => ({ tables: {}, nextCursors: {} }),
    });

    expect(MAX_PUSH_PAGES_PER_CYCLE).toBeGreaterThanOrEqual(3);
    expect(sizes).toEqual([500, 500, 30]);
    expect(getState()).toMatchObject({
      pendingPush: 0,
      pendingByTable: expect.objectContaining({ pedidos: 0 }),
      caughtUp: true,
    });
  });

  it('orçamento encerra saudável sem anunciar backlog zero, independente da ordem', async () => {
    seedPedidos(530);
    let now = 0;
    let pedidoPages = 0;

    const result = await syncOnce({
      db,
      apiBase,
      deviceToken,
      maxPushPages: 10,
      pushBudgetMs: 100,
      nowFn: () => now,
      pushFn: async ({ rows }) => {
        if (rows.pedidos) {
          pedidoPages += 1;
          now = 101;
        }
        return { tables: rows };
      },
      pullFn: async () => ({ tables: {}, nextCursors: {} }),
    });

    expect(result.ok).toBe(true);
    expect(pedidoPages).toBe(1);
    expect(getState()).toMatchObject({
      lastSyncOk: true,
      pendingPush: 30,
      pendingByTable: expect.objectContaining({ pedidos: 30 }),
      caughtUp: false,
    });
  });

  it('rotaciona tabelas entre ciclos quando o tempo acaba e evita starvation', async () => {
    for (let i = 0; i < 1000; i += 1) {
      db.seed('clientes', {
        id: `c${String(i).padStart(4, '0')}`,
        updated_at: '2026-07-14T11:30:00.000Z',
      });
    }
    db.seed('pedidos', {
      id: 'p0000',
      updated_at: '2026-07-14T11:30:00.000Z',
    });
    const pushedTables = [];
    let now = 0;
    const options = {
      db,
      apiBase,
      deviceToken,
      maxPushPages: 10,
      pushBudgetMs: 100,
      nowFn: () => now,
      pushFn: async ({ rows }) => {
        pushedTables.push(Object.keys(rows)[0]);
        now = 101;
        return { tables: rows };
      },
      pullFn: async () => ({ tables: {}, nextCursors: {} }),
    };

    await syncOnce(options);
    expect(await db.getCursor('clientes')).toMatchObject({ push_pk: 'c0499' });
    expect(await db.getCursor('pedidos')).toMatchObject({ push_pk: '' });

    now = 0;
    await syncOnce(options);

    expect(pushedTables).toEqual(['clientes', 'pedidos']);
    expect(await db.getCursor('clientes')).toMatchObject({ push_pk: 'c0499' });
    expect(await db.getCursor('pedidos')).toMatchObject({ push_pk: 'p0000' });
    expect(getState()).toMatchObject({
      pendingByTable: expect.objectContaining({ clientes: 500, pedidos: 0 }),
      pendingPush: 500,
      caughtUp: false,
    });
  });

  it('rejeita adapter legado sem countChanged antes de publicar backlog falso', async () => {
    db.seed('clientes', {
      id: 'c1',
      updated_at: '2026-07-14T11:45:00.000Z',
    });
    const tupleSelect = db.selectChanged.bind(db);
    db.selectChanged = async (table, cursor, limit) => (
      tupleSelect(table, 'id', { at: cursor, pk: '' }, limit)
    );
    db.countChanged = undefined;
    const pushFn = vi.fn(async ({ rows }) => ({ tables: rows }));

    const result = await syncOnce({
      db,
      apiBase,
      deviceToken,
      pushFn,
      pullFn: async () => ({ tables: {}, nextCursors: {} }),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('keyset');
    expect(pushFn).not.toHaveBeenCalled();
    expect(getState()).toMatchObject({
      lastSyncOk: false,
      caughtUp: false,
      lastError: 'Falha no ciclo de sincronizacao',
    });
  });

  it('falha fechado quando countChanged devolve valor invalido', async () => {
    const originalCountChanged = db.countChanged.bind(db);
    db.countChanged = async (table, pk, cursor) => (
      table === 'pedidos' ? undefined : originalCountChanged(table, pk, cursor)
    );

    const result = await syncOnce({
      db,
      apiBase,
      deviceToken,
      pushFn: async ({ rows }) => ({ tables: rows }),
      pullFn: async () => ({ tables: {}, nextCursors: {} }),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('countChanged invalid');
    expect(getState()).toMatchObject({
      lastSyncOk: false,
      caughtUp: false,
      lastError: 'Falha no ciclo de sincronizacao',
    });
  });

  it('rejeita cursor keyset com push_pk ausente ou indefinido', async () => {
    const originalGetCursor = db.getCursor.bind(db);
    db.getCursor = async (table) => {
      const cursor = await originalGetCursor(table);
      return table === 'pedidos' ? { ...cursor, push_pk: undefined } : cursor;
    };
    const pushFn = vi.fn(async ({ rows }) => ({ tables: rows }));

    const result = await syncOnce({
      db,
      apiBase,
      deviceToken,
      pushFn,
      pullFn: async () => ({ tables: {}, nextCursors: {} }),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('keyset cursor');
    expect(pushFn).not.toHaveBeenCalled();
    expect(getState()).toMatchObject({ lastSyncOk: false, caughtUp: false });
  });

  it('rejeita data keyset que o Date normalizaria para outro dia', async () => {
    const originalGetCursor = db.getCursor.bind(db);
    db.getCursor = async (table) => {
      const cursor = await originalGetCursor(table);
      return table === 'pedidos'
        ? { ...cursor, push_at: '2026-02-30T00:00:00.000Z' }
        : cursor;
    };

    const result = await syncOnce({
      db,
      apiBase,
      deviceToken,
      pushFn: async ({ rows }) => ({ tables: rows }),
      pullFn: async () => ({ tables: {}, nextCursors: {} }),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('keyset cursor');
    expect(getState()).toMatchObject({ lastSyncOk: false, caughtUp: false });
  });

  it('keyset não perde 30 linhas quando 530 updated_at são iguais', async () => {
    const timestamp = '2026-07-14T12:00:00.000Z';
    seedPedidos(530, () => timestamp);
    const sizes = [];

    await syncOnce({
      db,
      apiBase,
      deviceToken,
      pushFn: async ({ rows }) => {
        sizes.push(rows.pedidos.length);
        return { tables: rows };
      },
      pullFn: async () => ({ tables: {}, nextCursors: {} }),
    });

    expect(sizes).toEqual([500, 30]);
    expect(await db.getCursor('pedidos')).toMatchObject({
      push_at: timestamp,
      push_pk: 'p0529',
    });
    expect(getState()).toMatchObject({ pendingPush: 0, caughtUp: true });
  });

  it('falha no upsert canônico preserva a tupla do último lote confirmado', async () => {
    await db.setCursor('pedidos', {
      push_at: '2026-07-14T11:00:00.000Z',
      push_pk: 'p0001',
    });
    db.seed('pedidos', { id: 'p0002', updated_at: '2026-07-14T12:00:00.000Z' });
    const originalUpsert = db.upsert;
    db.upsert = async (table, pk, row) => {
      if (table === 'pedidos') throw new Error('canonical payload private@example.com');
      return originalUpsert(table, pk, row);
    };

    const result = await syncOnce({
      db,
      apiBase,
      deviceToken,
      pushFn: async ({ rows }) => ({ tables: rows }),
      pullFn: async () => ({ tables: {}, nextCursors: {} }),
    });

    expect(result.ok).toBe(false);
    expect(await db.getCursor('pedidos')).toMatchObject({
      push_at: '2026-07-14T11:00:00.000Z',
      push_pk: 'p0001',
    });
    expect(getState().lastError).not.toContain('private@example.com');
  });

  it('falha no segundo upsert reverte a primeira canônica e preserva o cursor', async () => {
    db.seed('clientes', {
      id: 'c1',
      nome: 'Ana-local',
      updated_at: '2026-07-14T12:00:00.000Z',
    });
    db.seed('clientes', {
      id: 'c2',
      nome: 'Bia-local',
      updated_at: '2026-07-14T12:01:00.000Z',
    });
    const originalUpsert = db.upsert;
    let canonicalWrites = 0;
    db.upsert = async (table, pk, row) => {
      if (table === 'clientes' && ++canonicalWrites === 2) {
        throw new Error('segunda canônica inválida');
      }
      return originalUpsert(table, pk, row);
    };

    const result = await syncOnce({
      db,
      apiBase,
      deviceToken,
      pushFn: async ({ rows }) => ({
        tables: {
          clientes: rows.clientes.map((row) => ({
            ...row,
            nome: row.id === 'c1' ? 'Ana-cloud' : 'Bia-cloud',
          })),
        },
      }),
      pullFn: async () => ({ tables: {}, nextCursors: {} }),
    });

    expect(result.ok).toBe(false);
    expect(db.get('clientes', 'c1').nome).toBe('Ana-local');
    expect(db.get('clientes', 'c2').nome).toBe('Bia-local');
    expect(await db.getCursor('clientes')).toMatchObject({
      push_at: '1970-01-01T00:00:00Z',
      push_pk: '',
    });
  });

  it('falha ao gravar cursor reverte a canônica e preserva a tupla anterior', async () => {
    await db.setCursor('pedidos', {
      push_at: '2026-07-14T11:00:00.000Z',
      push_pk: 'p0001',
    });
    db.seed('pedidos', {
      id: 'p0002',
      status: 'local',
      updated_at: '2026-07-14T12:00:00.000Z',
    });
    const originalSetCursor = db.setCursor;
    db.setCursor = async (table, patch) => {
      if (table === 'pedidos' && patch.push_pk) throw new Error('cursor SQL /private/path');
      return originalSetCursor(table, patch);
    };

    const result = await syncOnce({
      db,
      apiBase,
      deviceToken,
      pushFn: async ({ rows }) => ({
        tables: {
          pedidos: rows.pedidos.map((row) => ({ ...row, status: 'cloud' })),
        },
      }),
      pullFn: async () => ({ tables: {}, nextCursors: {} }),
    });

    expect(result.ok).toBe(false);
    expect(await db.getCursor('pedidos')).toMatchObject({
      push_at: '2026-07-14T11:00:00.000Z',
      push_pk: 'p0001',
    });
    expect(db.get('pedidos', 'p0002').status).toBe('local');
  });

  it('falha da contagem exata não expõe SQL nem anuncia caught up', async () => {
    const originalCountChanged = db.countChanged;
    db.countChanged = async (table, pk, cursor) => {
      if (table === 'pedidos') {
        throw new Error('select * from C:\\private\\payload.sql token=secret@example.com');
      }
      return originalCountChanged.call(db, table, pk, cursor);
    };

    const result = await syncOnce({
      db,
      apiBase,
      deviceToken,
      pushFn: async ({ rows }) => ({ tables: rows }),
      pullFn: async () => ({ tables: {}, nextCursors: {} }),
    });

    expect(result.ok).toBe(false);
    expect(getState()).toMatchObject({
      lastSyncOk: false,
      caughtUp: false,
      lastError: 'Falha no ciclo de sincronizacao',
    });
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
    expect(st.lastError).toBe('Falha no ciclo de sincronizacao');
  });
});

describe('syncOnce — single-flight', () => {
  it('coalesce chamada concorrente e só permite novo estado/cursor após a ativa concluir', async () => {
    const firstDb = makeMemDb();
    const secondDb = makeMemDb();
    firstDb.seed('pedidos', { id: 'p1', updated_at: '2026-07-14T10:00:00.000Z' });
    secondDb.seed('pedidos', { id: 'p2', updated_at: '2026-07-14T11:00:00.000Z' });
    const entered = deferred();
    const release = deferred();
    const firstPush = vi.fn(async ({ rows }) => {
      entered.resolve();
      await release.promise;
      return { tables: rows };
    });
    const secondPush = vi.fn(async ({ rows }) => ({ tables: rows }));
    const pullFn = async () => ({ tables: {}, nextCursors: {} });

    const first = syncOnce({
      db: firstDb,
      apiBase,
      deviceToken,
      pushFn: firstPush,
      pullFn,
    });
    await entered.promise;
    expect(getState()).toMatchObject({ phase: 'pushing' });
    expect(getState().runningSince).toEqual(expect.any(String));
    const coalesced = syncOnce({
      db: secondDb,
      apiBase,
      deviceToken,
      pushFn: secondPush,
      pullFn,
    });

    expect(firstPush).toHaveBeenCalledOnce();
    expect(secondPush).not.toHaveBeenCalled();
    release.resolve();
    const [firstResult, coalescedResult] = await Promise.all([first, coalesced]);
    expect(coalescedResult).toEqual(firstResult);
    expect((await secondDb.getCursor('pedidos')).push_pk).toBe('');

    const next = await syncOnce({
      db: secondDb,
      apiBase,
      deviceToken,
      pushFn: secondPush,
      pullFn,
    });
    expect(next.ok).toBe(true);
    expect(secondPush).toHaveBeenCalledOnce();
    expect(await secondDb.getCursor('pedidos')).toMatchObject({
      push_at: '2026-07-14T11:00:00.000Z',
      push_pk: 'p2',
    });
  });
});

describe('syncOnce — paginação / cold start', () => {
  let db;
  beforeEach(() => {
    db = makeMemDb();
  });

  it('aplica tabelas two-way por pagina atomica quando o banco oferece o contrato', async () => {
    const applyPulledPage = vi.fn(async (table, pk, rows, cursor) => {
      for (const row of rows) await db.upsert(table, pk, row);
      await db.setCursor(table, cursor);
    });
    db.applyPulledPage = applyPulledPage;
    const row = { id: 'c-batch', nome: 'Lote', updated_at: '2026-01-01T00:00:00Z' };

    const result = await syncOnce({
      db,
      apiBase,
      deviceToken,
      pushFn: async () => ({ tables: {} }),
      pullFn: async () => ({
        tables: { clientes: [row] },
        nextCursors: { clientes: row.updated_at, 'clientes.__pk': row.id },
      }),
    });

    expect(result.ok).toBe(true);
    expect(applyPulledPage).toHaveBeenCalledOnce();
    expect(applyPulledPage).toHaveBeenCalledWith(
      'clientes',
      'id',
      [row],
      { pull_at: row.updated_at, pull_pk: row.id },
    );
  });

  it('faz fallback linha a linha quando a pagina atomica falha inteira', async () => {
    db.applyPulledPage = vi.fn().mockRejectedValueOnce(new Error('batch indisponivel'));
    const row = { id: 'c-fallback', nome: 'Fallback', updated_at: '2026-01-01T00:00:00Z' };

    const result = await syncOnce({
      db,
      apiBase,
      deviceToken,
      pushFn: async () => ({ tables: {} }),
      pullFn: async () => ({
        tables: { clientes: [row] },
        nextCursors: { clientes: row.updated_at, 'clientes.__pk': row.id },
      }),
    });

    expect(result.ok).toBe(true);
    expect(db.get('clientes', row.id)).toEqual(row);
    expect(await db.getCursor('clientes')).toMatchObject({
      pull_at: row.updated_at,
      pull_pk: row.id,
    });
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

  it('aplica auth_users e avança cursor próprio auth.users', async () => {
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

describe('syncOnce — reconciliação de identidade local', () => {
  const oldId = '00000000-0000-0000-0000-000000000111';
  const canonicalId = '00000000-0000-0000-0000-000000000222';
  let db;

  beforeEach(() => {
    db = makeMemDb();
  });

  function seedIdentityReferences() {
    db.seed('auth.users', { id: oldId, email: ' EDUARDO@FRANZONI.LOCAL ' });
    db.seed('profiles', { id: oldId, nome: 'Eduardo local' });
    for (const ref of IDENTITY_REFERENCES) {
      db.seed(ref.table, {
        id: `${ref.table}-1`,
        [ref.column]: oldId,
        updated_at: '2026-07-01T00:00:00Z',
      });
    }
  }

  function identityPullPayload() {
    return {
      auth_users: [
        {
          id: canonicalId,
          email: 'eduardo@franzoni.local',
          updated_at: '2026-07-14T10:00:00Z',
        },
      ],
      tables: {
        profiles: [
          {
            id: canonicalId,
            empresa_id: 'E1',
            updated_at: '2026-07-14T10:00:00Z',
          },
        ],
      },
      nextCursors: {
        'auth.users': '2026-07-14T10:00:00Z',
        profiles: '2026-07-14T10:00:00Z',
      },
    };
  }

  it('cold start reconcilia identidade antes do primeiro payload sem alias preexistente', async () => {
    seedIdentityReferences();
    expect(db.identityAlias(oldId)).toBeUndefined();
    const events = [];
    const pushedPedidos = [];

    const result = await syncOnce({
      db,
      apiBase,
      deviceToken,
      pullFn: async ({ identityOnly }) => {
        events.push(identityOnly ? 'identity-pull' : 'full-pull');
        return identityOnly
          ? { ...identityPullPayload(), identityOnly: true }
          : { auth_users: [], tables: {}, nextCursors: {} };
      },
      pushFn: async ({ rows }) => {
        events.push('push');
        if (rows.pedidos) pushedPedidos.push(...rows.pedidos.map((row) => ({ ...row })));
        return { tables: rows };
      },
    });

    expect(result.ok).toBe(true);
    expect(events[0]).toBe('identity-pull');
    expect(events.indexOf('identity-pull')).toBeLessThan(events.indexOf('push'));
    expect(pushedPedidos).toHaveLength(1);
    expect(pushedPedidos[0].vendedor_id).toBe(canonicalId);
    expect(db.identityAlias(oldId)?.resolved_at).toBeTruthy();
  });

  it('falha no preflight de identidade bloqueia qualquer push', async () => {
    db.seed('pedidos', {
      id: 'pedido-bloqueado-preflight',
      vendedor_id: oldId,
      updated_at: '2026-07-14T11:00:00Z',
    });
    const pushFn = vi.fn(async ({ rows }) => ({ tables: rows }));

    const result = await syncOnce({
      db,
      apiBase,
      deviceToken,
      pullFn: async ({ identityOnly }) => {
        if (identityOnly) throw new Error('cloud de identidade indisponível');
        return { auth_users: [], tables: {}, nextCursors: {} };
      },
      pushFn,
    });

    expect(result.ok).toBe(false);
    expect(pushFn).not.toHaveBeenCalled();
    expect((await db.getCursor('pedidos')).push_at).toBe('1970-01-01T00:00:00Z');
  });

  it('profile canônico ausente mantém pendência e bloqueia push', async () => {
    db.seed('auth.users', { id: oldId, email: ' EDUARDO@FRANZONI.LOCAL ' });
    db.seed('profiles', { id: oldId, nome: 'Eduardo local' });
    db.seed('pedidos', {
      id: 'pedido-identidade-incompleta',
      vendedor_id: oldId,
      updated_at: '2026-07-14T11:00:00Z',
    });
    const pushFn = vi.fn(async ({ rows }) => ({ tables: rows }));

    const result = await syncOnce({
      db,
      apiBase,
      deviceToken,
      pullFn: async ({ identityOnly }) => (
        identityOnly
          ? {
              identityOnly: true,
              auth_users: identityPullPayload().auth_users,
              tables: { profiles: [] },
              nextCursors: identityPullPayload().nextCursors,
            }
          : { auth_users: [], tables: {}, nextCursors: {} }
      ),
      pushFn,
    });

    expect(result.ok).toBe(false);
    expect(pushFn).not.toHaveBeenCalled();
    expect(db.identityAlias(oldId)).toMatchObject({
      canonical_user_id: canonicalId,
      canonical_profile_applied_at: null,
      resolved_at: null,
    });
  });

  it('recupera profile canônico anterior ao cursor legado sem regredir o cursor persistido', async () => {
    const legacyProfileCursor = '2026-07-14T11:00:00Z';
    db.seed('auth.users', { id: oldId, email: ' EDUARDO@FRANZONI.LOCAL ' });
    db.seed('profiles', { id: oldId, nome: 'Eduardo local' });
    db.seed('pedidos', {
      id: 'pedido-cursor-legado',
      vendedor_id: oldId,
      updated_at: '2026-07-14T12:00:00Z',
    });
    await db.setCursor('profiles', {
      pull_at: legacyProfileCursor,
      pull_pk: 'profile-posterior',
    });
    const identityProfileCursors = [];
    const pushFn = vi.fn(async ({ rows }) => ({ tables: rows }));

    const result = await syncOnce({
      db,
      apiBase,
      deviceToken,
      pullFn: async ({ cursors, identityOnly }) => {
        if (!identityOnly) return { auth_users: [], tables: {}, nextCursors: {} };
        identityProfileCursors.push({
          at: cursors.profiles,
          pk: cursors['profiles.__pk'],
        });
        if (cursors.profiles === legacyProfileCursor) {
          return {
            identityOnly: true,
            auth_users: identityPullPayload().auth_users,
            tables: { profiles: [] },
            nextCursors: {
              'auth.users': '2026-07-14T10:00:00Z',
              'auth.users.__pk': canonicalId,
              profiles: legacyProfileCursor,
              'profiles.__pk': 'profile-posterior',
            },
          };
        }
        return {
          identityOnly: true,
          auth_users: [],
          tables: { profiles: identityPullPayload().tables.profiles },
          nextCursors: {
            profiles: '2026-07-14T10:00:00Z',
            'profiles.__pk': canonicalId,
          },
        };
      },
      pushFn,
    });

    expect(result.ok).toBe(true);
    expect(identityProfileCursors).toEqual([
      { at: legacyProfileCursor, pk: 'profile-posterior' },
      { at: '0001-01-01T00:00:00Z', pk: '' },
    ]);
    expect(pushFn).toHaveBeenCalled();
    expect(db.get('pedidos', 'pedido-cursor-legado').vendedor_id).toBe(canonicalId);
    expect(db.identityAlias(oldId)?.resolved_at).toBeTruthy();
    expect(await db.getCursor('profiles')).toMatchObject({
      pull_at: legacyProfileCursor,
      pull_pk: 'profile-posterior',
    });
  });

  it.each([
    [
      'regressivo',
      [
        { at: '2026-07-02T10:00:00.000Z', pk: 'z' },
        { at: '2026-07-01T10:00:00.000Z', pk: 'a' },
      ],
    ],
    [
      'alternante',
      [
        { at: '2026-07-01T10:00:00.000Z', pk: 'a' },
        { at: '2026-07-02T10:00:00.000Z', pk: 'b' },
        { at: '2026-07-01T10:00:00.000Z', pk: 'a' },
      ],
    ],
  ])('rejeita cursor temporário %s na recuperação de profiles', async (_label, nextCursors) => {
    const legacyProfileCursor = '2026-07-14T11:00:00Z';
    db.seed('auth.users', { id: oldId, email: ' EDUARDO@FRANZONI.LOCAL ' });
    db.seed('profiles', { id: oldId, nome: 'Eduardo local' });
    db.seed('pedidos', {
      id: 'pedido-cursor-invalido',
      vendedor_id: oldId,
      updated_at: '2026-07-14T12:00:00Z',
    });
    await db.setCursor('profiles', {
      pull_at: legacyProfileCursor,
      pull_pk: 'profile-posterior',
    });
    let recoveryPage = 0;
    const pushFn = vi.fn(async ({ rows }) => ({ tables: rows }));

    const result = await syncOnce({
      db,
      apiBase,
      deviceToken,
      pullFn: async ({ cursors, identityOnly }) => {
        if (!identityOnly) return { auth_users: [], tables: {}, nextCursors: {} };
        if (cursors.profiles === legacyProfileCursor) {
          return {
            identityOnly: true,
            auth_users: identityPullPayload().auth_users,
            tables: { profiles: [] },
            nextCursors: {
              'auth.users': '2026-07-14T10:00:00Z',
              'auth.users.__pk': canonicalId,
              profiles: legacyProfileCursor,
              'profiles.__pk': 'profile-posterior',
            },
          };
        }
        const next = nextCursors[recoveryPage++];
        if (next) {
          const fullPage = [
            ...Array.from({ length: 499 }, (_, index) => ({
              id: `0-${String(index).padStart(3, '0')}`,
              empresa_id: 'E1',
              updated_at: next.at,
            })),
            { id: next.pk, empresa_id: 'E1', updated_at: next.at },
          ];
          return {
            identityOnly: true,
            auth_users: [],
            tables: { profiles: fullPage },
            nextCursors: {
              profiles: next.at,
              'profiles.__pk': next.pk,
            },
          };
        }
        return {
          identityOnly: true,
          auth_users: [],
          tables: { profiles: identityPullPayload().tables.profiles },
          nextCursors: identityPullPayload().nextCursors,
        };
      },
      pushFn,
    });

    expect(result.ok).toBe(false);
    expect(pushFn).not.toHaveBeenCalled();
    expect(db.identityAlias(oldId)).toMatchObject({
      canonical_user_id: canonicalId,
      canonical_profile_applied_at: null,
      resolved_at: null,
    });
    expect(await db.getCursor('profiles')).toMatchObject({
      pull_at: legacyProfileCursor,
      pull_pk: 'profile-posterior',
    });
  });

  it.each([
    ['ausente', {}],
    ['sem PK', { profiles: '2026-07-01T10:00:00.000Z' }],
    [
      'divergente da última linha',
      {
        profiles: '2026-07-01T10:00:00.000Z',
        'profiles.__pk': 'z-divergente',
      },
    ],
  ])('rejeita cursor de recuperação %s em página cheia', async (_label, suppliedCursor) => {
    const legacyProfileCursor = '2026-07-14T11:00:00Z';
    const pageTimestamp = '2026-07-01T10:00:00.000Z';
    db.seed('auth.users', { id: oldId, email: ' EDUARDO@FRANZONI.LOCAL ' });
    db.seed('profiles', { id: oldId, nome: 'Eduardo local' });
    db.seed('pedidos', {
      id: 'pedido-cursor-incompleto',
      vendedor_id: oldId,
      updated_at: '2026-07-14T12:00:00Z',
    });
    await db.setCursor('profiles', {
      pull_at: legacyProfileCursor,
      pull_pk: 'profile-posterior',
    });
    const fullPage = Array.from({ length: 500 }, (_, index) => ({
      id: `p${String(index).padStart(4, '0')}`,
      empresa_id: 'E1',
      updated_at: pageTimestamp,
    }));
    let recoveryPage = 0;
    const pushFn = vi.fn(async ({ rows }) => ({ tables: rows }));

    const result = await syncOnce({
      db,
      apiBase,
      deviceToken,
      pullFn: async ({ cursors, identityOnly }) => {
        if (!identityOnly) return { auth_users: [], tables: {}, nextCursors: {} };
        if (cursors.profiles === legacyProfileCursor) {
          return {
            identityOnly: true,
            auth_users: identityPullPayload().auth_users,
            tables: { profiles: [] },
            nextCursors: {
              'auth.users': '2026-07-14T10:00:00Z',
              'auth.users.__pk': canonicalId,
              profiles: legacyProfileCursor,
              'profiles.__pk': 'profile-posterior',
            },
          };
        }
        if (recoveryPage++ === 0) {
          return {
            identityOnly: true,
            auth_users: [],
            tables: { profiles: fullPage },
            nextCursors: suppliedCursor,
          };
        }
        return {
          identityOnly: true,
          auth_users: [],
          tables: { profiles: identityPullPayload().tables.profiles },
          nextCursors: identityPullPayload().nextCursors,
        };
      },
      pushFn,
    });

    expect(result.ok).toBe(false);
    expect(pushFn).not.toHaveBeenCalled();
    expect(db.identityAlias(oldId)).toMatchObject({
      canonical_user_id: canonicalId,
      canonical_profile_applied_at: null,
      resolved_at: null,
    });
    expect(await db.getCursor('profiles')).toMatchObject({
      pull_at: legacyProfileCursor,
      pull_pk: 'profile-posterior',
    });
  });

  it.each([
    [
      'PK regressiva no mesmo timestamp',
      { at: '2026-07-14T12:00:00.000Z', pk: 'z' },
      { at: '2026-07-14T12:00:00.000Z', pk: 'a' },
    ],
    [
      'timestamp regressivo',
      { at: '2026-07-14T12:00:00.000Z', pk: 'z' },
      { at: '2026-07-14T11:59:59.999Z', pk: 'a' },
    ],
  ])('preflight normal rejeita %s antes de persistir', async (_label, current, next) => {
    await db.setCursor('profiles', {
      pull_at: current.at,
      pull_pk: current.pk,
    });
    const originalSetCursor = db.setCursor.bind(db);
    const profileCursorWrites = [];
    db.setCursor = async (table, patch) => {
      if (table === 'profiles') profileCursorWrites.push(patch);
      return originalSetCursor(table, patch);
    };

    const result = await syncOnce({
      db,
      apiBase,
      deviceToken,
      pullFn: async ({ identityOnly }) => (
        identityOnly
          ? {
              identityOnly: true,
              auth_users: [],
              tables: {
                profiles: [
                  { id: next.pk, empresa_id: 'E1', updated_at: next.at },
                ],
              },
              nextCursors: {
                profiles: next.at,
                'profiles.__pk': next.pk,
              },
            }
          : { auth_users: [], tables: {}, nextCursors: {} }
      ),
      pushFn: vi.fn(async ({ rows }) => ({ tables: rows })),
    });

    expect(result.ok).toBe(false);
    expect(profileCursorWrites).toEqual([]);
    expect(db.get('profiles', next.pk)).toBeUndefined();
    expect(await db.getCursor('profiles')).toMatchObject({
      pull_at: current.at,
      pull_pk: current.pk,
    });
  });

  it('preflight só avança cursor de profiles após aplicar a página inteira', async () => {
    const originalUpsert = db.upsert;
    db.upsert = async (table, pk, row) => {
      if (table === 'profiles' && row.id === 'u2') throw new Error('profile inválido');
      return originalUpsert(table, pk, row);
    };
    const pushFn = vi.fn(async ({ rows }) => ({ tables: rows }));

    const result = await syncOnce({
      db,
      apiBase,
      deviceToken,
      pullFn: async ({ identityOnly }) => (
        identityOnly
          ? {
              identityOnly: true,
              auth_users: [],
              tables: {
                profiles: [
                  { id: 'u1', empresa_id: 'E1', updated_at: '2026-07-14T12:00:00Z' },
                  { id: 'u2', empresa_id: 'E1', updated_at: '2026-07-14T12:00:00Z' },
                ],
              },
              nextCursors: {
                profiles: '2026-07-14T12:00:00Z',
                'profiles.__pk': 'u2',
              },
            }
          : { auth_users: [], tables: {}, nextCursors: {} }
      ),
      pushFn,
    });

    expect(result.ok).toBe(false);
    expect(db.get('profiles', 'u1')).toBeTruthy();
    expect(db.get('profiles', 'u2')).toBeUndefined();
    expect(await db.getCursor('profiles')).toMatchObject({
      pull_at: '1970-01-01T00:00:00Z',
      pull_pk: '',
    });
    expect(pushFn).not.toHaveBeenCalled();
  });

  it('preflight drena 530 auth.users e profiles com timestamp igual via keyset', async () => {
    const timestamp = '2026-07-14T12:00:00.123456Z';
    const profiles = Array.from({ length: 530 }, (_, index) => ({
      id: `u${String(index).padStart(4, '0')}`,
      empresa_id: 'E1',
      updated_at: timestamp,
    }));
    const authUsers = profiles.map((profile) => ({
      id: profile.id,
      email: `${profile.id}@example.test`,
      updated_at: timestamp,
    }));
    const identityCursors = [];

    const result = await syncOnce({
      db,
      apiBase,
      deviceToken,
      pullFn: async ({ cursors, identityOnly }) => {
        if (!identityOnly) return { auth_users: [], tables: {}, nextCursors: {} };
        identityCursors.push({
          auth: cursors['auth.users.__pk'],
          profiles: cursors['profiles.__pk'],
        });
        const start = cursors['profiles.__pk'] === '' ? 0 : 500;
        const end = start === 0 ? 500 : 530;
        return {
          identityOnly: true,
          auth_users: authUsers.slice(start, end),
          tables: { profiles: profiles.slice(start, end) },
          nextCursors: {
            'auth.users': timestamp,
            'auth.users.__pk': authUsers[end - 1].id,
            profiles: timestamp,
            'profiles.__pk': profiles[end - 1].id,
          },
        };
      },
      pushFn: async ({ rows }) => ({ tables: rows }),
    });

    expect(result.ok).toBe(true);
    expect(identityCursors).toEqual([
      { auth: '', profiles: '' },
      { auth: 'u0499', profiles: 'u0499' },
    ]);
    expect(db.count('auth.users')).toBe(530);
    expect(db.count('profiles')).toBe(530);
    expect(await db.getCursor('auth.users')).toMatchObject({
      pull_at: timestamp,
      pull_pk: 'u0529',
    });
    expect(await db.getCursor('profiles')).toMatchObject({
      pull_at: timestamp,
      pull_pk: 'u0529',
    });
  });

  it('não resolve alias quando só existe o profile placeholder do trigger', async () => {
    db.seed('auth.users', { id: oldId, email: ' EDUARDO@FRANZONI.LOCAL ' });
    db.seed('profiles', { id: canonicalId, nome: null, trigger_placeholder: true });

    const result = await syncOnce({
      db,
      apiBase,
      deviceToken,
      pushFn: async () => ({ tables: {} }),
      pullFn: async () => ({
        auth_users: [
          {
            id: canonicalId,
            email: 'eduardo@franzoni.local',
            updated_at: '2026-07-14T10:00:00Z',
          },
        ],
        tables: {},
        nextCursors: { 'auth.users': '2026-07-14T10:00:00Z' },
      }),
    });

    expect(result.ok).toBe(false);
    expect(db.identityAlias(oldId)).toMatchObject({
      canonical_user_id: canonicalId,
      canonical_profile_applied_at: null,
      resolved_at: null,
    });
    expect(db.get('auth.users', oldId)).toBeTruthy();
  });

  it('conflito de e-mail migra as seis referências para o UUID canônico', async () => {
    seedIdentityReferences();

    const result = await syncOnce({
      db,
      apiBase,
      deviceToken,
      pushFn: async ({ rows }) => ({ tables: rows }),
      pullFn: async () => identityPullPayload(),
    });

    expect(result.ok).toBe(true);
    expect(db.identityAlias(oldId)).toMatchObject({
      canonical_user_id: canonicalId,
      canonical_profile_applied_at: '2026-07-14T10:00:00Z',
      resolved_at: '2026-07-14T10:00:01Z',
    });
    for (const ref of IDENTITY_REFERENCES) {
      expect(db.get(ref.table, `${ref.table}-1`)[ref.column]).toBe(canonicalId);
    }
    expect(db.get('profiles', oldId)).toBeUndefined();
    expect(db.get('auth.users', oldId)).toBeUndefined();
  });

  it('migra o UUID antes do payload mesmo se a resposta canônica nulificar vendedor', async () => {
    db.seed('auth.users', { id: oldId, email: ' EDUARDO@FRANZONI.LOCAL ' });
    db.seed('profiles', { id: oldId, nome: 'Eduardo local' });
    await db.aliasAndUpsertAuthUser({
      oldUserId: oldId,
      canonicalUser: { id: canonicalId, email: 'eduardo@franzoni.local' },
      normalizedEmail: 'eduardo@franzoni.local',
      aliasEmail: `exped-alias+${oldId}@invalid.local`,
    });
    db.seed('profiles', { id: canonicalId, empresa_id: 'E1' });
    await db.markCanonicalProfileApplied(canonicalId);
    db.seed('pedidos', {
      id: 'pedido-identidade-pendente',
      vendedor_id: oldId,
      updated_at: '2026-07-14T11:00:00Z',
    });

    const observed = [];
    await syncOnce({
      db,
      apiBase,
      deviceToken,
      pushFn: async ({ rows }) => {
        if (rows.pedidos) {
          observed.push({
            vendedorId: rows.pedidos[0].vendedor_id,
            aliasResolvido: Boolean(db.identityAlias(oldId)?.resolved_at),
          });
          return {
            tables: {
              pedidos: rows.pedidos.map((row) => ({ ...row, vendedor_id: null })),
            },
          };
        }
        return { tables: rows };
      },
      pullFn: async () => ({ auth_users: [], tables: {}, nextCursors: {} }),
    });

    expect(observed).toEqual([
      { vendedorId: canonicalId, aliasResolvido: true },
    ]);
  });

  it('drena 530 linhas propagadas por identidade com o mesmo updated_at sem perda', async () => {
    const before = '2026-07-14T09:00:00.000Z';
    const propagatedAt = '2026-07-14T12:00:00.000Z';
    db.seed('auth.users', { id: oldId, email: ' EDUARDO@FRANZONI.LOCAL ' });
    db.seed('profiles', { id: oldId, nome: 'Eduardo local' });
    for (let i = 0; i < 530; i += 1) {
      db.seed('pedidos', {
        id: `p${String(i).padStart(4, '0')}`,
        vendedor_id: oldId,
        updated_at: before,
      });
    }
    await db.setCursor('pedidos', { push_at: before, push_pk: 'p0529' });
    db.setIdentityPropagationAt(propagatedAt);
    let pulls = 0;
    const pushedPages = [];
    const options = {
      db,
      apiBase,
      deviceToken,
      pushFn: async ({ rows }) => {
        if (rows.pedidos) pushedPages.push(rows.pedidos.map((row) => ({ ...row })));
        return { tables: rows };
      },
      pullFn: async () => {
        pulls += 1;
        return pulls === 1
          ? identityPullPayload()
          : { auth_users: [], tables: {}, nextCursors: {} };
      },
    };

    const drained = await syncOnce(options);

    expect(drained.ok).toBe(true);
    expect(pushedPages.map((page) => page.length)).toEqual([500, 30]);
    expect(pushedPages.flat()).toHaveLength(530);
    expect(new Set(pushedPages.flat().map((row) => row.id)).size).toBe(530);
    expect(pushedPages.flat().every((row) => (
      row.vendedor_id === canonicalId && row.updated_at === propagatedAt
    ))).toBe(true);
    expect(await db.getCursor('pedidos')).toMatchObject({
      push_at: propagatedAt,
      push_pk: 'p0529',
    });
    expect(getState()).toMatchObject({ pendingPush: 0, caughtUp: true });
  });

  it('persiste o marcador e retoma após falha transacional de reconciliação', async () => {
    seedIdentityReferences();
    db.failNextIdentityTransaction(new Error('FK simulada'));
    let pulls = 0;
    const pullFn = async () => {
      pulls += 1;
      return pulls === 1
        ? identityPullPayload()
        : { auth_users: [], tables: {}, nextCursors: {} };
    };
    const options = {
      db,
      apiBase,
      deviceToken,
      pushFn: async ({ rows }) => ({ tables: rows }),
      pullFn,
    };

    const failed = await syncOnce(options);

    expect(failed.ok).toBe(false);
    expect(db.identityAlias(oldId)).toMatchObject({
      canonical_profile_applied_at: '2026-07-14T10:00:00Z',
      resolved_at: null,
      last_error: 'FK simulada',
    });
    for (const ref of IDENTITY_REFERENCES) {
      expect(db.get(ref.table, `${ref.table}-1`)[ref.column]).toBe(oldId);
    }

    const retried = await syncOnce(options);

    expect(retried.ok).toBe(true);
    for (const ref of IDENTITY_REFERENCES) {
      expect(db.get(ref.table, `${ref.table}-1`)[ref.column]).toBe(canonicalId);
    }
  });

  it('replay obsoleto após resolução e restart mantém o alias resolvido', async () => {
    seedIdentityReferences();
    await syncOnce({
      db,
      apiBase,
      deviceToken,
      pushFn: async ({ rows }) => ({ tables: rows }),
      pullFn: async () => identityPullPayload(),
    });
    const resolvedAlias = { ...db.identityAlias(oldId) };

    await db.aliasAndUpsertAuthUser({
      oldUserId: oldId,
      canonicalUser: {
        id: canonicalId,
        email: 'eduardo@franzoni.local',
        updated_at: '2026-07-14T10:00:00Z',
      },
      normalizedEmail: 'eduardo@franzoni.local',
      aliasEmail: `exped-alias+${oldId}@invalid.local`,
    });
    const restarted = await syncOnce({
      db,
      apiBase,
      deviceToken,
      pushFn: async ({ rows }) => ({ tables: rows }),
      pullFn: async () => ({ auth_users: [], tables: {}, nextCursors: {} }),
    });

    expect(restarted.ok).toBe(true);
    expect(db.identityAlias(oldId)).toMatchObject({
      canonical_profile_applied_at: resolvedAlias.canonical_profile_applied_at,
      resolved_at: resolvedAlias.resolved_at,
    });
    expect(await db.listPendingIdentityAliases()).toEqual([]);
  });

  it('reaponta autoria de provisioning sem ampliar as seis referências de sync', async () => {
    seedIdentityReferences();
    db.seed('provisioning_codes', { id: 'code-1', created_by: oldId });

    await syncOnce({
      db,
      apiBase,
      deviceToken,
      pushFn: async ({ rows }) => ({ tables: rows }),
      pullFn: async () => identityPullPayload(),
    });

    expect(db.get('provisioning_codes', 'code-1').created_by).toBe(canonicalId);
    expect(IDENTITY_REFERENCES).toHaveLength(6);
    expect(IDENTITY_REFERENCES).not.toContainEqual({
      table: 'provisioning_codes',
      column: 'created_by',
      propagate: false,
    });
  });
});

describe('sync-tables espelho', () => {
  it('tem 12 tabelas (8 two-way + 4 down)', () => {
    expect(SYNC_TABLES).toHaveLength(12);
    expect(TWO_WAY_TABLES).toHaveLength(8);
    expect(SYNC_TABLES.filter((t) => t.dir === 'down')).toHaveLength(4);
  });
});

describe('start — watchdog (incidente 2026-06-10)', () => {
  it('respeita Retry-After antes de iniciar outro ciclo', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-14T14:00:00.000Z'));
      const db = makeMemDb();
      db.seed('clientes', {
        id: 'c-retry',
        updated_at: '2026-07-14T13:59:00.000Z',
      });
      await syncOnce({
        db,
        apiBase,
        deviceToken,
        pushFn: async () => {
          const error = new Error('push HTTP 503');
          error.retryAfterMs = 30_000;
          throw error;
        },
        pullFn: async () => ({ tables: {}, nextCursors: {} }),
      });

      let calls = 0;
      const stop = start({
        db,
        apiBase,
        deviceToken,
        intervalMs: 1_000,
        syncOnceFn: async () => { calls += 1; },
      });

      expect(calls).toBe(0);
      await vi.advanceTimersByTimeAsync(29_000);
      expect(calls).toBe(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(calls).toBe(1);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejeição do controlador invalida sucesso anterior com estado sanitizado e atual', async () => {
    vi.useFakeTimers();
    try {
      const db = makeMemDb();
      vi.setSystemTime(new Date('2026-07-14T14:00:00.000Z'));
      await syncOnce({
        db,
        apiBase,
        deviceToken,
        pushFn: async ({ rows }) => ({ tables: rows }),
        pullFn: async () => ({ tables: {}, nextCursors: {} }),
      });
      const success = getState();
      expect(success).toMatchObject({
        lastSyncOk: true,
        caughtUp: true,
        lastSyncAt: '2026-07-14T14:00:00.000Z',
      });

      vi.setSystemTime(new Date('2026-07-14T14:01:00.000Z'));
      const cycle = deferred();
      const logger = { info: vi.fn(), error: vi.fn() };
      const failuresBefore = success.consecutiveFailures;
      const stop = start({
        db, apiBase, deviceToken,
        intervalMs: 1000,
        syncOnceFn: () => cycle.promise,
        log: logger,
      });

      expect(getState().runningSince).toEqual(expect.any(String));

      cycle.reject(new Error(
        "falha em '/srv/exped/private/arquivo' " +
        ['cabecalho-falso', 'payload-falso', 'assinatura-falsa']
          .map((part) => Buffer.from(part).toString('base64url'))
          .join('.'),
      ));
      await vi.advanceTimersByTimeAsync(0);

      expect(getState()).toMatchObject({
        lastSyncOk: false,
        lastError: 'Falha no ciclo de sincronizacao',
        lastSyncAt: '2026-07-14T14:01:00.000Z',
        lastSuccessAt: '2026-07-14T14:00:00.000Z',
        caughtUp: false,
        phase: 'error',
        runningSince: null,
        consecutiveFailures: failuresBefore + 1,
      });
      expect(logger.error).toHaveBeenCalledWith(
        'sync tick: Falha no ciclo de sincronizacao',
      );
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reporta ciclo travado sem sobrepor trabalho nem permitir conclusão obsoleta', async () => {
    vi.useFakeTimers();
    try {
      const cycles = [deferred(), deferred()];
      const logger = { info: vi.fn(), error: vi.fn() };
      const completions = [];
      let calls = 0;
      let active = 0;
      let maxActive = 0;
      let visibleCursor = null;
      const syncOnceFn = async () => {
        const call = calls;
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          await cycles[call].promise;
          visibleCursor = call === 0 ? 'primeiro' : 'segundo';
          completions.push(call);
          return { ok: true, error: null };
        } finally {
          active -= 1;
        }
      };
      const stop = start({
        db: makeMemDb(), apiBase, deviceToken,
        intervalMs: 10, stuckMs: 100, syncOnceFn, log: logger,
      });

      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(130);
      expect(calls).toBe(1);
      expect(maxActive).toBe(1);
      expect(logger.error).toHaveBeenCalledOnce();
      expect(logger.error.mock.calls[0][0]).toContain('ciclo travado');

      cycles[0].resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(completions).toEqual([0]);
      expect(visibleCursor).toBe('primeiro');

      await vi.advanceTimersByTimeAsync(10);
      expect(calls).toBe(2);
      expect(maxActive).toBe(1);
      cycles[1].resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(completions).toEqual([0, 1]);
      expect(visibleCursor).toBe('segundo');
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ciclo normal (rapido) roda repetidamente, sem pular nem travar', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const syncOnceFn = () => {
        calls += 1;
        return Promise.resolve({ ok: true, error: null });
      };
      const stop = start({
        db: makeMemDb(), apiBase, deviceToken,
        intervalMs: 10, stuckMs: 100, syncOnceFn,
      });
      expect(calls).toBe(1); // tick imediato
      await vi.advanceTimersByTimeAsync(35); // ticks em 10, 20, 30
      expect(calls).toBeGreaterThanOrEqual(4);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
