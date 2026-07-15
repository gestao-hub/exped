import type { PedidoStatus } from '@/lib/types';

export const HISTORICO_INITIAL_STATUS = 'todos' as const;
export const HISTORICO_EXPORT_STATUS = 'finalizado' as const;

export const PEDIDO_STATUS_LABELS: Record<PedidoStatus, string> = {
  rascunho: 'Rascunho',
  em_financeiro: 'No caixa',
  pendente: 'Pendente',
  em_separacao: 'Em separação',
  em_transporte: 'Em transporte',
  parcialmente_entregue: 'Parcialmente entregue',
  finalizado: 'Finalizado',
  cancelado: 'Cancelado',
};

export function pedidoStatusLabel(status: PedidoStatus): string {
  return PEDIDO_STATUS_LABELS[status];
}

export function historicoDetailDescription(status: PedidoStatus): string {
  return `Status: ${pedidoStatusLabel(status)}. Somente leitura.`;
}
