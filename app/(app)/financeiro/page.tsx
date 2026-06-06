import { Suspense } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/layout/page-header';
import { PedidosList } from '@/components/pedidos-list';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { PedidoStatus } from '@/lib/types';

const VALID: PedidoStatus[] = ['em_financeiro', 'pendente'];

export default async function FinanceiroPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const sp = await searchParams;
  const status: PedidoStatus = VALID.includes(sp.status as PedidoStatus)
    ? (sp.status as PedidoStatus)
    : 'em_financeiro';

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <PageHeader
        title="Financeiro"
        description="Confira pagamento e frete dos pedidos enviados pelos vendedores e libere para a logística."
      />

      <Tabs value={status} className="w-full shrink-0">
        <TabsList>
          <TabsTrigger value="em_financeiro" render={<Link href="/financeiro?status=em_financeiro" />}>
            A conferir
          </TabsTrigger>
          <TabsTrigger value="pendente" render={<Link href="/financeiro?status=pendente" />}>
            Liberados
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <Suspense
        fallback={<div className="h-32 rounded-xl animate-pulse bg-muted/60 shrink-0" />}
      >
        <PedidosList
          key={status}
          mode="financeiro"
          initialStatus={status}
          hideStatusFilter
          showNewButton={false}
          bounded
        />
      </Suspense>
    </div>
  );
}
