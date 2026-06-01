import type { PedidoFormInput } from '@/lib/validators/pedido';

type PontoInput = PedidoFormInput['pontos_retirada'][number];
type ItemInput = PontoInput['itens'][number];

/**
 * Estado existente no banco (apenas o que precisamos pra reconciliar): cada ponto
 * com seu id e a lista de itens (id + ordem mínima irrelevante).
 */
export type ExistingPonto = {
  id: string;
  itens: { id: string }[];
};

/** Operação resolvida pra um item. */
export type ItemOp =
  | { kind: 'update'; id: string; ordem: number; data: ItemInput }
  | { kind: 'insert'; ordem: number; data: ItemInput }
  | { kind: 'softDelete'; id: string };

/** Operação resolvida pra um ponto + seus itens. */
export type PontoOp =
  | { kind: 'update'; id: string; ordem: number; data: PontoInput; itens: ItemOp[] }
  | { kind: 'insert'; ordem: number; data: PontoInput; itens: ItemOp[] }
  | { kind: 'softDelete'; id: string; itens: ItemOp[] };

export type ReconcileResult = {
  pontos: PontoOp[];
};

/**
 * Reconciliação PURA de filhos (pontos + itens) entre o que existe no banco e o
 * que veio no payload do form. Implementa a estratégia de PK estável:
 *
 *  - com `id` que ainda veio no payload  → UPDATE in-place (preserva o id)
 *  - sem `id`                            → INSERT (novo)
 *  - id que existia no banco e NÃO veio  → soft-delete (set deleted_at)
 *
 * A `ordem` é recomputada pela posição no array de entrada (0-based), tanto pra
 * update quanto pra insert, mantendo a ordenação do form.
 *
 * `incoming` são os pontos do form já validados (cada um pode ter `id` opcional;
 * idem cada item).
 */
export function reconcileChildren(
  existing: ExistingPonto[],
  incoming: PontoInput[],
): ReconcileResult {
  const existingPontoById = new Map(existing.map((p) => [p.id, p]));
  const seenPontoIds = new Set<string>();
  const pontos: PontoOp[] = [];

  incoming.forEach((ponto, idx) => {
    const pontoId = ponto.id ?? null;
    const matched = pontoId ? existingPontoById.get(pontoId) : undefined;

    if (matched) {
      seenPontoIds.add(matched.id);
      pontos.push({
        kind: 'update',
        id: matched.id,
        ordem: idx,
        data: ponto,
        itens: reconcileItens(matched.itens, ponto.itens),
      });
    } else {
      // sem id, ou id que não existe mais no banco → trata como novo
      pontos.push({
        kind: 'insert',
        ordem: idx,
        data: ponto,
        // ponto novo: itens nunca casam com existentes; itens com id "fantasma"
        // viram insert também (existing vazio).
        itens: reconcileItens([], ponto.itens),
      });
    }
  });

  // pontos que existiam e não vieram → soft-delete (e seus itens junto)
  for (const ex of existing) {
    if (!seenPontoIds.has(ex.id)) {
      pontos.push({
        kind: 'softDelete',
        id: ex.id,
        itens: ex.itens.map((it) => ({ kind: 'softDelete' as const, id: it.id })),
      });
    }
  }

  return { pontos };
}

function reconcileItens(existing: { id: string }[], incoming: ItemInput[]): ItemOp[] {
  const existingById = new Map(existing.map((it) => [it.id, it]));
  const seen = new Set<string>();
  const ops: ItemOp[] = [];

  incoming.forEach((item, idx) => {
    const itemId = item.id ?? null;
    const matched = itemId ? existingById.get(itemId) : undefined;
    if (matched) {
      seen.add(matched.id);
      ops.push({ kind: 'update', id: matched.id, ordem: idx, data: item });
    } else {
      ops.push({ kind: 'insert', ordem: idx, data: item });
    }
  });

  for (const ex of existing) {
    if (!seen.has(ex.id)) ops.push({ kind: 'softDelete', id: ex.id });
  }

  return ops;
}
