import { PageHeader } from '@/components/layout/page-header';
import { PedidosList } from '@/components/pedidos-list';
import { ContentCard } from '@/components/layout/content-card';
import { createClient } from '@/lib/supabase/server';
import { CheckCircle2, DollarSign, UsersRound } from 'lucide-react';

export const dynamic = 'force-dynamic';

export default async function HistoricoPage() {
  const supabase = await createClient();

  const { count: total } = await supabase
    .from('pedidos')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'finalizado');

  const { data: valores } = await supabase
    .from('pedidos')
    .select('valor_total, cliente_nome')
    .eq('status', 'finalizado')
    .limit(10000);

  const valorTotal = (valores ?? []).reduce(
    (s: number, p: { valor_total: number }) => s + Number(p.valor_total ?? 0),
    0,
  );
  const clientesUnicos = new Set(
    (valores ?? []).map((p: { cliente_nome: string }) => p.cliente_nome),
  ).size;

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <PageHeader title="Histórico" description="Pedidos finalizados e indicadores acumulados." />

      <div className="grid grid-cols-3 gap-3 shrink-0">
        <Kpi
          icon={<CheckCircle2 className="h-4 w-4 text-status-finalizado" />}
          label="Pedidos finalizados"
          value={total ?? 0}
        />
        <Kpi
          icon={<DollarSign className="h-4 w-4 text-franzoni-orange" />}
          label="Valor faturado"
          value={valorTotal.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
        />
        <Kpi
          icon={<UsersRound className="h-4 w-4 text-franzoni-navy" />}
          label="Clientes únicos"
          value={clientesUnicos}
        />
      </div>

      <PedidosList mode="historico" initialStatus="finalizado" showNewButton={false} bounded />
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
        <div className="h-8 w-8 rounded-md bg-franzoni-orange/10 flex items-center justify-center shrink-0">
          {icon}
        </div>
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium leading-tight">
            {label}
          </p>
          <p className="text-lg font-heading font-bold text-franzoni-navy dark:text-white leading-tight mt-0.5 truncate">
            {value}
          </p>
        </div>
      </div>
    </ContentCard>
  );
}
