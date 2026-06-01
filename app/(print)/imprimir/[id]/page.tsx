import { notFound } from 'next/navigation';
import { MapaCarregamento, type PontoComItens } from '@/components/mapa-carregamento';
import { createClient } from '@/lib/supabase/server';
import type { PedidoItem } from '@/lib/types';
import { AutoPrint, PrintControls } from './auto-print';

export const dynamic = 'force-dynamic';

export default async function ImprimirPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const [{ data: pedido }, { data: pontosRaw }, { data: logistica }] = await Promise.all([
    supabase.from('pedidos').select('*').eq('id', id).single(),
    supabase
      .from('pedido_pontos_retirada')
      .select('*, itens:pedido_itens(*)')
      .eq('pedido_id', id)
      .is('deleted_at', null)
      .is('itens.deleted_at', null)
      .order('ordem'),
    supabase.from('pedido_logistica').select('*').eq('pedido_id', id).maybeSingle(),
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

  return (
    <>
      <AutoPrint />
      <PrintControls />
      <MapaCarregamento
        pedido={pedido}
        pontos={pontos}
        logistica={logistica ?? undefined}
        vendedor={vendedor}
        mode="impressao"
      />
    </>
  );
}
