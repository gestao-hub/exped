'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  format,
  startOfDay,
  endOfDay,
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
} from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { Search, Plus, Inbox, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import { toast } from 'sonner';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ContentCard } from '@/components/layout/content-card';
import { StatusBadge } from '@/components/status-badge';
import { createClient } from '@/lib/supabase/client';
import type { Pedido, PedidoStatus } from '@/lib/types';

type Mode = 'vendas' | 'logistica' | 'historico';
type SortKey =
  | 'numero_mapa'
  | 'cliente_nome'
  | 'cliente_bairro'
  | 'data_entrega'
  | 'valor_total'
  | 'created_at';
type SortDir = 'asc' | 'desc';
type DateRangeKey = 'todos' | 'hoje' | 'semana' | 'mes';

const STATUS_OPTIONS: { value: PedidoStatus | 'todos'; label: string }[] = [
  { value: 'todos',        label: 'Todos' },
  { value: 'rascunho',     label: 'Rascunho' },
  { value: 'pendente',     label: 'Pendente' },
  { value: 'em_separacao', label: 'Em separação' },
  { value: 'finalizado',   label: 'Finalizado' },
  { value: 'cancelado',    label: 'Cancelado' },
];

const DATE_RANGES: { value: DateRangeKey; label: string }[] = [
  { value: 'todos',  label: 'Todos' },
  { value: 'hoje',   label: 'Hoje' },
  { value: 'semana', label: 'Semana' },
  { value: 'mes',    label: 'Mês' },
];

function computeRange(key: DateRangeKey): { from: Date; to: Date } | null {
  const now = new Date();
  switch (key) {
    case 'hoje':   return { from: startOfDay(now),                       to: endOfDay(now)   };
    case 'semana': return { from: startOfWeek(now, { weekStartsOn: 1 }), to: endOfWeek(now, { weekStartsOn: 1 }) };
    case 'mes':    return { from: startOfMonth(now),                     to: endOfMonth(now) };
    default:       return null;
  }
}

