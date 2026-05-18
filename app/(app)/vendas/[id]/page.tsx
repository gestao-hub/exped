import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Printer, History } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { MapaCarregamento, type PontoComItens } from '@/components/mapa-carregamento';
import { createClient } from '@/lib/supabase/server';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import type { PedidoItem } from '@/lib/types';
import { CancelarPedidoButton } from './cancelar-button';

export default async function PedidoDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const [{ data: pedido }, { data: pontosRaw }, { data: logistica }, { data: eventos }] =
    await Promise.all([
      supabase.from('pedidos').select('*').eq('id', id).single(),
      supabase
        .from('pedido_pontos_retirada')
        .select('*, itens:pedido_itens(*)')
        .eq('pedido_id', id)
        .order('ordem'),
      supabase.from('pedido_logistica').select('*').eq('pedido_id', id).maybeSingle(),
      supabase
        .from('pedido_eventos')
        .select('*, usuario:profiles(full_name)')
        .eq('pedido_id', id)
        .order('created_at', { ascending: false })
        .limit(20),
    ]);

  if (!pedido) notFound();

  const vendedor = pedido.vendedor_id
    ? (await supabase.from('profiles').select('full_name, email').eq('id', pedido.vendedor_id).single()).data
    : null;

  const pontos = (pontosRaw ?? []).map((p) => ({
    ...p,
    itens: ((p.itens ?? []) as PedidoItem[]).sort(
      (a: PedidoItem, b: PedidoItem) => (a.ordem ?? 0) - (b.ordem ?? 0),
    ),
  })) as unknown as PontoComItens[];

  const podeCancelar = ['rascunho', 'pendente'].includes(pedido.status);

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-2xl font-semibold">
          Pedido <span className="text-muted-foreground font-mono">#{pedido.numero_mapa}</span>
        </h2>
        <div className="flex gap-2">
          <Link
            href={`/vendas/${id}/imprimir`}
            target="_blank"
            className={cn(buttonVariants({ variant: 'outline' }))}
          >
            <Printer className="h-4 w-4 mr-1" /> Imprimir
          </Link>
          {podeCancelar && <CancelarPedidoButton id={id} />}
        </div>
      </div>

      <MapaCarregamento
        pedido={pedido}
        pontos={pontos}
        logistica={logistica ?? undefined}
        vendedor={vendedor}
      />

      {/* Timeline */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <History className="h-4 w-4" /> Histórico
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!eventos?.length ? (
            <p className="text-sm text-muted-foreground italic">Sem eventos.</p>
          ) : (
            <ol className="space-y-3">
              {eventos.map((ev) => {
                const usuario = ev.usuario as { full_name?: string | null } | null;
                return (
                  <li key={ev.id} className="flex gap-3 text-sm">
                    <div className="w-2 h-2 rounded-full bg-franzoni-orange mt-1.5 shrink-0" />
                    <div className="flex-1">
                      <p>{ev.descricao || ev.tipo}</p>
                      <p className="text-xs text-muted-foreground">
                        {format(new Date(ev.created_at), "dd/MM 'às' HH:mm", { locale: ptBR })}
                        {usuario?.full_name ? ` · ${usuario.full_name}` : ''}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

