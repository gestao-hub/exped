import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { PageHeader } from '@/components/layout/page-header';
import { StatusBadge } from '@/components/status-badge';
import { MapaCarregamento, type PontoComItens } from '@/components/mapa-carregamento';
import { ImprimirPedidoButton } from '@/components/imprimir-pedido-button';
import { PedidoComentarios } from '@/components/pedido-comentarios';
import { createClient } from '@/lib/supabase/server';
import { cn } from '@/lib/utils';
import type { PedidoItem } from '@/lib/types';
import { FinanceiroForm } from './financeiro-form';

export default async function FinanceiroDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const [{ data: pedido }, { data: pontosRaw }, { data: comentarios }] = await Promise.all([
    supabase.from('pedidos').select('*').eq('id', id).single(),
    supabase
      .from('pedido_pontos_retirada')
      .select('*, itens:pedido_itens(*)')
      .eq('pedido_id', id)
      .is('deleted_at', null)
      .is('itens.deleted_at', null)
      .order('ordem'),
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

  const { data: empresa } = await supabase
    .from('empresas')
    .select('logo_url_print')
    .eq('id', pedido.empresa_id)
    .maybeSingle();

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
        description={
          <span className="inline-flex items-center gap-2">
            <StatusBadge status={pedido.status} />
            {pedido.cliente_bairro && (
              <span className="text-xs">· bairro {pedido.cliente_bairro}</span>
            )}
          </span>
        }
        actions={
          <>
            <Link
              href="/financeiro"
              className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }))}
            >
              <ArrowLeft className="h-4 w-4 mr-1" /> Caixa
            </Link>
            <ImprimirPedidoButton id={id} label="Imprimir Pedido" />
          </>
        }
      />

      <MapaCarregamento
        pedido={pedido}
        pontos={pontos}
        vendedor={vendedor}
        logoUrlPrint={empresa?.logo_url_print ?? null}
      />

      <FinanceiroForm
        pedidoId={id}
        status={pedido.status}
        defaultValues={{
          forma_pagamento: pedido.forma_pagamento,
          parcelas: pedido.parcelas,
          receber_na_entrega: pedido.receber_na_entrega,
          exige_emissao: pedido.exige_emissao,
          valor_total: Number(pedido.valor_total),
          valor_frete: Number(pedido.valor_frete ?? 0),
        }}
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
