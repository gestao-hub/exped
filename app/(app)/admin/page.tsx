import Link from 'next/link';
import { Package, TruckIcon, History, Users, UsersRound, Clock } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { ContentCard } from '@/components/layout/content-card';
import {
  PedidosPorDia,
  TopClientes,
  TopBairros,
} from '@/components/admin-charts';
import { createClient } from '@/lib/supabase/server';
import { cn } from '@/lib/utils';
import { format, subDays, startOfDay } from 'date-fns';

export const dynamic = 'force-dynamic';

export default async function AdminDashboard() {
  const supabase = await createClient();

  const [
    pedidosCount,
    pendentesCount,
    separacaoCount,
    parciaisCount,
    finalizadosCount,
    usuariosCount,
    clientesCount,
    // Gráficos
    { data: ultimos30 },
    { data: finalizados },
    { data: todosPedidos },
    // Tempo médio pendente→finalizado (agregado no banco)
    { data: tempoMedioRaw },
  ] = await Promise.all([
    supabase.from('pedidos').select('id', { count: 'exact', head: true }),
    supabase.from('pedidos').select('id', { count: 'exact', head: true }).eq('status', 'pendente'),
    supabase
      .from('pedidos')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'em_separacao'),
    supabase
      .from('pedidos')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'parcialmente_entregue'),
    supabase
      .from('pedidos')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'finalizado'),
    supabase.from('profiles').select('id', { count: 'exact', head: true }),
    supabase.from('clientes').select('id', { count: 'exact', head: true }),

    // Pedidos por dia (últimos 30)
    supabase
      .from('pedidos')
      .select('created_at')
      .gte('created_at', subDays(new Date(), 30).toISOString()),

    // Top clientes (finalizados, valor) — agregado no banco
    supabase.rpc('admin_top_clientes', { p_limit: 10 }),

    // Top bairros (todos) — agregado no banco
    supabase.rpc('admin_top_bairros', { p_limit: 10 }),

    // Tempo médio pendente→finalizado (RPC agregada no banco)
    supabase.rpc('admin_tempo_medio_horas'),
  ]);

  // ---------- Cálculos ----------

  // 1. Pedidos por dia (últimos 30) — preenche dias zerados
  const porDia = new Map<string, number>();
  for (let i = 29; i >= 0; i--) {
    porDia.set(format(subDays(startOfDay(new Date()), i), 'dd/MM'), 0);
  }
  for (const p of (ultimos30 ?? []) as { created_at: string }[]) {
    const k = format(new Date(p.created_at), 'dd/MM');
    porDia.set(k, (porDia.get(k) ?? 0) + 1);
  }
  const seriePorDia = Array.from(porDia, ([dia, pedidos]) => ({ dia, pedidos }));

  // 2. Top clientes (já agregado pela RPC admin_top_clientes)
  const topClientes = (finalizados ?? []).map((c) => ({
    nome: c.cliente_nome,
    valor: Number(c.total ?? 0),
    pedidos: Number(c.pedidos ?? 0),
  }));

  // 3. Top bairros (já agregado pela RPC admin_top_bairros)
  const topBairros = (todosPedidos ?? []).map((b) => ({
    bairro: b.cliente_bairro,
    pedidos: Number(b.pedidos ?? 0),
  }));

  // 4. Tempo médio "pendente → finalizado" (em horas) — agregado no banco (RPC).
  const tempoMedioHoras = tempoMedioRaw == null ? null : Number(tempoMedioRaw);

  // ---------- Stats e shortcuts ----------
  const stats = [
    { label: 'Total de pedidos', value: pedidosCount.count ?? 0,    accent: 'text-foreground' },
    { label: 'Pendentes',        value: pendentesCount.count ?? 0,  accent: 'text-status-pendente' },
    { label: 'Em separação',     value: separacaoCount.count ?? 0,  accent: 'text-status-separacao' },
    { label: 'Parcialmente',     value: parciaisCount.count ?? 0,   accent: 'text-amber-600 dark:text-amber-400' },
    { label: 'Finalizados',      value: finalizadosCount.count ?? 0, accent: 'text-status-finalizado' },
  ];

  const shortcuts = [
    { label: 'Ver Pedidos',    href: '/vendas',         icon: Package,    color: 'text-brand' },
    { label: 'Fila Logística', href: '/logistica',      icon: TruckIcon,  color: 'text-franzoni-navy' },
    { label: 'Histórico',      href: '/historico',      icon: History,    color: 'text-status-finalizado' },
    { label: 'Clientes',       href: '/admin/clientes', icon: UsersRound, color: 'text-brand' },
    { label: 'Usuários',       href: '/admin/usuarios', icon: Users,      color: 'text-brand' },
  ];

  return (
    <>
      <PageHeader
        title="Painel Admin"
        description="Visão geral do sistema, indicadores e atalhos rápidos."
      />

      {/* KPIs principais */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((s) => (
          <ContentCard key={s.label} className="p-5!">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">
              {s.label}
            </p>
            <p className={cn('text-3xl font-heading font-bold mt-1', s.accent)}>{s.value}</p>
          </ContentCard>
        ))}
      </div>

      {/* Tempo médio + clientes/usuários */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <ContentCard className="p-5!">
          <div className="flex items-start gap-3">
            <div className="h-9 w-9 rounded-lg bg-franzoni-navy/10 flex items-center justify-center shrink-0">
              <Clock className="h-4 w-4 text-franzoni-navy" />
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">
                Tempo médio até finalizado
              </p>
              <p className="text-xl font-heading font-bold text-franzoni-navy dark:text-white mt-0.5">
                {tempoMedioHoras == null
                  ? '—'
                  : tempoMedioHoras < 24
                  ? `${tempoMedioHoras.toFixed(1)}h`
                  : `${(tempoMedioHoras / 24).toFixed(1)} dias`}
              </p>
            </div>
          </div>
        </ContentCard>
        <ContentCard className="p-5!">
          <div className="flex items-start gap-3">
            <div className="h-9 w-9 rounded-lg bg-brand/10 flex items-center justify-center shrink-0">
              <UsersRound className="h-4 w-4 text-brand" />
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">
                Clientes cadastrados
              </p>
              <p className="text-xl font-heading font-bold text-franzoni-navy dark:text-white mt-0.5">
                {clientesCount.count ?? 0}
              </p>
            </div>
          </div>
        </ContentCard>
        <ContentCard className="p-5!">
          <div className="flex items-start gap-3">
            <div className="h-9 w-9 rounded-lg bg-brand/10 flex items-center justify-center shrink-0">
              <Users className="h-4 w-4 text-brand" />
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">
                Usuários ativos
              </p>
              <p className="text-xl font-heading font-bold text-franzoni-navy dark:text-white mt-0.5">
                {usuariosCount.count ?? 0}
              </p>
            </div>
          </div>
        </ContentCard>
      </div>

      {/* Gráfico de pedidos por dia */}
      <PedidosPorDia data={seriePorDia} />

      {/* Top clientes + bairros */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <TopClientes data={topClientes} />
        <TopBairros data={topBairros} />
      </div>

      {/* Atalhos */}
      <div>
        <h2 className="text-sm font-semibold text-muted-foreground mb-3 uppercase tracking-wider">
          Atalhos
        </h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {shortcuts.map((s) => {
            const Icon = s.icon;
            return (
              <Link
                key={s.href}
                href={s.href}
                className="group glass-card rounded-xl p-4 flex items-center gap-3 transition-all hover:shadow-lg hover:-translate-y-0.5"
              >
                <div className="h-10 w-10 rounded-lg bg-white/60 dark:bg-white/5 flex items-center justify-center group-hover:scale-110 transition-transform">
                  <Icon className={cn('h-5 w-5', s.color)} />
                </div>
                <span className="font-medium text-sm">{s.label}</span>
              </Link>
            );
          })}
        </div>
      </div>

    </>
  );
}
