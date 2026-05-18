import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { PedidoStatus } from '@/lib/types';

const LABELS: Record<PedidoStatus, string> = {
  rascunho:     'Rascunho',
  pendente:     'Pendente',
  em_separacao: 'Em separação',
  finalizado:   'Finalizado',
  cancelado:    'Cancelado',
};

const STYLES: Record<PedidoStatus, string> = {
  rascunho:     'bg-status-rascunho/15  text-status-rascunho  border-status-rascunho/30',
  pendente:     'bg-status-pendente/15  text-status-pendente  border-status-pendente/30',
  em_separacao: 'bg-status-separacao/15 text-status-separacao border-status-separacao/30',
  finalizado:   'bg-status-finalizado/15 text-status-finalizado border-status-finalizado/30',
  cancelado:    'bg-status-cancelado/15 text-status-cancelado border-status-cancelado/30',
};

export function StatusBadge({ status, className }: { status: PedidoStatus; className?: string }) {
  return (
    <Badge variant="outline" className={cn('font-medium', STYLES[status], className)}>
      {LABELS[status]}
    </Badge>
  );
}
