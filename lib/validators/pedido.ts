import { z } from 'zod';
import { FORMAS_PAGAMENTO } from '@/lib/parser/forma-pagamento';

/**
 * Limites de tamanho — propósito é defender contra parser que retorna
 * "wall of text" gravando lixo. Valores generosos para uso real,
 * apertados o suficiente para barrar corrupção óbvia.
 */
const SHORT = 80;     // código, UF, cep
const MID   = 250;    // nome, bairro, cidade, cnpj, telefone, descrição item
const LONG  = 1000;   // endereço, forma_pagto + parcelas
const TEXT  = 5000;   // observação livre

export const itemSchema = z.object({
  // PK estável: presente ao editar (UPDATE in-place); ausente ao criar item novo (INSERT).
  // O form normaliza '' → null no register (setValueAs), então aqui aceitamos null/undefined.
  id:             z.uuid().nullable().optional(),
  codigo:         z.string().max(SHORT, 'Código muito longo'),
  descricao:      z.string().min(1, 'Descrição obrigatória').max(MID, 'Descrição muito longa'),
  quantidade:     z.number().nonnegative(),
  unidade:        z.string().max(SHORT),
  preco_unitario: z.number().nonnegative(),
  desconto:       z.number().nonnegative(),
  total:          z.number().nonnegative(),
  // Fonte da verdade de como o cliente recebe o item (substitui o "modo de retirada" global).
  // Obrigatório aqui (o form/parser sempre setam). O agente Hiper NÃO envia esse campo, então
  // o endpoint de ingestão injeta `modalidade='loja'` por item ANTES de validar contra este
  // schema (ver app/api/ingest/pedido/route.ts) — mantém retrocompat sem afrouxar o schema.
  modalidade:     z.enum(['imediato', 'loja', 'entrega']),
  // Campo APENAS-DO-FORM (transitório, NÃO persistido em pedido_itens — essa tabela não
  // tem essa coluna; o endereço vive no PONTO de entrega). Roteia itens `entrega` para
  // destinos distintos: itens com endereco_entrega_id diferente viram pontos `entrega`
  // distintos (multi-endereço). null/ausente = destino de entrega padrão. O valor é a
  // PK do `cliente_enderecos` escolhido (ou a PK do ponto, ao recarregar um pedido salvo).
  endereco_entrega_id: z.string().nullable().optional(),
  referencia:     z.string().max(MID).nullable().optional(),
  saldo_estoque:  z.number().nullable().optional(),  // saldo no Hiper no momento da ingestão (snapshot)
});

export const pontoRetiradaSchema = z.object({
  id:           z.uuid().nullable().optional(),  // PK estável: presente ao editar; ausente ao criar ponto novo
  // 'imediato' = ponto-container dos itens balcão (sem empresa/endereço). Itens só se
  // ligam ao pedido via ponto; um item imediato precisa de um ponto pra não virar órfão.
  tipo:         z.enum(['loja', 'deposito', 'entrega', 'imediato']),
  empresa_nome: z.string().max(MID),
  endereco:     z.string().max(LONG).nullable().optional(),
  itens:        z.array(itemSchema).max(500, 'Mais de 500 itens — provável erro de parse'),
});

export const pedidoFormSchema = z.object({
  documento_erp:    z.string().max(SHORT).nullable().optional(),
  data_emissao:     z.string().max(SHORT).nullable().optional(),
  data_entrega:     z.string().max(SHORT).nullable().optional(),
  data_entrega_inicio: z.string().max(SHORT).nullable().optional(),
  valor_frete:      z.number().nonnegative().nullable().optional(),
  nf_numero:        z.string().max(SHORT).nullable().optional(),
  nf_chave:         z.string().max(SHORT).nullable().optional(),
  nf_emitida_em:    z.string().max(SHORT).nullable().optional(),
  nf_valor:         z.number().nonnegative().nullable().optional(),
  cliente_codigo:   z.string().max(SHORT).nullable().optional(),
  cliente_nome:     z.string().min(1, 'Nome do cliente obrigatório').max(MID),
  cliente_cnpj_cpf: z.string().max(SHORT).nullable().optional(),
  cliente_endereco: z.string().max(LONG).nullable().optional(),
  cliente_bairro:   z.string().max(MID, 'Bairro muito longo — provável erro de parse').nullable().optional(),
  cliente_cidade:   z.string().max(MID).nullable().optional(),
  cliente_uf:       z.string().max(2).nullable().optional(),
  cliente_cep:      z.string().max(SHORT).nullable().optional(),
  cliente_telefone: z.string().max(SHORT).nullable().optional(),
  cliente_endereco_id: z.uuid().nullable().optional(),
  forma_pagamento:  z.enum(FORMAS_PAGAMENTO).nullable().optional(),
  parcelas:         z.number().int().min(1).max(12).nullable().optional(),
  // Independente da forma: marca que o valor é recebido na entrega (ex.: motorista cobra).
  receber_na_entrega: z.boolean().optional(),
  valor_total:      z.number().nonnegative(),
  observacoes:      z.string().max(TEXT).nullable().optional(),
  storage_pdf_path: z.string().max(LONG).nullable().optional(),
  // `pontos_retirada` é mantido (a UI ainda monta destinos numa fase posterior), mas a
  // antiga regra "cada ponto com itens" foi removida: a modalidade agora vive POR ITEM
  // (fonte da verdade) e o vínculo é item→destino, não item-dentro-do-ponto. Um ponto é
  // só um destino e pode existir sem itens aninhados.
  pontos_retirada:  z.array(pontoRetiradaSchema).min(1, 'Adicione ao menos 1 ponto de retirada').max(5),
});

export type PedidoFormInput = z.infer<typeof pedidoFormSchema>;
export type PontoRetiradaInput = z.infer<typeof pontoRetiradaSchema>;
export type ItemInput = z.infer<typeof itemSchema>;
