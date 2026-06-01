import { notFound, redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { pedidoRowsToFormInput } from '@/lib/pedidos/from-db';
import { RevisarClient } from './revisar-client';

export default async function RevisarPedidoPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const [{ data: pedido }, { data: pontos }] = await Promise.all([
    supabase.from('pedidos').select('*').eq('id', id).single(),
    supabase
      .from('pedido_pontos_retirada')
      .select('*, itens:pedido_itens(*)')
      .eq('pedido_id', id)
      .is('deleted_at', null)
      .is('itens.deleted_at', null)
      .order('ordem'),
  ]);
  if (!pedido) notFound();
  // Só faz sentido revisar rascunho; senão manda pra visão normal.
  if (pedido.status !== 'rascunho') redirect(`/vendas/${id}`);

  const defaults = pedidoRowsToFormInput(
    pedido as Parameters<typeof pedidoRowsToFormInput>[0],
    (pontos ?? []) as Parameters<typeof pedidoRowsToFormInput>[1],
  );

  return <RevisarClient id={id} defaults={defaults} />;
}
