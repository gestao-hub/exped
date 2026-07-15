import { PageHeader } from '@/components/layout/page-header';
import { PedidosList } from '@/components/pedidos-list';
import { ContentCard } from '@/components/layout/content-card';
import { createClient } from '@/lib/supabase/server';
import { CheckCircle2, DollarSign, UsersRound, Download } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  HISTORICO_EXPORT_STATUS,
  HISTORICO_INITIAL_STATUS,
} from '@/lib/pedidos/historico';

export const dynamic = 'force-dynamic';

export default async function HistoricoPage() {
  const supabase = await createClient();

  // KPIs agregados no banco (RPC) — evita puxar até 10k linhas e somar em JS (que truncava).
  const { data: kpi } = await supabase.rpc('historico_kpis').single();
  const total = Number(kpi?.pedidos_finalizados ?? 0);
  const valorTotal = Number(kpi?.valor_faturado ?? 0);
  const clientesUnicos = Number(kpi?.clientes_unicos ?? 0);

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <PageHeader
        title="Histórico"
        description="Pedidos de todos os status e indicadores acumulados de finalizados."
        actions={
          <a
            href={`/historico/export?status=${HISTORICO_EXPORT_STATUS}`}
            className={cn(buttonVariants({ variant: 'outline' }))}
          >
            <Download className="h-4 w-4 mr-1" /> Exportar finalizados
          </a>
        }
      />

      <div className="grid grid-cols-1 gap-3 shrink-0 sm:grid-cols-3">
        <Kpi
          icon={<CheckCircle2 className="h-4 w-4 text-status-finalizado" />}
          label="Pedidos finalizados"
          value={total ?? 0}
        />
        <Kpi
          icon={<DollarSign className="h-4 w-4 text-brand" />}
          label="Valor faturado"
          value={valorTotal.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
        />
        <Kpi
          icon={<UsersRound className="h-4 w-4 text-franzoni-navy" />}
          label="Clientes únicos"
          value={clientesUnicos}
        />
      </div>

      <PedidosList
        mode="historico"
        initialStatus={HISTORICO_INITIAL_STATUS}
        showNewButton={false}
        bounded
      />
    </div>
  );
}

function Kpi({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
}) {
  return (
    <ContentCard className="p-3!">
      <div className="flex items-center gap-2.5">
        <div className="h-8 w-8 rounded-md bg-brand/10 flex items-center justify-center shrink-0">
          {icon}
        </div>
        <div className="min-w-0">
          <p className="text-xs uppercase text-muted-foreground font-medium leading-tight">
            {label}
          </p>
          <p className="text-lg font-heading font-bold text-franzoni-navy dark:text-white leading-tight mt-0.5 break-words">
            {value}
          </p>
        </div>
      </div>
    </ContentCard>
  );
}
