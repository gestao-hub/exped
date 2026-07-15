import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  clienteIs: vi.fn(),
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useCallback: <T,>(callback: T) => callback,
    useEffect: (effect: () => void | (() => void)) => effect(),
    useMemo: <T,>(factory: () => T) => factory(),
    useState: <T,>(initial: T) => [initial, vi.fn()],
  };
});
vi.mock('@/lib/supabase/client', () => ({ createClient: mocks.createClient }));

import { useEnderecosDoCliente } from './use-enderecos-do-cliente';

describe('useEnderecosDoCliente', () => {
  it('não resolve endereço a partir de cliente tombstonado', async () => {
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      is: mocks.clienteIs.mockImplementation(() => query),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    mocks.createClient.mockReturnValue({ from: vi.fn().mockReturnValue(query) });

    useEnderecosDoCliente('12.345.678/0001-90');

    await vi.waitFor(() => {
      expect(mocks.clienteIs).toHaveBeenCalledWith('deleted_at', null);
    });
  });
});
