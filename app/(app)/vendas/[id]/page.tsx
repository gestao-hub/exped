import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Printer, History, ArrowLeft } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { PageHeader } from '@/components/layout/page-header';
import { ContentCard, ContentCardTitle } from '@/components/layout/content-card';
import { MapaCarregamento, type PontoComItens } from '@/components/mapa-carregamento';
import { PedidoComentarios } from '@/components/pedido-comentarios';
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

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const [
    { data: pedido },
    { data: pontosRaw },
    { data: logistica },
    { data: eventos },
    { data: comentarios },
  ] = await Promise.all([
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
    supabase
      .from('pedido_comentarios')
      .select('*, autor:profiles(full_name, email, role)')
      .eq('pedido_id', id)
      .order('created_at', { ascending: true }),
  ]);

  if (!pedido) notFound();

  const vendedor = pedido.vendedor_id
    ? (
        await supabase
          .from('profiles')
          .select('full_name, email')
          .eq('id', pedido.vendedor_id)
          .single()
      ).data
    : null;

  const pontos = (pontosRaw ?? []).map((p) => ({
    ...p,
    itens: ((p.itens ?? []) as PedidoItem[]).sort(
      (a: PedidoItem, b: PedidoItem) => (a.ordem ?? 0) - (b.ordem ?? 0),
    ),
  })) as unknown as PontoComItens[];

  const podeCancelar = ['rascunho', 'pendente'].includes(pedido.status);

  return (
    <>
      <PageHeader
        title={`Pedido #${pedido.numero_mapa}`}
        description={pedido.cliente_nome}
        actions={
          <>
            <Link
              href="/vendas"
              className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }))}
            >
              <ArrowLeft className="h-4 w-4 mr-1" /> Voltar
            </Link>
            <Link
              href={`/imprimir/${id}`}
              target="_blank"
              className={cn(buttonVariants({ variant: 'outline' }))}
            >
              <Printer className="h-4 w-4 mr-1" /> Imprimir
            </Link>
            {podeCancelar && <CancelarPedidoButton id={id} />}
          </>
        }
      />

      <MapaCarregamento
        pedido={pedido}
        pontos={pontos}
        logistica={logistica ?? undefined}
        vendedor={vendedor}
      />

      {user && (
        <PedidoComentarios
          pedidoId={id}
          initial={
            (comentarios ?? []) as unknown as React.ComponentProps<typeof PedidoComentarios>['initial']
          }
          currentUserId={user.id}
        />
      )}

      <ContentCard
        header={
          <ContentCardTitle>
            <span className="inline-flex items-center gap-2">
              <History className="h-4 w-4" /> Histórico
            </span>
          </ContentCardTitle>
        }
      >
        {!eventos?.length ? (
          <p className="text-sm text-muted-foreground italic">Sem eventos.</p>
        ) : (
          <ol className="space-y-3">
            {eventos.map((ev) => {
              const usuario = ev.usuario as { full_name?: string | null } | null;
              return (
                <li key={ev.id} className="flex gap-3 text-sm">
                  <div className="w-2 h-2 rounded-full bg-franzoni-orange mt-1.5 shrink-0 ring-4 ring-franzoni-orange/15" />
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
      </ContentCard>
    </>
  );
}
