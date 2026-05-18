import { PageHeader } from '@/components/layout/page-header';
import { PedidosList } from '@/components/pedidos-list';

export default function VendasPage() {
  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <PageHeader
        title="Meus Pedidos"
        description="Pedidos criados por você. As atualizações de status da logística chegam em tempo real."
      />
      <PedidosList mode="vendas" bounded />
    </div>
  );
}
