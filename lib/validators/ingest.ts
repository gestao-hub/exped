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
  observacoes: z.string().max(5000).nullable().optional(),
  pontos_retirada: z.array(pontoRetiradaSchema).max(5),
});

export type IngestPedidoInput = z.infer<typeof ingestPedidoSchema>;
