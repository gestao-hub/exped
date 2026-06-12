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
  /** Ponto-container "imediato" (sem destino) dos itens `modalidade==='imediato'`.
   *  Só carrega a PK pra UPDATE in-place; não tem empresa/endereço. */
  imediato?: DestinoInfo;
};

/**
 * Reconstrói o array `pontos_retirada` (a forma que a persistência espera) a partir
 * da lista achatada de itens + os dados dos destinos. Função PURA e determinística:
 *
 *  - itens `loja`      → vão para UM ponto `tipo='loja'` (empresa/endereço do destino loja).
 *  - itens `entrega`   → vão para UM ponto `tipo='entrega'` (endereço do destino entrega).
 *  - itens `imediato`  → vão para UM ponto `tipo='imediato'` (container SEM destino:
 *    empresa/endereço vazios). É um ponto real só pra ancorar os itens — não há
 *    `pedido_id` no item, então item sem ponto vira órfão e some ao salvar (data loss).
 *    O card Destino ignora o ponto imediato (não renderiza bloco pra ele).
 *
 * Só cria o ponto quando há ao menos 1 item daquela modalidade. A modalidade
 * original de cada item é preservada (a coluna do item é a fonte da verdade). A PK
 * do ponto (`id`) é preservada quando informada, pra UPDATE in-place.
 *
 * Casos de borda:
 *  - Pedido só com itens `imediato` → UM ponto `imediato` com os itens (NÃO um array
 *    vazio nem um ponto loja placeholder). Isso já satisfaz `pontos_retirada.min(1)`.
 */
export function sincronizarDestinos(input: SincronizarDestinosInput): PontoInput[] {
  const itens = input.itens ?? [];
  const pontos: PontoInput[] = [];

  const itensLoja = itens.filter((it) => it.modalidade === 'loja');
  const itensEntrega = itens.filter((it) => it.modalidade === 'entrega');
  const itensImediato = itens.filter((it) => it.modalidade === 'imediato');

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

  // Itens `imediato` vivem num ponto-container `imediato` (sem empresa/endereço) só
  // pra não virarem órfãos. A PK é preservada pra UPDATE in-place, como nos outros.
  if (itensImediato.length > 0) {
    pontos.push({
      id: input.imediato?.id ?? null,
      tipo: 'imediato',
      empresa_nome: '',
      endereco: null,
      itens: itensImediato,
    });
  }

  return pontos;
}

/**
 * Forma de trabalho do form (transitória, NÃO é o que vai pro banco): UM ponto
 * "loja" carregando TODOS os itens (a tabela única, a modalidade é por item) + UM
 * ponto "entrega" vazio só pra guardar os dados do destino de entrega (empresa/
 * endereço) e sua PK. No submit, `sincronizarDestinos` reconstrói os pontos reais.
 */
export type FormDestinos = {
  /** Ponto loja (index 0): empresa/endereço da loja + TODOS os itens. */
  loja: PontoInput;
  /** Ponto entrega (index 1): empresa/endereço do destino de entrega; itens vazio. */
  entrega: PontoInput;
  /** Ponto imediato (index 2): só guarda a PK do ponto-container imediato (sem
   *  empresa/endereço, itens vazio) pra UPDATE in-place no re-save. */
  imediato: PontoInput;
};

/**
 * Normaliza os `pontos_retirada` carregados (pedido novo, parseado, ou editado e já
 * dividido em loja+entrega) para a forma de trabalho do form. PURA.
 *
 *  - Junta TODOS os itens (de todos os pontos) numa única lista, no ponto loja.
 *  - Recupera o destino loja do 1º ponto loja/depósito existente (ou cria um vazio).
 *  - Recupera o destino entrega do 1º ponto entrega existente (ou cria um vazio).
 *  - Preserva os ids dos pontos (PK) pra UPDATE in-place na hora de salvar.
 *
 * A modalidade de cada item é mantida intacta (fonte da verdade); este normalizador
 * NÃO infere modalidade a partir do tipo do ponto (isso já foi feito no backfill da
 * migração / no parser, que gravam a coluna modalidade).
 */
export function normalizarParaForm(pontos: PontoInput[] | undefined): FormDestinos {
  const lista = pontos ?? [];
  // Junta TODOS os itens de TODOS os pontos (inclusive o imediato) na tabela única.
  // Cada item mantém sua própria modalidade (fonte da verdade), então um item imediato
  // já vem dobrado aqui com modalidade='imediato' — não some.
  const todosItens = lista.flatMap((p) => p?.itens ?? []);
  const pontoLoja = lista.find((p) => p?.tipo === 'loja' || p?.tipo === 'deposito');
  const pontoEntrega = lista.find((p) => p?.tipo === 'entrega');
  const pontoImediato = lista.find((p) => p?.tipo === 'imediato');

  return {
    loja: {
      id: pontoLoja?.id ?? null,
      tipo: 'loja',
      empresa_nome: pontoLoja?.empresa_nome ?? '',
      endereco: pontoLoja?.endereco ?? null,
      itens: todosItens,
    },
    entrega: {
      id: pontoEntrega?.id ?? null,
      tipo: 'entrega',
      empresa_nome: pontoEntrega?.empresa_nome ?? '',
      endereco: pontoEntrega?.endereco ?? null,
      itens: [],
    },
    imediato: {
      id: pontoImediato?.id ?? null,
      tipo: 'imediato',
      empresa_nome: '',
      endereco: null,
      itens: [],
    },
  };
}
