import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Printer, ArrowLeft } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { PageHeader } from '@/components/layout/page-header';
import { MapaCarregamento, type PontoComItens } from '@/components/mapa-carregamento';
import { PedidoComentarios } from '@/components/pedido-comentarios';
import { createClient } from '@/lib/supabase/server';
import { cn } from '@/lib/utils';
import type { PedidoItem } from '@/lib/types';

export default async function HistoricoDetail({
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
    { data: comentarios },
  ] = await Promise.all([
    supabase.from('pedidos').select('*').eq('id', id).single(),
    supabase
      .from('pedido_pontos_retirada')
      .select('*, itens:pedido_itens(*)')
      .eq('pedido_id', id)
      .is('deleted_at', null)
      .is('itens.deleted_at', null)
      .order('ordem'),
    supabase.from('pedido_logistica').select('*').eq('pedido_id', id).maybeSingle(),
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

  return (
    <>
      <PageHeader
        title={
          <>
            <span className="text-muted-foreground font-mono mr-2">#{pedido.numero_mapa}</span>
            {pedido.cliente_nome}
          </>
        }
        description="Pedido finalizado (somente leitura)."
        actions={
          <>
            <Link
              href="/historico"
              className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }))}
            >
              <ArrowLeft className="h-4 w-4 mr-1" /> Histórico
            </Link>
            <Link
              href={`/imprimir/${id}`}
              target="_blank"
              className={cn(buttonVariants({ variant: 'outline' }))}
            >
              <Printer className="h-4 w-4 mr-1" /> Imprimir
            </Link>
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
    </>
  );
}
