import { Suspense } from 'react';
import Link from 'next/link';
import { PedidosList } from '@/components/pedidos-list';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { PedidoStatus } from '@/lib/types';

const VALID: PedidoStatus[] = ['pendente', 'em_separacao', 'finalizado'];

export default async function LogisticaPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const sp = await searchParams;
  const status: PedidoStatus = VALID.includes(sp.status as PedidoStatus)
    ? (sp.status as PedidoStatus)
    : 'pendente';

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold">Fila de Logística</h2>
        <p className="text-sm text-muted-foreground">
          Pedidos enviados pelos vendedores. Ordenação por bairro + data de entrega.
        </p>
      </div>

      <Tabs value={status} className="w-full">
        <TabsList>
          <TabsTrigger value="pendente"     render={<Link href="/logistica?status=pendente" />}>Pendentes</TabsTrigger>
          <TabsTrigger value="em_separacao" render={<Link href="/logistica?status=em_separacao" />}>Em separação</TabsTrigger>
          <TabsTrigger value="finalizado"   render={<Link href="/logistica?status=finalizado" />}>Finalizados</TabsTrigger>
        </TabsList>
      </Tabs>

      <Suspense fallback={<div className="h-32 rounded animate-pulse bg-muted/60" />}>
        <PedidosList
          mode="logistica"
          initialStatus={status}
          hideStatusFilter
          showNewButton={false}
        />
      </Suspense>
    </div>
  );
}
