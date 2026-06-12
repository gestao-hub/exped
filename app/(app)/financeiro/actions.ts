'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { financeiroFormSchema, type FinanceiroFormInput } from '@/lib/validators/financeiro';

export type FinanceiroResult = { error: string } | { ok: true };

/**
 * Grava os campos conferidos pelo financeiro (pagamento + frete). Mantém o pedido
 * na fila do financeiro (status `em_financeiro`). Use `liberarParaLogisticaAction`
 * pra enviar pra logística.
 *
 * A transição/escopo é garantida por RLS (pedidos_financeiro_u: só financeiro,
 * só enquanto status='em_financeiro'). O `.eq('status','em_financeiro')` aqui é
 * a precondição atômica que evita corrida com outra mudança de status.
 */
export async function salvarFinanceiroAction(
  id: string,
  raw: FinanceiroFormInput,
): Promise<FinanceiroResult> {
  const supabase = await createClient();
  const parsed = financeiroFormSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos' };
  }
  const d = parsed.data;

  const { data, error } = await supabase
    .from('pedidos')
    .update({
      forma_pagamento: d.forma_pagamento ?? null,
      parcelas: d.parcelas ?? null,
      receber_na_entrega: d.receber_na_entrega ?? false,
      exige_emissao: d.exige_emissao ?? false,
      valor_total: d.valor_total,
      valor_frete: d.valor_frete ?? 0,
    })
    .eq('id', id)
    .eq('status', 'em_financeiro')
    .select('id')
    .single();
  if (error || !data) {
    return { error: error?.message ?? 'Pedido não encontrado ou não está no financeiro' };
  }

  revalidatePath('/financeiro');
  revalidatePath(`/financeiro/${id}`);
  return { ok: true };
}

/**
 * Libera o pedido pra logística: grava pagamento/frete e move o status de
 * `em_financeiro` → `pendente` (entra na fila da logística). Transição atômica.
 */
export async function liberarParaLogisticaAction(
  id: string,
  raw: FinanceiroFormInput,
): Promise<FinanceiroResult> {
  const supabase = await createClient();
  const parsed = financeiroFormSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos' };
  }
  const d = parsed.data;

  const { data, error } = await supabase
    .from('pedidos')
    .update({
      forma_pagamento: d.forma_pagamento ?? null,
      parcelas: d.parcelas ?? null,
      receber_na_entrega: d.receber_na_entrega ?? false,
      exige_emissao: d.exige_emissao ?? false,
      valor_total: d.valor_total,
      valor_frete: d.valor_frete ?? 0,
      status: 'pendente',
    })
    .eq('id', id)
    .eq('status', 'em_financeiro')
    .select('id')
    .single();
  if (error || !data) {
    return { error: error?.message ?? 'Pedido não encontrado ou não está no financeiro' };
  }

  revalidatePath('/financeiro');
  revalidatePath(`/financeiro/${id}`);
  revalidatePath('/logistica');
  return { ok: true };
}
