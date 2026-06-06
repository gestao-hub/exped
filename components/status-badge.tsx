import { cn } from '@/lib/utils';
import type { PedidoStatus } from '@/lib/types';

const LABELS: Record<PedidoStatus, string> = {
  rascunho:               'Rascunho',
  em_financeiro:          'No financeiro',
  pendente:               'Pendente',
  em_separacao:           'Em separação',
  em_transporte:          'Em transporte',
  parcialmente_entregue:  'Parcialmente entregue',
  finalizado:             'Finalizado',
  cancelado:              'Cancelado',
};

const STYLES: Record<PedidoStatus, string> = {
  rascunho:               'bg-status-rascunho/12     text-status-rascunho     ring-status-rascunho/25',
  em_financeiro:          'bg-sky-500/12             text-sky-700             ring-sky-500/30 dark:text-sky-300',
  pendente:               'bg-status-pendente/12     text-status-pendente     ring-status-pendente/25',
  em_separacao:           'bg-status-separacao/12    text-status-separacao    ring-status-separacao/25',
  em_transporte:          'bg-violet-500/12          text-violet-700          ring-violet-500/30 dark:text-violet-300',
  parcialmente_entregue:  'bg-amber-500/12           text-amber-700           ring-amber-500/30 dark:text-amber-300',
  finalizado:             'bg-status-finalizado/15   text-status-finalizado   ring-status-finalizado/30',
  cancelado:              'bg-status-cancelado/12    text-status-cancelado    ring-status-cancelado/25',
};

const DOT_STYLES: Record<PedidoStatus, string> = {
  rascunho:               'bg-status-rascunho',
  em_financeiro:          'bg-sky-500',
  pendente:               'bg-status-pendente',
  em_separacao:           'bg-status-separacao',
  em_transporte:          'bg-violet-500',
  parcialmente_entregue:  'bg-amber-500',
  finalizado:             'bg-status-finalizado',
  cancelado:              'bg-status-cancelado',
};

export function StatusBadge({ status, className }: { status: PedidoStatus; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium',
        'ring-1 ring-inset',
        STYLES[status],
        className,
      )}
    >
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          DOT_STYLES[status],
          (status === 'em_separacao' || status === 'em_transporte' || status === 'parcialmente_entregue') && 'animate-pulse',
        )}
      />
      {LABELS[status]}
    </span>
  );
}
