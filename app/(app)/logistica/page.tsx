import { Suspense } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/layout/page-header';
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
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <PageHeader
        title="Fila de Logística"
        description="Pedidos enviados pelos vendedores, ordenados por bairro e data de entrega."
      />

      <Tabs value={status} className="w-full shrink-0">
        <TabsList>
          <TabsTrigger value="pendente"     render={<Link href="/logistica?status=pendente" />}>
            Pendentes
          </TabsTrigger>
          <TabsTrigger value="em_separacao" render={<Link href="/logistica?status=em_separacao" />}>
            Em separação
          </TabsTrigger>
          <TabsTrigger value="finalizado"   render={<Link href="/logistica?status=finalizado" />}>
            Finalizados
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <Suspense
        fallback={
          <div className="h-32 rounded-xl animate-pulse bg-muted/60 shrink-0" />
        }
      >
        <PedidosList
          key={status}
          mode="logistica"
          initialStatus={status}
          hideStatusFilter
          showNewButton={false}
          bounded
        />
      </Suspense>
    </div>
  );
}
