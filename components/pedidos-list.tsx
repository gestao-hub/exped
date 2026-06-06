'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
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
import { Search, Plus, Inbox, X, Play, CheckCircle2, Printer, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { calcularPaginacao, PAGE_SIZE } from '@/lib/pedidos/paginacao';
import { useUser } from '@/components/providers/user-provider';
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
import { SortableHead, type SortDir } from '@/components/ui/sortable-head';
import { DatePicker } from '@/components/ui/date-picker';
import { StatusBadge } from '@/components/status-badge';
import { useConfirm } from '@/components/providers/confirm-provider';
import { createClient } from '@/lib/supabase/client';
import { useLiveUpdates } from '@/lib/realtime/use-live-updates';
import type { Pedido, PedidoStatus } from '@/lib/types';
import {
  iniciarSeparacaoLoteAction,
  finalizarLoteAction,
  iniciarSeparacaoAction,
  finalizarPedidoAction,
} from '@/app/(app)/vendas/actions';

type Mode = 'vendas' | 'logistica' | 'historico' | 'financeiro';
type ParcialItem = {
  codigo: string;
  descricao: string;
  quantidade: number;
  quantidade_entregue: number;
  unidade: string;
  restante: number;
};
type SortKey =
  | 'numero_mapa'
  | 'cliente_nome'
  | 'cliente_bairro'
  | 'data_entrega'
  | 'valor_total'
  | 'created_at';
type DateRangeKey = 'todos' | 'hoje' | 'semana' | 'mes' | 'custom';

const STATUS_OPTIONS: { value: PedidoStatus | 'todos'; label: string }[] = [
  { value: 'todos',        label: 'Todos' },
  { value: 'rascunho',     label: 'Rascunho' },
  { value: 'em_financeiro',          label: 'No financeiro' },
  { value: 'pendente',               label: 'Pendente' },
  { value: 'em_separacao',           label: 'Em separação' },
  { value: 'em_transporte',          label: 'Em transporte' },
  { value: 'parcialmente_entregue',  label: 'Parcialmente entregue' },
  { value: 'finalizado',             label: 'Finalizado' },
  { value: 'cancelado',    label: 'Cancelado' },
];

const DATE_RANGES: { value: Exclude<DateRangeKey, 'custom'>; label: string }[] = [
  { value: 'todos',  label: 'Todos' },
  { value: 'hoje',   label: 'Hoje' },
  { value: 'semana', label: 'Semana' },
  { value: 'mes',    label: 'Mês' },
];

function computeRange(
  key: DateRangeKey,
  customFrom?: string | null,
  customTo?: string | null,
): { from: Date; to: Date } | null {
  const now = new Date();
  switch (key) {
    case 'hoje':   return { from: startOfDay(now),                       to: endOfDay(now)   };
    case 'semana': return { from: startOfWeek(now, { weekStartsOn: 1 }), to: endOfWeek(now, { weekStartsOn: 1 }) };
    case 'mes':    return { from: startOfMonth(now),                     to: endOfMonth(now) };
    case 'custom': {
      if (!customFrom && !customTo) return null;
      const from = customFrom ? startOfDay(new Date(`${customFrom}T12:00:00`)) : new Date('1970-01-01');
      const to   = customTo   ? endOfDay(new Date(`${customTo}T12:00:00`))     : new Date('2999-12-31');
      return { from, to };
    }
    default:       return null;
  }
}

export function PedidosList({
  mode = 'vendas',
  initialStatus,
  hideStatusFilter,
  showNewButton = true,
  bounded = false,
  selectable = false,
}: {
  mode?: Mode;
  initialStatus?: PedidoStatus | 'todos';
  hideStatusFilter?: boolean;
  showNewButton?: boolean;
  bounded?: boolean;
  /** Quando true, exibe checkboxes pra seleção múltipla + barra de ações em lote. */
  selectable?: boolean;
}) {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const { profile } = useUser();
  const empresaId = profile.empresa_id;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pedidos, setPedidos] = useState<Pedido[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [tick, setTick] = useState(0);
  const [itensParciais, setItensParciais] = useState<Record<string, ParcialItem[]>>({});
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [status, setStatus] = useState<PedidoStatus | 'todos'>(initialStatus ?? 'todos');
  const [dateRange, setDateRange] = useState<DateRangeKey>('todos');
  const [customFrom, setCustomFrom] = useState<string | null>(null);
  const [customTo, setCustomTo] = useState<string | null>(null);
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

    const pageFrom = (Math.max(1, page) - 1) * PAGE_SIZE;
    const pageTo = pageFrom + PAGE_SIZE - 1;
    let query = supabase
      .from('pedidos')
      .select('*', { count: 'exact' })
      .order(sortBy, { ascending: sortDir === 'asc', nullsFirst: false })
      .order('id', { ascending: true })
      .range(pageFrom, pageTo);

    if (status !== 'todos') query = query.eq('status', status);
    if (search.trim()) {
      const q = `%${search.trim()}%`;
      query = query.or(
        `cliente_nome.ilike.${q},documento_erp.ilike.${q},cliente_bairro.ilike.${q}`,
      );
    }
    const range = computeRange(dateRange, customFrom, customTo);
    if (range) {
      query = query
        .gte('data_entrega', format(range.from, 'yyyy-MM-dd'))
        .lte('data_entrega', format(range.to,   'yyyy-MM-dd'));
    }

    query.then(({ data, count, error }) => {
      if (cancel) return;
      if (error) toast.error(error.message);
      setPedidos((data ?? []) as Pedido[]);
      setTotal(count ?? 0);
      setLoading(false);
    });

    return () => { cancel = true; };
  }, [supabase, status, search, sortBy, sortDir, dateRange, customFrom, customTo, page, tick]);

  // Volta pra página 1 quando muda filtro/busca/ordenação (evita ficar numa página vazia).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPage(1);
  }, [status, search, sortBy, sortDir, dateRange, customFrom, customTo]);

  // Debounce da busca: digita em searchInput; aplica em search após 300ms (evita 1 query por tecla).
  useEffect(() => {
    const id = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(id);
  }, [searchInput]);

  // Chave estável dos parciais — o efeito abaixo só re-roda quando o CONJUNTO de parciais muda,
  // não a cada mutação do array `pedidos` (ex.: um refetch do realtime que não mexe nos parciais).
  const idsParciais = pedidos
    .filter((p) => p.status === 'parcialmente_entregue')
    .map((p) => p.id)
    .sort()
    .join(',');

  // Busca itens dos pedidos parcialmente entregues (mostra inline na linha)
  useEffect(() => {
    const ids = idsParciais ? idsParciais.split(',') : [];
    if (ids.length === 0) {
      setItensParciais({});
      return;
    }

    let cancel = false;
    (async () => {
      const { data: pontos } = await supabase
        .from('pedido_pontos_retirada')
        .select('id, pedido_id')
        .in('pedido_id', ids)
        .is('deleted_at', null);
      if (cancel || !pontos) return;
      const pontoToPedido = new Map(pontos.map((p) => [p.id as string, p.pedido_id as string]));
      const pontoIds = pontos.map((p) => p.id as string);
      if (pontoIds.length === 0) return;

      const { data: itens } = await supabase
        .from('pedido_itens')
        .select('codigo, descricao, quantidade, quantidade_entregue, unidade, ponto_retirada_id')
        .in('ponto_retirada_id', pontoIds)
        .is('deleted_at', null);
      if (cancel || !itens) return;

      const byPedido: Record<string, ParcialItem[]> = {};
      for (const it of itens) {
        const pedidoId = pontoToPedido.get(it.ponto_retirada_id as string);
        if (!pedidoId) continue;
        const qt = Number(it.quantidade);
        const qe = Number(it.quantidade_entregue);
        const restante = Math.max(0, qt - qe);
        if (restante <= 0) continue;
        (byPedido[pedidoId] ??= []).push({
          codigo: it.codigo as string,
          descricao: it.descricao as string,
          quantidade: qt,
          quantidade_entregue: qe,
          unidade: it.unidade as string,
          restante,
        });
      }
      // Ordena por restante desc (mais pendente primeiro)
      for (const k of Object.keys(byPedido)) {
        byPedido[k].sort((a, b) => b.restante - a.restante);
      }
      setItensParciais(byPedido);
    })();

    return () => { cancel = true; };
  }, [supabase, idsParciais]);

  // Atualização ao vivo: hub (SSE /avisos) ou nuvem (canal postgres_changes), escolhido em
  // useLiveUpdates. Debounce 500ms: um lote do sync dispara vários eventos → refetch 1x.
  // Canal/SSE escopado por empresa (RLS não filtra o stream WAL; o SSE filtra no fanout).
  const debRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onLive = useCallback(() => {
    if (debRef.current) clearTimeout(debRef.current);
    debRef.current = setTimeout(() => setTick((t) => t + 1), 500);
  }, []);
  useEffect(() => () => { if (debRef.current) clearTimeout(debRef.current); }, []);
  useLiveUpdates(empresaId, onLive);

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
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
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
                  'bg-brand hover:bg-brand-600 text-white shadow-sm shadow-brand/30',
                )}
              >
                <Plus className="h-4 w-4 mr-1" /> Novo Pedido
              </Link>
            )}
          </div>

          {/* Atalhos de período (por data de entrega) */}
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
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
                    'bg-brand hover:bg-brand-600 text-white',
                )}
                onClick={() => {
                  setDateRange(r.value);
                  setCustomFrom(null);
                  setCustomTo(null);
                }}
              >
                {r.label}
              </Button>
            ))}

            {/* Divisor visual + range custom inline (substitui o pill "Personalizado") */}
            <div className="h-5 w-px bg-border/60 mx-1.5" aria-hidden />
            <span className="text-muted-foreground">De</span>
            <div className="w-40">
              <DatePicker
                value={customFrom}
                onChangeAction={(v) => {
                  setCustomFrom(v);
                  setDateRange(v || customTo ? 'custom' : 'todos');
                }}
                placeholder="Data inicial"
              />
            </div>
            <span className="text-muted-foreground">até</span>
            <div className="w-40">
              <DatePicker
                value={customTo}
                onChangeAction={(v) => {
                  setCustomTo(v);
                  setDateRange(v || customFrom ? 'custom' : 'todos');
                }}
                placeholder="Data final"
              />
            </div>
            {(customFrom || customTo) && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setCustomFrom(null);
                  setCustomTo(null);
                  setDateRange('todos');
                }}
                aria-label="Limpar datas"
              >
                Limpar
              </Button>
            )}
          </div>
        </div>
      </ContentCard>

      {/* Lista — tabela em desktop, cards em mobile */}
      <ContentCard variant="flush" className={cn(bounded && 'flex flex-col flex-1 min-h-0')}>
        <div className={cn(bounded ? 'flex-1 overflow-y-auto min-h-0' : '')}>
          {/* === MOBILE (< md): cards verticais === */}
          <ul className="md:hidden divide-y divide-border/50">
            {loading ? (
              <li className="p-4">
                <div className="space-y-2">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <div key={i} className="h-16 rounded-md animate-pulse bg-muted/60" />
                  ))}
                </div>
              </li>
            ) : pedidos.length === 0 ? (
              <li className="py-16 flex flex-col items-center gap-3 text-muted-foreground">
                <Inbox className="h-10 w-10 opacity-40" />
                <p className="text-sm">Nenhum pedido encontrado.</p>
              </li>
            ) : (
              pedidos.map((p) => {
                const href =
                  mode === 'logistica'
                    ? `/logistica/${p.id}`
                    : mode === 'financeiro'
                    ? `/financeiro/${p.id}`
                    : mode === 'historico'
                    ? `/historico/${p.id}`
                    : `/vendas/${p.id}`;
                const isSel = selected.has(p.id);
                return (
                  <li
                    key={p.id}
                    className="px-4 py-3 cursor-pointer active:bg-brand/8 transition-colors"
                    onClick={(e) => {
                      // Click no checkbox não navega
                      if ((e.target as HTMLElement).tagName === 'INPUT') return;
                      router.push(href);
                    }}
                  >
                    <div className="flex items-start justify-between gap-3 mb-1">
                      <div className="flex items-center gap-2 shrink-0">
                        {selectable && (
                          <input
                            type="checkbox"
                            aria-label="Selecionar pedido"
                            className="h-4 w-4 rounded accent-brand cursor-pointer"
                            checked={isSel}
                            onClick={(e) => e.stopPropagation()}
                            onChange={() => {
                              setSelected((prev) => {
                                const next = new Set(prev);
                                if (next.has(p.id)) next.delete(p.id);
                                else next.add(p.id);
                                return next;
                              });
                            }}
                          />
                        )}
                        <span className="font-mono text-[11px] text-muted-foreground">
                          #{p.numero_mapa}
                        </span>
                        {p.documento_erp && (
                          <span
                            className="font-mono text-[11px] text-muted-foreground/80 px-1.5 py-0.5 rounded bg-muted/60"
                            title={`Código Hiper: ${p.documento_erp}`}
                          >
                            {p.documento_erp}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <StatusBadge status={p.status} />
                        {mode === 'logistica' && (
                          <InlineStatusActions pedidoId={p.id} status={p.status} />
                        )}
                      </div>
                    </div>
                    <p className="font-semibold text-sm text-foreground truncate">
                      {p.cliente_nome}
                    </p>
                    {p.status === 'parcialmente_entregue' && itensParciais[p.id] && (
                      <ParcialItensInline itens={itensParciais[p.id]} compact />
                    )}
                    <div className="flex items-center justify-between gap-2 mt-1.5 text-xs">
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        {p.cliente_bairro && (
                          <span
                            className="truncate px-2 py-0.5 rounded-md bg-franzoni-navy/8 text-franzoni-navy dark:text-franzoni-navy-100 font-medium"
                            title={p.cliente_bairro}
                          >
                            {p.cliente_bairro}
                          </span>
                        )}
                        <span className="text-muted-foreground shrink-0">
                          {p.data_entrega
                            ? format(new Date(`${p.data_entrega}T12:00:00`), "dd/MM", { locale: ptBR })
                            : '—'}
                        </span>
                      </div>
                      <span className="font-mono font-semibold text-foreground shrink-0">
                        {Number(p.valor_total).toLocaleString('pt-BR', {
                          style: 'currency',
                          currency: 'BRL',
                        })}
                      </span>
                    </div>
                  </li>
                );
              })
            )}
          </ul>

          {/* === DESKTOP (>= md): tabela === */}
          <Table className="hidden md:table table-fixed w-full">
            <TableHeader
              className={cn(
                bounded && 'sticky top-0 z-10 bg-white/90 dark:bg-zinc-900/90 backdrop-blur-md',
              )}
            >
              <TableRow className="hover:bg-transparent">
                {selectable && (
                  <TableHead className="w-10 pl-5">
                    <input
                      type="checkbox"
                      aria-label="Selecionar todos"
                      className="h-4 w-4 rounded accent-brand cursor-pointer"
                      checked={pedidos.length > 0 && pedidos.every((p) => selected.has(p.id))}
                      onChange={(e) => {
                        if (e.target.checked) setSelected(new Set(pedidos.map((p) => p.id)));
                        else setSelected(new Set());
                      }}
                    />
                  </TableHead>
                )}
                <SortableHead width={selectable ? 'w-14' : 'w-16 pl-5'} sortKey="numero_mapa" current={sortBy} dir={sortDir} onClickAction={toggleSort}>
                  Nº
                </SortableHead>
                <TableHead className="w-24">Cód. Hiper</TableHead>
                <SortableHead width="w-[24%] min-w-0" sortKey="cliente_nome" current={sortBy} dir={sortDir} onClickAction={toggleSort}>
                  Cliente
                </SortableHead>
                <SortableHead width="w-[16%] min-w-0" sortKey="cliente_bairro" current={sortBy} dir={sortDir} onClickAction={toggleSort}>
                  Bairro
                </SortableHead>
                <SortableHead width="w-28" sortKey="data_entrega" current={sortBy} dir={sortDir} onClickAction={toggleSort}>
                  Entrega
                </SortableHead>
                <TableHead className="w-32">Status</TableHead>
                <SortableHead width="w-32 text-right pr-5" sortKey="valor_total" current={sortBy} dir={sortDir} onClickAction={toggleSort} align="right">
                  Valor
                </SortableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={selectable ? 8 : 7} className="px-5">
                    <div className="space-y-2 py-2">
                      {Array.from({ length: 5 }).map((_, i) => (
                        <div key={i} className="h-9 rounded-md animate-pulse bg-muted/60" />
                      ))}
                    </div>
                  </TableCell>
                </TableRow>
              ) : pedidos.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={selectable ? 8 : 7} className="py-16">
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
                      : mode === 'financeiro'
                      ? `/financeiro/${p.id}`
                      : mode === 'historico'
                      ? `/historico/${p.id}`
                      : `/vendas/${p.id}`;
                  const isSel = selected.has(p.id);
                  return (
                    <TableRow
                      key={p.id}
                      data-state={isSel ? 'selected' : undefined}
                      className={cn(
                        'cursor-pointer hover:bg-brand/5 transition-colors',
                        isSel && 'bg-brand/10',
                      )}
                      onClick={(e) => {
                        if ((e.target as HTMLElement).tagName === 'INPUT') return;
                        router.push(href);
                      }}
                    >
                      {selectable && (
                        <TableCell className="pl-5">
                          <input
                            type="checkbox"
                            aria-label="Selecionar pedido"
                            className="h-4 w-4 rounded accent-brand cursor-pointer"
                            checked={isSel}
                            onClick={(e) => e.stopPropagation()}
                            onChange={() => {
                              setSelected((prev) => {
                                const next = new Set(prev);
                                if (next.has(p.id)) next.delete(p.id);
                                else next.add(p.id);
                                return next;
                              });
                            }}
                          />
                        </TableCell>
                      )}
                      <TableCell className={cn('font-mono text-xs text-muted-foreground', !selectable && 'pl-5')}>
                        #{p.numero_mapa}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        <span className="truncate block" title={p.documento_erp ?? undefined}>
                          {p.documento_erp || '—'}
                        </span>
                      </TableCell>
                      <TableCell className="font-medium text-foreground min-w-0">
                        <div className="truncate" title={p.cliente_nome}>
                          {p.cliente_nome}
                        </div>
                        {p.status === 'parcialmente_entregue' && itensParciais[p.id] && (
                          <ParcialItensInline itens={itensParciais[p.id]} />
                        )}
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
                        <div className="flex items-center gap-1.5">
                          <StatusBadge status={p.status} />
                          {mode === 'logistica' && (
                            <InlineStatusActions pedidoId={p.id} status={p.status} />
                          )}
                        </div>
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
        {(() => {
          const { totalPages, hasPrev, hasNext } = calcularPaginacao(page, total);
          return (
            <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm text-muted-foreground border-t shrink-0">
              <span>
                {total} {total === 1 ? 'pedido' : 'pedidos'} · página {Math.min(page, totalPages)} de {totalPages}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={!hasPrev}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="px-3 py-1.5 rounded-md border disabled:opacity-40 disabled:cursor-not-allowed hover:bg-muted/60 transition-colors"
                >
                  ‹ Anterior
                </button>
                <button
                  type="button"
                  disabled={!hasNext}
                  onClick={() => setPage((p) => p + 1)}
                  className="px-3 py-1.5 rounded-md border disabled:opacity-40 disabled:cursor-not-allowed hover:bg-muted/60 transition-colors"
                >
                  Próxima ›
                </button>
              </div>
            </div>
          );
        })()}
      </ContentCard>

      {selectable && selected.size > 0 && (
        <BulkActionBar
          ids={Array.from(selected)}
          status={status}
          onClear={() => setSelected(new Set())}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detalhe inline dos itens com saldo pendente (status parcialmente_entregue)
// ---------------------------------------------------------------------------
function ParcialItensInline({ itens, compact = false }: { itens: ParcialItem[]; compact?: boolean }) {
  if (!itens || itens.length === 0) return null;
  const visiveis = itens.slice(0, 2);
  const sobra = itens.length - visiveis.length;
  return (
    <div className={cn('space-y-0.5 mt-1', compact ? 'text-[11px]' : 'text-xs')}>
      {visiveis.map((it) => (
        <div
          key={it.codigo}
          className="text-amber-700 dark:text-amber-400 font-normal flex items-baseline gap-1.5 min-w-0"
          title={`${it.descricao} — entregue ${fmtQtd(it.quantidade_entregue)} de ${fmtQtd(it.quantidade)} ${it.unidade}, falta ${fmtQtd(it.restante)} ${it.unidade}`}
        >
          <span className="font-medium truncate min-w-0">{it.descricao}</span>
          <span className="font-mono shrink-0 whitespace-nowrap">
            {fmtQtd(it.quantidade_entregue)}/{fmtQtd(it.quantidade)} {it.unidade}
          </span>
          <span className="text-muted-foreground shrink-0 whitespace-nowrap">
            · falta {fmtQtd(it.restante)} {it.unidade}
          </span>
        </div>
      ))}
      {sobra > 0 && (
        <div className="text-[10px] text-muted-foreground">
          +{sobra} item{sobra === 1 ? '' : 's'} pendente{sobra === 1 ? '' : 's'}
        </div>
      )}
    </div>
  );
}

function fmtQtd(n: number): string {
  // Inteiro sem decimal; senão, até 3 decimais sem zeros à direita
  return n % 1 === 0 ? String(n) : Number(n.toFixed(3)).toString();
}

// ---------------------------------------------------------------------------
// Botões inline de mudança de status na linha da tabela (logística)
// ---------------------------------------------------------------------------
function InlineStatusActions({
  pedidoId,
  status,
}: {
  pedidoId: string;
  status: PedidoStatus;
}) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const confirm = useConfirm();
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  function iniciar(e: React.MouseEvent) {
    stop(e);
    start(async () => {
      const r = await iniciarSeparacaoAction(pedidoId);
      if ('error' in r) toast.error(r.error);
      else {
        toast.success('Separação iniciada');
        router.refresh();
      }
    });
  }

  async function finalizar(e: React.MouseEvent) {
    stop(e);
    const ok = await confirm({
      title: 'Marcar como entregue total?',
      description: 'Todos os itens serão considerados entregues. Para registrar entrega parcial, use o detalhe do pedido.',
      confirmText: 'Marcar finalizado',
    });
    if (!ok) return;
    start(async () => {
      const r = await finalizarPedidoAction(pedidoId);
      if ('error' in r) toast.error(r.error);
      else {
        toast.success('Pedido finalizado');
        router.refresh();
      }
    });
  }

  if (status === 'pendente') {
    return (
      <button
        type="button"
        onClick={iniciar}
        disabled={pending}
        className="inline-flex items-center justify-center h-6 w-6 rounded-md bg-status-separacao/15 text-status-separacao hover:bg-status-separacao/25 transition-colors"
        title="Iniciar separação"
      >
        {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3 fill-current" />}
      </button>
    );
  }
  if (
    status === 'em_separacao' ||
    status === 'em_transporte' ||
    status === 'parcialmente_entregue'
  ) {
    return (
      <button
        type="button"
        onClick={finalizar}
        disabled={pending}
        className="inline-flex items-center justify-center h-6 w-6 rounded-md bg-status-finalizado/15 text-status-finalizado hover:bg-status-finalizado/25 transition-colors"
        title="Marcar como entregue total"
      >
        {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
      </button>
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Barra flutuante de ações em lote
// ---------------------------------------------------------------------------
function BulkActionBar({
  ids,
  status,
  onClear,
}: {
  ids: string[];
  status: PedidoStatus | 'todos';
  onClear: () => void;
}) {
  const [pending, start] = useTransition();
  const [guiaCliente, setGuiaCliente] = useState(true);
  const router = useRouter();

  function iniciar() {
    start(async () => {
      const r = await iniciarSeparacaoLoteAction(ids);
      if ('error' in r) {
        toast.error(r.error);
        return;
      }
      toast.success(
        `${r.updated} pedido${r.updated === 1 ? '' : 's'} → em separação`,
      );
      onClear();
      router.refresh();
    });
  }

  function finalizar() {
    start(async () => {
      const r = await finalizarLoteAction(ids);
      if ('error' in r) {
        toast.error(r.error);
        return;
      }
      toast.success(
        `${r.updated} pedido${r.updated === 1 ? '' : 's'} → finalizado`,
      );
      onClear();
      router.refresh();
    });
  }

  function imprimir() {
    window.open(
      `/imprimir/lote?ids=${ids.join(',')}&guia=${guiaCliente ? 1 : 0}`,
      '_blank',
    );
  }

  return (
    <div className="fixed inset-x-0 bottom-4 px-4 z-40 pointer-events-none">
      <div className="mx-auto max-w-3xl glass-elevated rounded-xl border border-brand/30 shadow-2xl shadow-brand/10 px-3 py-2 flex items-center gap-2 pointer-events-auto">
        <span className="px-2 text-sm font-medium">
          {ids.length} selecionado{ids.length === 1 ? '' : 's'}
        </span>
        <div className="h-5 w-px bg-border/60" />
        {status === 'pendente' && (
          <Button
            size="sm"
            onClick={iniciar}
            disabled={pending}
            className="bg-brand hover:bg-brand-600"
          >
            {pending ? (
              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5 mr-1" />
            )}
            Iniciar separação
          </Button>
        )}
        {(status === 'em_separacao' ||
          status === 'em_transporte' ||
          status === 'parcialmente_entregue') && (
          <Button
            size="sm"
            onClick={finalizar}
            disabled={pending}
            className="bg-status-finalizado hover:bg-status-finalizado/90 text-white"
          >
            {pending ? (
              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
            )}
            Finalizar
          </Button>
        )}
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground cursor-pointer select-none whitespace-nowrap">
          <input
            type="checkbox"
            checked={guiaCliente}
            onChange={(e) => setGuiaCliente(e.target.checked)}
            className="h-4 w-4 accent-franzoni-navy"
          />
          Guia do cliente
        </label>
        <Button size="sm" variant="outline" onClick={imprimir} disabled={pending}>
          <Printer className="h-3.5 w-3.5 mr-1" />
          Imprimir {ids.length}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          onClick={onClear}
          aria-label="Limpar seleção"
          className="h-8 w-8 ml-auto"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

// SortableHead foi extraído pra @/components/ui/sortable-head (reuso em /admin/usuarios)
