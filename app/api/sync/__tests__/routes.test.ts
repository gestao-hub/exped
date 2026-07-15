import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncSchemaUnavailableError } from '@/lib/sync/engine';

/**
 * Testes de rota: focam no comportamento HTTP (auth/escopo/status), com o SyncDb
 * injetado por um fake (a LÓGICA de pull/push é coberta por engine.test.ts com um
 * db em memória). Mockamos createAdminClient (sem env real) e makeSupabaseSyncDb.
 */

// --- fakes controláveis por teste ---
let deviceRow: { id: string; empresa_id: string; ativo: boolean } | null = null;
const fakeDb = {
  selectChanges: vi.fn(),
  findCanonical: vi.fn(),
  findCanonicalGlobal: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
  parentBelongsToEmpresa: vi.fn(),
  // Versões em lote: delegam aos mocks per-row acima (mantém os setups dos testes válidos).
  findCanonicalMany: vi.fn(async (table: unknown, empresaId: unknown, pks: unknown[]) => {
    const m = new Map<string, Record<string, unknown>>();
    for (const pk of pks) {
      const r = await fakeDb.findCanonical(table, empresaId, pk);
      if (r) m.set(String(pk), r as Record<string, unknown>);
    }
    return m;
  }),
  parentsInEmpresa: vi.fn(async (parentTable: unknown, parentIds: unknown[], empresaId: unknown) => {
    const s = new Set<string>();
    for (const id of parentIds) {
      if (await fakeDb.parentBelongsToEmpresa(parentTable, id, empresaId)) s.add(String(id));
    }
    return s;
  }),
  mergeAndUpsert: vi.fn(),
  upsertRaw: vi.fn(),
  setSyncReplica: vi.fn(async () => {}),
  selectAuthUsers: vi.fn(async (): Promise<Record<string, unknown>[]> => []),
};

// Supabase admin mock: suporta a cadeia de resolveDevice (from('dispositivos')...).
function makeAdminMock() {
  return {
    from() {
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        async maybeSingle() {
          return { data: deviceRow };
        },
        update() {
          return { eq: async () => ({ data: null }) };
        },
      };
    },
  };
}

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => makeAdminMock(),
}));

vi.mock('@/lib/sync/supabase-db', () => ({
  makeSupabaseSyncDb: () => fakeDb,
}));

import { POST as pullPOST } from '../../sync/pull/route';
import { POST as pushPOST } from '../../sync/push/route';

function req(body: unknown, token?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request('http://x/api/sync', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb.findCanonicalGlobal.mockResolvedValue(null);
  fakeDb.selectAuthUsers.mockResolvedValue([]);
  fakeDb.mergeAndUpsert.mockImplementation(
    async (_table: unknown, empresaId: string, row: Record<string, unknown>) => {
      const timestamps = Object.values(
        (row.field_updated_at ?? {}) as Record<string, string>,
      ).filter((value): value is string => typeof value === 'string').sort();
      return {
        ...row,
        ...(row.empresa_id !== undefined ? { empresa_id: empresaId } : {}),
        updated_at: timestamps.at(-1) ?? '1970-01-01T00:00:00Z',
      };
    },
  );
  deviceRow = { id: 'D1', empresa_id: 'E1', ativo: true };
});

