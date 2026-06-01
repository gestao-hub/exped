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
  referencia:     z.string().max(MID).nullable().optional(),
  saldo_estoque:  z.number().nullable().optional(),  // saldo no Hiper no momento da ingestão (snapshot)
});

export const pontoRetiradaSchema = z.object({
  id:           z.uuid().nullable().optional(),  // PK estável: presente ao editar; ausente ao criar ponto novo
  tipo:         z.enum(['loja', 'deposito', 'entrega']),
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
  valor_total:      z.number().nonnegative(),
  observacoes:      z.string().max(TEXT).nullable().optional(),
  storage_pdf_path: z.string().max(LONG).nullable().optional(),
  pontos_retirada:  z.array(pontoRetiradaSchema).min(1, 'Adicione ao menos 1 ponto de retirada').max(5),
});

export type PedidoFormInput = z.infer<typeof pedidoFormSchema>;
export type PontoRetiradaInput = z.infer<typeof pontoRetiradaSchema>;
export type ItemInput = z.infer<typeof itemSchema>;
