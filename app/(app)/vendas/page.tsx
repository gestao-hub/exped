import { PedidosList } from '@/components/pedidos-list';

export default function VendasPage() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold">Meus Pedidos</h2>
        <p className="text-sm text-muted-foreground">
          Pedidos que você criou. Atualizações de status chegam em tempo real.
        </p>
      </div>
      <PedidosList mode="vendas" />
    </div>
  );
}
