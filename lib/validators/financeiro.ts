import { z } from 'zod';
import { FORMAS_PAGAMENTO } from '@/lib/parser/forma-pagamento';

/**
 * Campos que o financeiro confere/edita antes de liberar o pedido pra logística:
 * pagamento (forma, parcelas, receber na entrega, valor total) e o frete.
 */
export const financeiroFormSchema = z.object({
  forma_pagamento:    z.enum(FORMAS_PAGAMENTO).nullable().optional(),
  parcelas:           z.number().int().min(1).max(12).nullable().optional(),
  receber_na_entrega: z.boolean().optional(),
  valor_total:        z.number().nonnegative(),
  valor_frete:        z.number().nonnegative().nullable().optional(),
});

export type FinanceiroFormInput = z.infer<typeof financeiroFormSchema>;
