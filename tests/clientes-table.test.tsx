import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  clienteIs: vi.fn(),
  effects: [] as Array<() => void | (() => void)>,
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useEffect: (effect: () => void | (() => void)) => mocks.effects.push(effect),
    useMemo: <T,>(factory: () => T) => factory(),
    useState: <T,>(initial: T) => [initial, vi.fn()],
    useTransition: () => [false, vi.fn()],
  };
});
vi.mock('@/lib/supabase/client', () => ({ createClient: mocks.createClient }));
vi.mock('@/app/(app)/admin/clientes/actions', () => ({
  deleteClienteAction: vi.fn(),
  updateClienteAction: vi.fn(),
}));

import { ClientesTable } from '@/components/clientes-table';

describe('ClientesTable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.effects.length = 0;
  });

  it('lista somente clientes ativos e conta somente pedidos ativos', () => {
    const query = {
      select: vi.fn(() => query),
      is: mocks.clienteIs.mockImplementation(() => query),
      order: vi.fn(() => query),
      range: vi.fn(() => query),
      or: vi.fn(() => query),
      then: (resolve: (result: { data: never[]; count: number; error: null }) => unknown) =>
        Promise.resolve({ data: [], count: 0, error: null }).then(resolve),
    };
    mocks.createClient.mockReturnValue({ from: vi.fn().mockReturnValue(query) });

    ClientesTable();
    expect(mocks.effects).toHaveLength(3);
    mocks.effects[2]?.();

    expect(mocks.clienteIs).toHaveBeenCalledWith('deleted_at', null);
    expect(mocks.clienteIs).toHaveBeenCalledWith('pedidos.deleted_at', null);
  });
});
