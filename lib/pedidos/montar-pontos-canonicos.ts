import { sincronizarDestinos, type DestinoInfo } from '@/lib/pedidos/sincronizar-destinos';
import type { PedidoFormInput } from '@/lib/validators/pedido';

/**
 * Destino de entrega POR ENDEREÇO que o form mantém à parte dos itens (multi-endereço).
 * Casa com o `endereco_entrega_id` dos itens `entrega`. `id` = PK do ponto entrega no
 * banco (presente ao recarregar, pra UPDATE in-place; null pra destino novo).
 */
export type EntregaDestino = {
  enderecoId: string;
  id: string | null;
  empresa_nome: string;
  endereco: string | null;
};

/**
 * Monta os `pontos_retirada` CANÔNICOS (a forma que a persistência espera) a partir da
 * forma de trabalho do form (loja[0] carrega TODOS os itens, entrega[1] = destino padrão,
 * imediato[2] = container) + os destinos por-endereço. Função PURA e determinística:
 * NÃO grava em estado nenhum — só transforma a entrada na saída.
 *
 * Pureza é o coração do fix de re-save (revisão): isto roda SÓ no onValid do handleSubmit
 * (depois da validação passar), com os `values` já validados — NUNCA antes. O rebuild
 * antigo reescrevia `pontos_retirada` no estado e, se a validação falhasse, a forma de
 * trabalho colapsava (só os itens loja no índice 0); no re-save os itens entrega/imediato
 * eram descartados silenciosamente (perda de dado que ainda se propagava pelo sync no modo
 * edit). Mantendo isto puro e fora do estado, a forma de trabalho permanece íntegra entre
 * tentativas de submit. Extraído do componente pra ser coberto por teste (vitest, sem DOM).
 */
export function montarPontosCanonicos(
  values: PedidoFormInput,
  entregaDestinos: EntregaDestino[],
): PedidoFormInput['pontos_retirada'] {
  const trabalho = values.pontos_retirada ?? [];
  const lojaInfo = trabalho[0];
  const entregaInfo = trabalho[1];
  const imediatoInfo = trabalho[2];
  const itens = lojaInfo?.itens ?? [];

  return sincronizarDestinos({
    itens,
    loja: { id: lojaInfo?.id, empresa_nome: lojaInfo?.empresa_nome, endereco: lojaInfo?.endereco },
    // Destino de entrega PADRÃO: itens `entrega` sem `endereco_entrega_id` caem aqui.
    entrega: {
      id: entregaInfo?.id,
      empresa_nome: entregaInfo?.empresa_nome,
      endereco: entregaInfo?.endereco,
    },
    // Destinos de entrega POR ENDEREÇO (multi-endereço): cada item `entrega` com
    // `endereco_entrega_id` é agrupado e ligado ao destino cujo enderecoId casa.
    entregas: entregaDestinos.map(
      (d): DestinoInfo => ({
        id: d.id,
        enderecoId: d.enderecoId,
        empresa_nome: d.empresa_nome,
        endereco: d.endereco,
      }),
    ),
    // Carrega a PK do ponto-container imediato (se já existia) pra UPDATE in-place.
    imediato: { id: imediatoInfo?.id },
  });
}
