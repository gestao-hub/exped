import type { PedidoStatus } from '@/lib/types';
import {
  buildPedidoNumericSearchOr,
  buildPedidoTextSearchOr,
  parsePedidoSearch,
} from './filtros-lista';

type PedidoListQueryBuilder = {
  is(column: string, value: null): unknown;
  eq(column: string, value: string | number): unknown;
  or(filter: string): unknown;
};

export type PedidoListQueryPolicyOptions = {
  empresaId: string | null | undefined;
  status: PedidoStatus | 'todos';
  search: string;
};

export function applyPedidoListQueryPolicy<T extends PedidoListQueryBuilder>(
  query: T,
  { empresaId, status, search }: PedidoListQueryPolicyOptions,
): T {
  let next = query.is('deleted_at', null) as T;

  if (empresaId) next = next.eq('empresa_id', empresaId) as T;
  if (status !== 'todos') next = next.eq('status', status) as T;

  const searchFilter = parsePedidoSearch(search);
  if (searchFilter.kind === 'numero_mapa') {
    next = next.or(buildPedidoNumericSearchOr(searchFilter.value)) as T;
  } else if (searchFilter.kind === 'texto') {
    next = next.or(buildPedidoTextSearchOr(searchFilter.value)) as T;
  }

  return next;
}
