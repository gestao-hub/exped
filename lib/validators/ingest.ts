import { z } from 'zod';
import { pontoRetiradaSchema } from './pedido';

/**
 * Payload estruturado enviado pelo agente (campos vindos do banco do Hiper).
 * A EMPRESA NÃO vem aqui — é resolvida pelo token do dispositivo no endpoint.
 * O PAGAMENTO também não vem aqui — é extraído do PDF no endpoint.
 */
export const ingestPedidoSchema = z.object({
  documento_erp: z
    .string()
    .max(80)
    .regex(/^[A-Za-z0-9._-]+$/, 'documento_erp com caracteres inválidos')
    .nullable()
    .optional(),
  data_emissao: z.string().max(80).nullable().optional(),
  data_entrega: z.string().max(80).nullable().optional(),
  data_entrega_inicio: z.string().max(80).nullable().optional(),
  valor_frete: z.number().nonnegative().default(0),
  // NF-e (preenchida quando o pedido já foi faturado no Hiper)
  nf_numero: z.string().max(80).nullable().optional(),
  nf_chave: z.string().max(80).nullable().optional(),
  nf_emitida_em: z.string().max(80).nullable().optional(),
  nf_valor: z.number().nonnegative().nullable().optional(),
  hiper_usuario_id: z.number().int(),
  hiper_usuario_nome: z.string().max(250).nullable().optional(),
  cliente_codigo: z.string().max(80).nullable().optional(),
  cliente_nome: z.string().min(1).max(250),
  cliente_cnpj_cpf: z.string().max(80).nullable().optional(),
  cliente_endereco: z.string().max(1000).nullable().optional(),
  cliente_bairro: z.string().max(250).nullable().optional(),
  cliente_cidade: z.string().max(250).nullable().optional(),
  cliente_uf: z.string().max(2).nullable().optional(),
  cliente_cep: z.string().max(80).nullable().optional(),
  cliente_telefone: z.string().max(80).nullable().optional(),
  valor_total: z.number().nonnegative(),
  // Pagamento estruturado (só em pedido FINALIZADO no Hiper, via negociacao/finalizador).
  // Quando vier, tem precedência sobre o extraído do PDF (mais confiável).
  forma_pagamento: z.string().max(1000).nullable().optional(),
  parcelas: z.string().max(80).nullable().optional(),
  observacoes: z.string().max(5000).nullable().optional(),
  pontos_retirada: z.array(pontoRetiradaSchema).max(5),
});

export type IngestPedidoInput = z.infer<typeof ingestPedidoSchema>;
