import { PageHeader } from '@/components/layout/page-header';
import { PedidosList } from '@/components/pedidos-list';
import { PuxarButton } from '@/components/puxar-button';

export default function VendasPage() {
  // O botão "Puxar" só aparece no HUB local (onde o agente é acessível via AGENT_SYNC_URL).
  const podePuxar = !!process.env.AGENT_SYNC_URL;
  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <PageHeader
        title="Meus Pedidos"
        description="Pedidos criados por você. As atualizações de status da logística chegam em tempo real."
      />
      {podePuxar && (
        <div className="flex justify-center">
          <PuxarButton />
        </div>
      )}
      <PedidosList mode="vendas" bounded />
    </div>
  );
}
