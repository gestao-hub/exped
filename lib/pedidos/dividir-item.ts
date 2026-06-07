import type { ItemInput } from '@/lib/validators/pedido';

/** Arredonda pra 2 casas (centavos). */
export function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Divide um item de pedido em duas partes pra mover entre pontos (Loja ↔ Entrega
 * no modo híbrido):
 *  - `movido`: a quantidade `n` que vai pro outro ponto. id=null (linha NOVA lá).
 *  - `restante`: o que sobra no ponto atual (mesmo id), ou null se moveu tudo.
 * Desconto e total são rateados proporcionalmente à quantidade (preço unitário
 * preservado). `n` é limitado a [0, quantidade].
 */
export function dividirItem(
  item: ItemInput,
  n: number,
): { movido: ItemInput; restante: ItemInput | null } {
  const q = Number(item.quantidade) || 0;
  const nMover = Math.max(0, Math.min(Number(n) || 0, q));
  const unit = Number(item.preco_unitario) || 0;
  const desc = Number(item.desconto) || 0;
  const descMovido = q > 0 ? round2(desc * (nMover / q)) : 0;
  const descRestante = round2(desc - descMovido);

  const movido: ItemInput = {
    ...item,
    id: null,
    quantidade: nMover,
    desconto: descMovido,
    total: round2(nMover * unit - descMovido),
  };
  const restante: ItemInput | null =
    q - nMover > 0
      ? {
          ...item,
          quantidade: q - nMover,
          desconto: descRestante,
          total: round2((q - nMover) * unit - descRestante),
        }
      : null;
  return { movido, restante };
}

/**
 * Mescla `movido` na lista de itens do ponto-alvo: se já existe um item com o
 * MESMO código (não vazio) e mesmo preço unitário, soma quantidade/desconto/total
 * nele; senão, adiciona como nova linha. Muta e retorna `alvo` (cópia feita pelo
 * chamador).
 */
export function mesclarItem(alvo: ItemInput[], movido: ItemInput): ItemInput[] {
  const cod = (movido.codigo ?? '').trim();
  const i = cod
    ? alvo.findIndex(
        (it) =>
          (it.codigo ?? '').trim() === cod &&
          Number(it.preco_unitario) === Number(movido.preco_unitario),
      )
    : -1;
  if (i >= 0) {
    const ex = alvo[i];
    alvo[i] = {
      ...ex,
      quantidade: (Number(ex.quantidade) || 0) + (Number(movido.quantidade) || 0),
      desconto: round2((Number(ex.desconto) || 0) + (Number(movido.desconto) || 0)),
      total: round2((Number(ex.total) || 0) + (Number(movido.total) || 0)),
    };
  } else {
    alvo.push(movido);
  }
  return alvo;
}
