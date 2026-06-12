import type { PedidoFormInput, ItemInput } from '@/lib/validators/pedido';

type PontoInput = PedidoFormInput['pontos_retirada'][number];

/**
 * Dados de um destino que a UI mantém à parte dos itens (empresa/endereço + a PK
 * estável do ponto, quando ele já existe no banco). A modalidade do item é a fonte
 * da verdade; o destino é só "para onde" os itens daquela modalidade apontam.
 */
export type DestinoInfo = {
  /** PK do ponto no banco (presente ao editar; ausente ao criar). Preserva o id
   *  pra reconciliação fazer UPDATE in-place em vez de delete+insert. */
  id?: string | null;
  empresa_nome?: string | null;
  endereco?: string | null;
};

export type SincronizarDestinosInput = {
  /** Lista achatada de TODOS os itens do form (cada um com sua `modalidade`). */
  itens: ItemInput[];
  /** Destino "loja" (empresa de retirada). Usado pelos itens `modalidade==='loja'`. */
  loja?: DestinoInfo;
  /** Destino "entrega" (endereço do cliente). Nesta fase há UM único destino de
   *  entrega; multi-endereço é tratado numa task posterior. */
  entrega?: DestinoInfo;
};

/**
 * Reconstrói o array `pontos_retirada` (a forma que a persistência espera) a partir
 * da lista achatada de itens + os dados dos destinos. Função PURA e determinística:
 *
 *  - itens `loja`      → vão para UM ponto `tipo='loja'` (empresa/endereço do destino loja).
 *  - itens `entrega`   → vão para UM ponto `tipo='entrega'` (endereço do destino entrega).
 *  - itens `imediato`  → não entram em nenhum ponto (o `ponto_retirada_id` fica null).
 *
 * Só cria o ponto quando há ao menos 1 item daquela modalidade. A modalidade
 * original de cada item é preservada (a coluna do item é a fonte da verdade). A PK
 * do ponto (`id`) é preservada quando informada, pra UPDATE in-place.
 *
 * Casos de borda:
 *  - Pedido só com itens `imediato` → array de pontos VAZIO (sem destino). O chamador
 *    decide se isso é válido (a regra `pontos_retirada.min(1)` do schema é tratada no
 *    form garantindo ao menos 1 item não-imediato ou um ponto vazio de fallback).
 */
export function sincronizarDestinos(input: SincronizarDestinosInput): PontoInput[] {
  const itens = input.itens ?? [];
  const pontos: PontoInput[] = [];

  const itensLoja = itens.filter((it) => it.modalidade === 'loja');
  const itensEntrega = itens.filter((it) => it.modalidade === 'entrega');
  // itens `imediato` ficam de fora de propósito (ponto_retirada_id null).

  if (itensLoja.length > 0) {
    pontos.push({
      id: input.loja?.id ?? null,
      tipo: 'loja',
      empresa_nome: input.loja?.empresa_nome ?? '',
      endereco: input.loja?.endereco ?? null,
      itens: itensLoja,
    });
  }

  if (itensEntrega.length > 0) {
    pontos.push({
      id: input.entrega?.id ?? null,
      tipo: 'entrega',
      empresa_nome: input.entrega?.empresa_nome ?? '',
      endereco: input.entrega?.endereco ?? null,
      itens: itensEntrega,
    });
  }

  return pontos;
}
