import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  upsertRaw: vi.fn(),
  setSyncReplica: vi.fn(async () => {}),
  selectAuthUsers: vi.fn(async (): Promise<Record<string, unknown>[]> => []),
};

// Supabase admin mock: suporta a cadeia de resolveDevice (from('dispositivos')...).
function makeAdminMock() {
  return {
    from(_t: string) {
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
});

describe('POST /api/sync/push', () => {
  it('sem token → 401', async () => {
    const res = await pushPOST(req({ rows: {} }) as never);
    expect(res.status).toBe(401);
  });

  it('push em tabela down → 403', async () => {
    const res = await pushPOST(req({ rows: { empresas: [{ id: 'x' }] } }, 'tok') as never);
    expect(res.status).toBe(403);
    expect(fakeDb.upsertRaw).not.toHaveBeenCalled();
  });

  it('linha nova → INSERT (empresa_id forçado ao escopo)', async () => {
    fakeDb.findCanonical.mockResolvedValue(null);
    fakeDb.upsertRaw.mockImplementation(async (_t: string, row: Record<string, unknown>) => row);
    const res = await pushPOST(
      req({ rows: { clientes: [{ id: 'c1', empresa_id: 'HACK', nome: 'N', field_updated_at: { nome: '2026-03-01T00:00:00Z' } }] } }, 'tok') as never,
    );
    expect(res.status).toBe(200);
    const [, written] = fakeDb.upsertRaw.mock.calls[0];
    expect(written.empresa_id).toBe('E1'); // forçado, ignora HACK
    expect(written.updated_at).toBe('2026-03-01T00:00:00Z');
  });

  it('SEGURANÇA: PK existente em outra empresa → 403 propaga na rota (sem upsert)', async () => {
    fakeDb.findCanonical.mockResolvedValue(null); // não enxerga (escopado em E1)
    fakeDb.findCanonicalGlobal.mockResolvedValue({ id: 'c1', empresa_id: 'E2', nome: 'B' }); // existe global, da E2
    const res = await pushPOST(
      req({ rows: { clientes: [{ id: 'c1', nome: 'HACK', field_updated_at: { nome: '2026-09-01T00:00:00Z' } }] } }, 'tok') as never,
    );
    expect(res.status).toBe(403);
    expect(fakeDb.upsertRaw).not.toHaveBeenCalled();
  });

  it('linha existente com field_updated_at mais novo em 1 coluna → merge aplica essa coluna', async () => {
    fakeDb.findCanonical.mockResolvedValue({
      id: 'c1',
      empresa_id: 'E1',
      endereco: 'CANON',
      telefone: 'T-CANON',
      field_updated_at: { endereco: '2026-01-01T00:00:00Z', telefone: '2026-01-10T00:00:00Z' },
    });
    fakeDb.upsertRaw.mockImplementation(async (_t: string, row: Record<string, unknown>) => row);
    await pushPOST(
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
    const [, written] = fakeDb.upsertRaw.mock.calls[0];
    expect(written.endereco).toBe('NOVO'); // incoming mais novo
    expect(written.telefone).toBe('T-CANON'); // canon mais novo
    expect(written.updated_at).toBe('2026-02-01T00:00:00Z');
  });
});
