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

const clienteIdSchema = z.uuid();
const mergeClienteSchema = z.object({
  sourceId: clienteIdSchema,
  targetId: clienteIdSchema,
});

export type UpdateClienteInput = z.infer<typeof clienteSchema>;

export async function updateClienteAction(input: UpdateClienteInput) {
  const parsed = clienteSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos' };

  const supabase = await createClient();
  const { id, ...patch } = parsed.data;
  const { error } = await supabase
    .from('clientes')
    .update(patch)
    .eq('id', id)
    .is('deleted_at', null);
  if (error) return { error: error.message };

  revalidatePath('/admin/clientes');
  return { ok: true as const };
}

/**
 * Merge: move os pedidos ativos de `sourceId` pra `targetId` e arquiva o source.
 * Útil quando 2 cadastros do mesmo cliente foram criados sem CNPJ.
 */
export async function mergeClienteAction(input: { sourceId: string; targetId: string }) {
  const parsed = mergeClienteSchema.safeParse(input);
  if (!parsed.success) return { error: 'Clientes inválidos' };
  if (parsed.data.sourceId === parsed.data.targetId) return { error: 'Source e target iguais' };

  const supabase = await createClient();
  const { error } = await supabase.rpc('merge_clientes' as never, {
    p_source_id: parsed.data.sourceId,
    p_target_id: parsed.data.targetId,
  } as never);
  if (error) return { error: `Falha ao mesclar clientes: ${error.message}` };

  revalidatePath('/admin/clientes');
  return { ok: true as const };
}

export async function deleteClienteAction(id: string) {
  const parsed = clienteIdSchema.safeParse(id);
  if (!parsed.success) return { error: 'Cliente inválido' };

  const supabase = await createClient();
  const { error } = await supabase
    .from('clientes')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', parsed.data)
    .is('deleted_at', null);
  if (error) return { error: error.message };
  revalidatePath('/admin/clientes');
  return { ok: true as const };
}
