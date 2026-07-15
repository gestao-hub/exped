import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  effectIndex: 0,
}));

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return {
    ...react,
    useCallback: <T,>(callback: T) => callback,
    useEffect: (effect: () => void | (() => void)) => {
      mocks.effectIndex += 1;
      if (mocks.effectIndex === 1) effect();
    },
    useMemo: <T,>(factory: () => T) => factory(),
    useRef: <T,>(value: T) => ({ current: value }),
    useState: <T,>(initial: T | (() => T)) => [
      typeof initial === 'function' ? (initial as () => T)() : initial,
      vi.fn(),
    ],
    useTransition: () => [false, vi.fn()],
  };
});

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/components/providers/user-provider', () => ({
  useUser: () => ({ profile: { empresa_id: 'empresa-1' } }),
}));
vi.mock('@/components/providers/confirm-provider', () => ({
  useConfirm: () => vi.fn(),
}));
vi.mock('@/lib/realtime/use-live-updates', () => ({ useLiveUpdates: vi.fn() }));
vi.mock('@/lib/supabase/client', () => ({ createClient: mocks.createClient }));

import { PedidosList } from '@/components/pedidos-list';

type Query = {
  select: (...args: unknown[]) => Query;
  is: (...args: unknown[]) => Query;
  eq: (...args: unknown[]) => Query;
  or: (...args: unknown[]) => Query;
  order: (...args: unknown[]) => Query;
  range: (...args: unknown[]) => Query;
  then: (resolve: (result: { data: never[]; count: number; error: null }) => void) => void;
};

describe('PedidosList query', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.effectIndex = 0;
  });

  it('exclui pedidos removidos na consulta executada pelo componente', () => {
    const calls: unknown[][] = [];
    const query = {} as Query;
    for (const method of ['select', 'is', 'eq', 'or', 'order', 'range'] as const) {
      query[method] = (...args: unknown[]) => {
        calls.push([method, ...args]);
        return query;
      };
    }
    query.then = (resolve) => resolve({ data: [], count: 0, error: null });

    mocks.createClient.mockReturnValue({
      from: vi.fn((table: string) => {
        expect(table).toBe('pedidos');
        return query;
      }),
    });

    PedidosList({ mode: 'historico', initialStatus: 'todos' });

    expect(calls).toContainEqual(['is', 'deleted_at', null]);
  });
});
