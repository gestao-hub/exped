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
  /** Chave de roteamento do endereço deste destino de entrega — casa com o
   *  `endereco_entrega_id` dos itens. É a PK do `cliente_enderecos` escolhido (ou a
   *  PK do ponto, ao recarregar). Usado SÓ por destinos de entrega multi-endereço. */
  enderecoId?: string | null;
  empresa_nome?: string | null;
  endereco?: string | null;
};

export type SincronizarDestinosInput = {
  /** Lista achatada de TODOS os itens do form (cada um com sua `modalidade`). */
  itens: ItemInput[];
  /** Destino "loja" (empresa de retirada). Usado pelos itens `modalidade==='loja'`. */
  loja?: DestinoInfo;
  /** Destino de entrega PADRÃO — usado por itens `entrega` SEM `endereco_entrega_id`
   *  (null/ausente). Cobre o fluxo simples de UM endereço de entrega. */
  entrega?: DestinoInfo;
  /** Destinos de entrega POR ENDEREÇO (multi-endereço). Cada item `entrega` com um
   *  `endereco_entrega_id` é agrupado e ligado ao destino cujo `enderecoId` casa,
   *  emitindo UM ponto `entrega` por endereço distinto em uso. */
  entregas?: DestinoInfo[];
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

  // Itens `entrega` viram UM ponto `entrega` POR endereço distinto (multi-endereço):
  // agrupa por `endereco_entrega_id` (null/ausente = destino padrão `input.entrega`),
  // preservando a ordem de primeira ocorrência. Cada grupo casa com o destino cujo
  // `enderecoId` bate (pra herdar PK + empresa + endereço); o grupo padrão usa
  // `input.entrega`. Itens distintos podem ir para endereços distintos.
  if (itensEntrega.length > 0) {
    const grupos = new Map<string | null, ItemInput[]>();
    for (const it of itensEntrega) {
      const key = it.endereco_entrega_id ?? null;
      const arr = grupos.get(key);
      if (arr) arr.push(it);
      else grupos.set(key, [it]);
    }
    const entregasPorId = new Map<string, DestinoInfo>();
    for (const d of input.entregas ?? []) {
      if (d.enderecoId != null) entregasPorId.set(d.enderecoId, d);
    }
    for (const [key, itensDoGrupo] of grupos) {
      // Grupo sem endereço (key=null) → destino padrão `input.entrega`. Com endereço →
      // casa por `enderecoId` em `input.entregas`; se não houver match (ex.: fluxo
      // de UM endereço que só passou `input.entrega`), cai pro destino padrão.
      const destino: DestinoInfo | undefined =
        key == null ? input.entrega : entregasPorId.get(key) ?? input.entrega;
      pontos.push({
        id: destino?.id ?? null,
        tipo: 'entrega',
        empresa_nome: destino?.empresa_nome ?? '',
        endereco: destino?.endereco ?? null,
        itens: itensDoGrupo,
      });
    }
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
/** Um destino de entrega recuperado da carga (multi-endereço): a PK do ponto + o
 *  endereço + a chave de roteamento (`endereco_entrega_id`) que os itens daquele
 *  destino carregam. O form lista esses destinos no card e re-passa pra sincronizar. */
export type FormEntregaDestino = {
  /** PK do ponto `entrega` no banco (pra UPDATE in-place). */
  id?: string | null;
  /** Chave de roteamento — casa com o `endereco_entrega_id` dos itens deste destino. */
  endereco_entrega_id: string | null;
  empresa_nome: string;
  endereco: string | null;
};

export type FormDestinos = {
  /** Ponto loja (index 0): empresa/endereço da loja + TODOS os itens. Cada item
   *  `entrega` vem com seu `endereco_entrega_id` setado (roteamento multi-endereço). */
  loja: PontoInput;
  /** Ponto entrega (index 1): destino de entrega PADRÃO (1º ponto entrega carregado),
   *  só pra back-compat do fluxo de UM endereço; itens vazio. */
  entrega: PontoInput;
  /** Ponto imediato (index 2): só guarda a PK do ponto-container imediato (sem
   *  empresa/endereço, itens vazio) pra UPDATE in-place no re-save. */
  imediato: PontoInput;
  /** TODOS os destinos de entrega carregados (multi-endereço), 1 por ponto `entrega`.
   *  Cada um traz sua PK + endereço + a chave de roteamento dos seus itens. */
  entregas: FormEntregaDestino[];
};

/**
 * Normaliza os `pontos_retirada` carregados (pedido novo, parseado, ou editado e já
 * dividido em loja+entrega[+entrega…]) para a forma de trabalho do form. PURA.
 *
 *  - Junta TODOS os itens (de todos os pontos) numa única lista, no ponto loja.
 *  - Recupera o destino loja do 1º ponto loja/depósito existente (ou cria um vazio).
 *  - Recupera CADA ponto entrega como um destino (multi-endereço), com sua PK.
 *  - Carimba cada item `entrega` com o `endereco_entrega_id` (chave de roteamento) do
 *    ponto de onde ele veio, pra que o re-save reagrupe os itens nos mesmos destinos.
 *  - Preserva os ids dos pontos (PK) pra UPDATE in-place na hora de salvar.
 *
 * Chave de roteamento: como `pedido_pontos_retirada` não tem coluna de id-de-endereço,
 * usamos a própria PK do ponto entrega como `endereco_entrega_id` ao recarregar. Assim
 * o agrupamento no re-save é estável e determinístico (round-trip preserva os destinos).
 *
 * A modalidade de cada item é mantida intacta (fonte da verdade); este normalizador
 * NÃO infere modalidade a partir do tipo do ponto (isso já foi feito no backfill da
 * migração / no parser, que gravam a coluna modalidade).
 */
export function normalizarParaForm(pontos: PontoInput[] | undefined): FormDestinos {
  const lista = pontos ?? [];
  const pontoLoja = lista.find((p) => p?.tipo === 'loja' || p?.tipo === 'deposito');
  const pontosEntrega = lista.filter((p) => p?.tipo === 'entrega');
  const pontoImediato = lista.find((p) => p?.tipo === 'imediato');

  // Junta TODOS os itens de TODOS os pontos na tabela única. Itens vindos de um ponto
  // `entrega` são carimbados com a chave de roteamento daquele ponto (a PK do ponto),
  // pra reagrupar nos mesmos destinos ao salvar. Itens de outros pontos ficam sem chave.
  const todosItens: ItemInput[] = [];
  for (const p of lista) {
    if (!p) continue;
    const chave = p.tipo === 'entrega' ? routingKey(p) : null;
    for (const it of p.itens ?? []) {
      todosItens.push(chave != null ? { ...it, endereco_entrega_id: chave } : it);
    }
  }

  // Um destino de entrega por ponto `entrega` carregado (multi-endereço).
  const entregas: FormEntregaDestino[] = pontosEntrega.map((p) => ({
    id: p?.id ?? null,
    endereco_entrega_id: routingKey(p),
    empresa_nome: p?.empresa_nome ?? '',
    endereco: p?.endereco ?? null,
  }));

  const primeiroEntrega = pontosEntrega[0];

  return {
    loja: {
      id: pontoLoja?.id ?? null,
      tipo: 'loja',
      empresa_nome: pontoLoja?.empresa_nome ?? '',
      endereco: pontoLoja?.endereco ?? null,
      itens: todosItens,
    },
    entrega: {
      id: primeiroEntrega?.id ?? null,
      tipo: 'entrega',
      empresa_nome: primeiroEntrega?.empresa_nome ?? '',
      endereco: primeiroEntrega?.endereco ?? null,
      itens: [],
    },
    imediato: {
      id: pontoImediato?.id ?? null,
      tipo: 'imediato',
      empresa_nome: '',
      endereco: null,
      itens: [],
    },
    entregas,
  };
}

/**
 * Chave de roteamento estável de um ponto `entrega` carregado. Prefere a PK do ponto
 * (uuid, sempre presente em ponto já salvo). Sem PK (caso raro de ponto não persistido),
 * cai pro endereço como chave — garante que itens do mesmo endereço agrupem juntos.
 */
function routingKey(p: PontoInput | undefined): string {
  return (p?.id ?? p?.endereco ?? '') as string;
}
