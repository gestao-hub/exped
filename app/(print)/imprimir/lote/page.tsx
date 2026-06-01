import { redirect } from 'next/navigation';
import { MapaCarregamento, type PontoComItens } from '@/components/mapa-carregamento';
import { createClient } from '@/lib/supabase/server';
import { AutoPrint, PrintControls } from '../[id]/auto-print';
import type { PedidoItem } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * GET /imprimir/lote?ids=uuid1,uuid2,uuid3
 * Renderiza todos os mapas em sequência (com quebra de página entre).
 * Dispara window.print() automaticamente após carregar.
 */
export default async function ImprimirLotePage({
  searchParams,
}: {
  searchParams: Promise<{ ids?: string }>;
}) {
  const sp = await searchParams;
  const ids = (sp.ids ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[0-9a-f-]{36}$/i.test(s))
    .slice(0, 100);

  if (ids.length === 0) redirect('/logistica');

  const supabase = await createClient();

  const [{ data: pedidos }, { data: pontosRaw }, { data: logisticas }] = await Promise.all([
    supabase.from('pedidos').select('*').in('id', ids),
    supabase
      .from('pedido_pontos_retirada')
      .select('*, itens:pedido_itens(*)')
      .in('pedido_id', ids)
      .is('deleted_at', null)
      .is('itens.deleted_at', null)
      .order('ordem'),
    supabase.from('pedido_logistica').select('*').in('pedido_id', ids),
  ]);

  // Indexa por pedido_id pra montagem rápida
  const pontosByPedido = new Map<string, PontoComItens[]>();
  for (const p of (pontosRaw ?? []) as Array<{
    id: string;
    pedido_id: string;
    itens?: PedidoItem[];
  }>) {
    const arr = pontosByPedido.get(p.pedido_id) ?? [];
    arr.push({
      ...(p as unknown as PontoComItens),
      itens: ((p.itens ?? []) as PedidoItem[]).sort(
        (a, b) => (a.ordem ?? 0) - (b.ordem ?? 0),
      ),
    });
    pontosByPedido.set(p.pedido_id, arr);
  }

  const logisticaByPedido = new Map<string, unknown>();
  for (const l of (logisticas ?? []) as Array<{ pedido_id: string }>) {
    logisticaByPedido.set(l.pedido_id, l);
  }

  // Preserva ordem da query string (ids vieram da seleção do usuário)
  const ordered = ids
    .map((id) => (pedidos ?? []).find((p) => (p as { id: string }).id === id))
    .filter(Boolean) as Array<Record<string, unknown> & { id: string }>;

  return (
    <>
      <AutoPrint />
      <PrintControls />
      {ordered.length === 0 ? (
        <p className="p-8 text-sm">Nenhum pedido encontrado.</p>
      ) : (
        <div>
          {ordered.map((pedido, idx) => {
            const pontos = pontosByPedido.get(pedido.id) ?? [];
            const log = logisticaByPedido.get(pedido.id);
            return (
              <div
                key={pedido.id}
                className={idx > 0 ? 'print-break-before' : ''}
              >
                <MapaCarregamento
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  pedido={pedido as any}
                  pontos={pontos}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  logistica={(log as any) ?? undefined}
                  mode="impressao"
                />
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