describe('POST /api/sync/pull', () => {
  it('sem token → 401', async () => {
    const res = await pullPOST(req({ cursors: {} }) as never);
    expect(res.status).toBe(401);
  });

  it('dispositivo inativo → 401', async () => {
    deviceRow = { id: 'D1', empresa_id: 'E1', ativo: false };
    const res = await pullPOST(req({ cursors: {} }, 'tok') as never);
    expect(res.status).toBe(401);
  });

  it('devolve linhas > cursor incl. deleted_at e nextCursors', async () => {
    fakeDb.selectChanges.mockImplementation(async (table: string) => {
      if (table === 'clientes')
        return [
          { id: 'c1', empresa_id: 'E1', updated_at: '2026-01-02T00:00:00Z', deleted_at: null },
          { id: 'c2', empresa_id: 'E1', updated_at: '2026-01-05T00:00:00Z', deleted_at: '2026-01-05T00:00:00Z' },
        ];
      return [];
    });
    const res = await pullPOST(req({ cursors: { clientes: '2026-01-01T00:00:00Z' } }, 'tok') as never);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.tables.clientes.map((r: { id: string }) => r.id)).toEqual(['c1', 'c2']);
    expect(json.tables.clientes[1].deleted_at).toBe('2026-01-05T00:00:00Z');
    expect(json.nextCursors.clientes).toBe('2026-01-05T00:00:00Z');
    // o escopo por empresa foi passado ao db
    expect(fakeDb.selectChanges).toHaveBeenCalledWith('clientes', 'E1', '2026-01-01T00:00:00Z', 500);
  });

  it('retorna auth_users escopado por empresa (do device) + cursor próprio', async () => {
    fakeDb.selectAuthUsers.mockResolvedValue([
      { id: 'u1', email: 'a@e1', encrypted_password: 'h', updated_at: '2026-02-01T00:00:00Z' },
    ]);
    const res = await pullPOST(req({ cursors: { 'auth.users': '2026-01-01T00:00:00Z' } }, 'tok') as never);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.auth_users.map((u: { id: string }) => u.id)).toEqual(['u1']);
    expect(json.nextCursors['auth.users']).toBe('2026-02-01T00:00:00Z');
    // escopo: empresa do device (E1) é passada ao db, nunca o que vem do payload.
    expect(fakeDb.selectAuthUsers).toHaveBeenCalledWith('E1', '2026-01-01T00:00:00Z', 500);
  });

  it('identityOnly limita o pull a profiles e auth.users', async () => {
    fakeDb.selectChanges.mockImplementation(async (table: string) => (
      table === 'profiles'
        ? [{ id: 'u1', empresa_id: 'E1', updated_at: '2026-07-14T11:00:00Z' }]
        : []
    ));
    fakeDb.selectAuthUsers.mockResolvedValue([
      { id: 'u1', email: 'u1@example.test', updated_at: '2026-07-14T12:00:00Z' },
    ]);

    const res = await pullPOST(req({ cursors: {}, identityOnly: true }, 'tok') as never);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.identityOnly).toBe(true);
    expect(Object.keys(json.tables)).toEqual(['profiles']);
    expect(fakeDb.selectChanges).toHaveBeenCalledTimes(1);
    expect(fakeDb.selectChanges).toHaveBeenCalledWith(
      'profiles',
      'E1',
      '1970-01-01T00:00:00Z',
      500,
    );
    expect(fakeDb.selectAuthUsers).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/sync/push', () => {
  it('503 preserva retry quando a migration atomica ainda nao esta disponivel', async () => {
    fakeDb.mergeAndUpsert.mockRejectedValue(
      new SyncSchemaUnavailableError('sync_merge_upsert indisponivel'),
    );
    const res = await pushPOST(
      req({ rows: { pedidos: [{ id: 'p-4079', field_updated_at: {} }] } }, 'tok') as never,
    );

    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('30');
    expect(await res.json()).toEqual({
      error: 'Sincronizacao aguardando atualizacao do banco',
      blockedRow: { table: 'pedidos', pk: 'p-4079' },
    });
  });

  it('500 conhecido devolve somente tabela/PK sanitizadas', async () => {
    fakeDb.findCanonical.mockResolvedValue(null);
    fakeDb.mergeAndUpsert.mockRejectedValue(
      new Error('duplicate key value violates users_email_partial_key'),
    );
    const res = await pushPOST(
      req({ rows: { pedidos: [{ id: 'p-4079', field_updated_at: {} }] } }, 'tok') as never,
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: 'Falha ao gravar linha de sync',
      blockedRow: { table: 'pedidos', pk: 'p-4079' },
    });
  });

  it('sem token → 401', async () => {
    const res = await pushPOST(req({ rows: {} }) as never);
    expect(res.status).toBe(401);
  });

  it('push em tabela down → 403', async () => {
    const res = await pushPOST(req({ rows: { empresas: [{ id: 'x' }] } }, 'tok') as never);
    expect(res.status).toBe(403);
    expect(fakeDb.mergeAndUpsert).not.toHaveBeenCalled();
  });

  it('linha nova → INSERT (empresa_id forçado ao escopo)', async () => {
    fakeDb.findCanonical.mockResolvedValue(null);
    const res = await pushPOST(
      req({ rows: { clientes: [{ id: 'c1', empresa_id: 'HACK', nome: 'N', field_updated_at: { nome: '2026-03-01T00:00:00Z' } }] } }, 'tok') as never,
    );
    expect(res.status).toBe(200);
    const [, tenant, written] = fakeDb.mergeAndUpsert.mock.calls[0];
    expect(tenant).toBe('E1');
    expect(written.empresa_id).toBe('E1'); // forçado, ignora HACK
    expect((await res.json()).tables.clientes[0].updated_at).toBe('2026-03-01T00:00:00Z');
  });

  it('SEGURANÇA: PK existente em outra empresa → 403 propaga na rota', async () => {
    fakeDb.mergeAndUpsert.mockResolvedValue(null);
    const res = await pushPOST(
      req({ rows: { clientes: [{ id: 'c1', nome: 'HACK', field_updated_at: { nome: '2026-09-01T00:00:00Z' } }] } }, 'tok') as never,
    );
    expect(res.status).toBe(403);
    expect(fakeDb.mergeAndUpsert).toHaveBeenCalledTimes(1);
    expect(fakeDb.mergeAndUpsert.mock.calls[0][1]).toBe('E1');
  });

  it('linha existente recebe a canônica mergeada pela operação atômica', async () => {
    fakeDb.mergeAndUpsert.mockResolvedValue({
      id: 'c1',
      empresa_id: 'E1',
      endereco: 'NOVO',
      telefone: 'T-CANON',
      updated_at: '2026-02-01T00:00:00Z',
      field_updated_at: { endereco: '2026-02-01T00:00:00Z', telefone: '2026-01-10T00:00:00Z' },
    });
    const res = await pushPOST(
      req(
        {
          rows: {
            clientes: [
              {
                id: 'c1',
                endereco: 'NOVO',
                telefone: 'T-VELHO',
                field_updated_at: { endereco: '2026-02-01T00:00:00Z', telefone: '2026-01-05T00:00:00Z' },
              },
            ],
          },
        },
        'tok',
      ) as never,
    );
    const [, tenant, incoming] = fakeDb.mergeAndUpsert.mock.calls[0];
    expect(tenant).toBe('E1');
    expect(incoming.endereco).toBe('NOVO');
    expect(incoming.telefone).toBe('T-VELHO');
    const canonical = (await res.json()).tables.clientes[0];
    expect(canonical.endereco).toBe('NOVO');
    expect(canonical.telefone).toBe('T-CANON');
    expect(canonical.updated_at).toBe('2026-02-01T00:00:00Z');
  });
});
