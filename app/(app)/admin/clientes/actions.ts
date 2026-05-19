'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';

const clienteSchema = z.object({
  id:              z.uuid(),
  nome:            z.string().min(1, 'Nome obrigatório').max(250),
  cnpj_cpf:        z.string().max(80).nullable().optional(),
  codigo_erp:      z.string().max(80).nullable().optional(),
  endereco_padrao: z.string().max(1000).nullable().optional(),
  bairro_padrao:   z.string().max(250).nullable().optional(),
  cidade_padrao:   z.string().max(250).nullable().optional(),
  uf_padrao:       z.string().max(2).nullable().optional(),
  cep_padrao:      z.string().max(20).nullable().optional(),
  telefone_padrao: z.string().max(80).nullable().optional(),
  observacoes:     z.string().max(5000).nullable().optional(),
});

export type UpdateClienteInput = z.infer<typeof clienteSchema>;

export async function updateClienteAction(input: UpdateClienteInput) {
  const parsed = clienteSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos' };

  const supabase = await createClient();
  const { id, ...patch } = parsed.data;
  const { error } = await supabase.from('clientes').update(patch).eq('id', id);
  if (error) return { error: error.message };

  revalidatePath('/admin/clientes');
  return { ok: true as const };
}

/**
 * Merge: copia todos os pedidos de `sourceId` pra `targetId` e apaga o source.
 * Útil quando 2 cadastros do mesmo cliente foram criados sem CNPJ.
 */
export async function mergeClienteAction(input: { sourceId: string; targetId: string }) {
  if (input.sourceId === input.targetId) return { error: 'Source e target iguais' };

  const supabase = await createClient();

  const { error: e1 } = await supabase
    .from('pedidos')
    .update({ cliente_id: input.targetId })
    .eq('cliente_id', input.sourceId);
  if (e1) return { error: `Falha ao migrar pedidos: ${e1.message}` };

  const { error: e2 } = await supabase.from('clientes').delete().eq('id', input.sourceId);
  if (e2) return { error: `Falha ao remover origem: ${e2.message}` };

  revalidatePath('/admin/clientes');
  return { ok: true as const };
}

export async function deleteClienteAction(id: string) {
  const supabase = await createClient();
  // Quebra link em pedidos antes (set null automático pela FK on delete set null)
  const { error } = await supabase.from('clientes').delete().eq('id', id);
  if (error) return { error: error.message };
  revalidatePath('/admin/clientes');
  return { ok: true as const };
}
