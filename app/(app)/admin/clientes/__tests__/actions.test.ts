import { beforeEach, describe, expect, it, vi } from 'vitest';

const SOURCE_ID = '10000000-0000-4000-8000-000000000001';
const TARGET_ID = '10000000-0000-4000-8000-000000000002';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  revalidatePath: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
  queryCalls: [] as Array<{ method: string; args: unknown[] }>,
}));

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }));

import { deleteClienteAction, mergeClienteAction } from '../actions';

describe('ações de clientes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.queryCalls.length = 0;
    mocks.rpc.mockResolvedValue({ data: 1, error: null });

    const query = {
      update(...args: unknown[]) {
        mocks.queryCalls.push({ method: 'update', args });
        return query;
      },
      delete(...args: unknown[]) {
        mocks.queryCalls.push({ method: 'delete', args });
        return query;
      },
      eq(...args: unknown[]) {
        mocks.queryCalls.push({ method: 'eq', args });
        return query;
      },
      is(...args: unknown[]) {
        mocks.queryCalls.push({ method: 'is', args });
        return query;
      },
      then(resolve: (value: { error: null }) => unknown) {
        return Promise.resolve({ error: null }).then(resolve);
      },
    };

    mocks.from.mockReturnValue(query);
    mocks.createClient.mockResolvedValue({ rpc: mocks.rpc, from: mocks.from });
  });

  it('delega o merge inteiro para uma única RPC transacional', async () => {
    await expect(
      mergeClienteAction({ sourceId: SOURCE_ID, targetId: TARGET_ID }),
    ).resolves.toEqual({ ok: true });

    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith('merge_clientes', {
      p_source_id: SOURCE_ID,
      p_target_id: TARGET_ID,
    });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('propaga a falha da RPC sem revalidar a lista', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'merge recusado' } });

    await expect(
      mergeClienteAction({ sourceId: SOURCE_ID, targetId: TARGET_ID }),
    ).resolves.toEqual({ error: 'Falha ao mesclar clientes: merge recusado' });

    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('arquiva o cliente sem executar DELETE físico', async () => {
    await expect(deleteClienteAction(SOURCE_ID)).resolves.toEqual({ ok: true });

    expect(mocks.queryCalls).toContainEqual({
      method: 'update',
      args: [{ deleted_at: expect.any(String) }],
    });
    expect(mocks.queryCalls).toContainEqual({ method: 'eq', args: ['id', SOURCE_ID] });
    expect(mocks.queryCalls).toContainEqual({ method: 'is', args: ['deleted_at', null] });
    expect(mocks.queryCalls.some(({ method }) => method === 'delete')).toBe(false);
  });
});