export function PedidosList({
  mode = 'vendas',
  initialStatus,
  hideStatusFilter,
  showNewButton = true,
  bounded = false,
}: {
  mode?: Mode;
  initialStatus?: PedidoStatus | 'todos';
  hideStatusFilter?: boolean;
  showNewButton?: boolean;
  bounded?: boolean;
}) {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const [pedidos, setPedidos] = useState<Pedido[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<PedidoStatus | 'todos'>(initialStatus ?? 'todos');
  const [dateRange, setDateRange] = useState<DateRangeKey>('todos');
  const [sortBy, setSortBy] = useState<SortKey>(
    mode === 'logistica' ? 'data_entrega' : 'created_at',
  );
  const [sortDir, setSortDir] = useState<SortDir>(
    mode === 'logistica' ? 'asc' : 'desc',
  );

  function toggleSort(key: SortKey) {
    if (sortBy === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(key);
      setSortDir(key === 'cliente_nome' || key === 'cliente_bairro' ? 'asc' : 'desc');
    }
  }

  useEffect(() => {
    let cancel = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);

    let query = supabase
      .from('pedidos')
      .select('*')
      .order(sortBy, { ascending: sortDir === 'asc', nullsFirst: false })
      .limit(200);

    if (status !== 'todos') query = query.eq('status', status);
    if (search.trim()) {
      const q = `%${search.trim()}%`;
      query = query.or(
        `cliente_nome.ilike.${q},documento_erp.ilike.${q},cliente_bairro.ilike.${q}`,
      );
    }
    const range = computeRange(dateRange);
    if (range) {
      query = query
        .gte('data_entrega', format(range.from, 'yyyy-MM-dd'))
        .lte('data_entrega', format(range.to,   'yyyy-MM-dd'));
    }

    query.then(({ data, error }) => {
      if (cancel) return;
      if (error) toast.error(error.message);
      setPedidos((data ?? []) as Pedido[]);
      setLoading(false);
    });

    return () => { cancel = true; };
  }, [supabase, status, search, sortBy, sortDir, dateRange]);

  useEffect(() => {
    const channel = supabase
      .channel('pedidos-list')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'pedidos' },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            const novo = payload.new as Pedido;
            setPedidos((prev) => {
              if (prev.some((p) => p.id === novo.id)) return prev;
              return [novo, ...prev];
            });
            if (mode === 'logistica' && novo.status === 'pendente') {
              toast(`Novo pedido na fila: ${novo.cliente_nome}`);
            }
          } else if (payload.eventType === 'UPDATE') {
            setPedidos((prev) =>
              prev.map((p) => (p.id === (payload.new as Pedido).id ? (payload.new as Pedido) : p)),
            );
          } else if (payload.eventType === 'DELETE') {
            setPedidos((prev) => prev.filter((p) => p.id !== (payload.old as Pedido).id));
          }
        },
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [supabase, mode]);

  return (
    <div className={cn('space-y-3', bounded && 'flex flex-col flex-1 min-h-0')}>
      {/* Filtros */}
      <ContentCard className="p-3!" variant="padded">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
              <Input
                placeholder="Buscar por cliente, documento ou bairro…"
                className="pl-9 bg-white/60 dark:bg-white/5"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            {!hideStatusFilter && (
              <Select value={status} onValueChange={(v) => setStatus(v as PedidoStatus | 'todos')}>
                <SelectTrigger className="w-full sm:w-48 bg-white/60 dark:bg-white/5">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {showNewButton && (
              <Link
                href="/vendas/novo"
                className={cn(
                  buttonVariants(),
                  'bg-franzoni-orange hover:bg-franzoni-orange-600 text-white shadow-sm shadow-franzoni-orange/30',
                )}
              >
                <Plus className="h-4 w-4 mr-1" /> Novo Pedido
              </Link>
            )}
          </div>

          {/* Atalhos de período (por data de entrega) */}
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-muted-foreground mr-1">Entrega:</span>
            {DATE_RANGES.map((r) => (
              <Button
                key={r.value}
                type="button"
                size="sm"
                variant={dateRange === r.value ? 'default' : 'outline'}
                className={cn(
                  'h-7 px-3 text-xs',
                  dateRange === r.value &&
                    'bg-franzoni-orange hover:bg-franzoni-orange-600 text-white',
                )}
                onClick={() => setDateRange(r.value)}
              >
                {r.label}
              </Button>
            ))}
          </div>
        </div>
      </ContentCard>

      {/* Tabela */}
      <ContentCard variant="flush" className={cn(bounded && 'flex flex-col flex-1 min-h-0')}>
        <div className={cn(bounded ? 'flex-1 overflow-y-auto min-h-0' : '')}>
          <Table className="table-fixed w-full">
            <TableHeader
              className={cn(
                bounded && 'sticky top-0 z-10 bg-white/90 dark:bg-zinc-900/90 backdrop-blur-md',
              )}
            >
              <TableRow className="hover:bg-transparent">
                <SortableHead width="w-20 pl-5" sortKey="numero_mapa" current={sortBy} dir={sortDir} onClick={toggleSort}>
                  Mapa
                </SortableHead>
                <SortableHead width="w-[28%] min-w-0" sortKey="cliente_nome" current={sortBy} dir={sortDir} onClick={toggleSort}>
                  Cliente
                </SortableHead>
                <SortableHead width="w-[18%] min-w-0" sortKey="cliente_bairro" current={sortBy} dir={sortDir} onClick={toggleSort}>
                  Bairro
                </SortableHead>
                <SortableHead width="w-28" sortKey="data_entrega" current={sortBy} dir={sortDir} onClick={toggleSort}>
                  Entrega
                </SortableHead>
                <TableHead className="w-32">Status</TableHead>
                <SortableHead width="w-32 text-right pr-5" sortKey="valor_total" current={sortBy} dir={sortDir} onClick={toggleSort} align="right">
                  Valor
                </SortableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={6} className="px-5">
                    <div className="space-y-2 py-2">
                      {Array.from({ length: 5 }).map((_, i) => (
                        <div key={i} className="h-9 rounded-md animate-pulse bg-muted/60" />
                      ))}
                    </div>
                  </TableCell>
                </TableRow>
              ) : pedidos.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-16">
                    <div className="flex flex-col items-center gap-3 text-muted-foreground">
                      <Inbox className="h-10 w-10 opacity-40" />
                      <p className="text-sm">Nenhum pedido encontrado.</p>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                pedidos.map((p) => {
                  const href =
                    mode === 'logistica'
                      ? `/logistica/${p.id}`
                      : mode === 'historico'
                      ? `/historico/${p.id}`
                      : `/vendas/${p.id}`;
                  return (
                    <TableRow
                      key={p.id}
                      className="cursor-pointer hover:bg-franzoni-orange/5 transition-colors"
                      onClick={() => router.push(href)}
                    >
                      <TableCell className="font-mono text-xs text-muted-foreground pl-5">
                        #{p.numero_mapa}
                      </TableCell>
                      <TableCell className="font-medium text-foreground truncate" title={p.cliente_nome}>
                        {p.cliente_nome}
                      </TableCell>
                      <TableCell className="min-w-0">
                        {p.cliente_bairro ? (
                          <span
                            className="inline-block max-w-full truncate px-2 py-0.5 rounded-md bg-franzoni-navy/8 text-franzoni-navy dark:text-franzoni-navy-100 text-xs font-medium align-middle"
                            title={p.cliente_bairro}
                          >
                            {p.cliente_bairro}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">
                        {p.data_entrega
                          ? format(new Date(`${p.data_entrega}T12:00:00`), "dd 'de' MMM", { locale: ptBR })
                          : '—'}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={p.status} />
                      </TableCell>
                      <TableCell className="text-right font-mono pr-5">
                        {Number(p.valor_total).toLocaleString('pt-BR', {
                          style: 'currency',
                          currency: 'BRL',
                        })}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </ContentCard>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cabeçalho de tabela com ordenação clicável
// ---------------------------------------------------------------------------
function SortableHead({
  children,
  sortKey,
  current,
  dir,
  onClick,
  width,
  align = 'left',
}: {
  children: React.ReactNode;
  sortKey: SortKey;
  current: SortKey;
  dir: SortDir;
  onClick: (k: SortKey) => void;
  width?: string;
  align?: 'left' | 'right';
}) {
  const active = current === sortKey;
  const Icon = !active ? ArrowUpDown : dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <TableHead className={cn(width, align === 'right' && 'text-right')}>
      <button
        type="button"
        onClick={() => onClick(sortKey)}
        className={cn(
          'inline-flex items-center gap-1.5 select-none',
          'hover:text-foreground transition-colors',
          active ? 'text-foreground font-semibold' : 'text-muted-foreground',
          align === 'right' && 'flex-row-reverse',
        )}
      >
        <span>{children}</span>
        <Icon className={cn('h-3.5 w-3.5', active ? 'opacity-100' : 'opacity-40')} />
      </button>
    </TableHead>
  );
}
