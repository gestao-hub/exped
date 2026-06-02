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
import { BaixaForm } from './baixa-form';
import { emptyLogistica } from '@/lib/validators/logistica';

export default async function LogisticaDetailPage({
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

  const defaults = logistica
    ? {
        pre_carga: logistica.pre_carga,
        motorista: logistica.motorista,
        veiculo: logistica.veiculo,
        km_inicial: logistica.km_inicial,
        km_final: logistica.km_final,
        regiao: logistica.regiao,
        peso_bruto_total: logistica.peso_bruto_total,
        peso_liquido_total: logistica.peso_liquido_total,
        conferente: logistica.conferente,
        observacoes: logistica.observacoes,
      }
    : emptyLogistica();

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
              href="/logistica"
              className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }))}
            >
              <ArrowLeft className="h-4 w-4 mr-1" /> Fila
            </Link>
            <ImprimirPedidoButton id={id} label="Imprimir Pedido" />
          </>
        }
      />

      <MapaCarregamento
        pedido={pedido}
        pontos={pontos}
        logistica={logistica ?? undefined}
        vendedor={vendedor}
        logoUrlPrint={empresa?.logo_url_print ?? null}
      />

      <BaixaForm
        pedidoId={id}
        status={pedido.status}
        defaultValues={defaults}
        itens={pontos.flatMap((p) => p.itens)}
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
