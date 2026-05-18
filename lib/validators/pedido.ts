import { z } from 'zod';

export const itemSchema = z.object({
  codigo:         z.string(),
  descricao:      z.string().min(1, 'Descrição obrigatória'),
  quantidade:     z.number().nonnegative(),
  unidade:        z.string(),
  preco_unitario: z.number().nonnegative(),
  desconto:       z.number().nonnegative(),
  total:          z.number().nonnegative(),
  referencia:     z.string().nullable().optional(),
});

export const pontoRetiradaSchema = z.object({
  tipo:         z.enum(['loja', 'deposito']),
  empresa_nome: z.string(),
  endereco:     z.string().nullable().optional(),
  itens:        z.array(itemSchema),
});

export const pedidoFormSchema = z.object({
  documento_erp:    z.string().nullable().optional(),
  data_emissao:     z.string().nullable().optional(),
  data_entrega:     z.string().nullable().optional(),
  cliente_codigo:   z.string().nullable().optional(),
  cliente_nome:     z.string().min(1, 'Nome do cliente obrigatório'),
  cliente_cnpj_cpf: z.string().nullable().optional(),
  cliente_endereco: z.string().nullable().optional(),
  cliente_bairro:   z.string().nullable().optional(),
  cliente_cidade:   z.string().nullable().optional(),
  cliente_uf:       z.string().max(2).nullable().optional(),
  cliente_cep:      z.string().nullable().optional(),
  cliente_telefone: z.string().nullable().optional(),
  forma_pagamento:  z.string().nullable().optional(),
  parcelas:         z.string().nullable().optional(),
  valor_total:      z.number().nonnegative(),
  observacoes:      z.string().nullable().optional(),
  storage_pdf_path: z.string().nullable().optional(),
  pontos_retirada:  z.array(pontoRetiradaSchema).min(1, 'Adicione ao menos 1 ponto de retirada'),
});

export type PedidoFormInput = z.infer<typeof pedidoFormSchema>;
export type PontoRetiradaInput = z.infer<typeof pontoRetiradaSchema>;
export type ItemInput = z.infer<typeof itemSchema>;
