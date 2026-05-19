'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';

const addSchema = z.object({
  pedido_id: z.uuid(),
  texto: z.string().min(1, 'Mensagem vazia').max(5000),
});

export async function addComentarioAction(input: {
  pedido_id: string;
  texto: string;
}) {
  const parsed = addSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos' };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: 'Não autenticado' };

  const { error } = await supabase.from('pedido_comentarios').insert({
    pedido_id: parsed.data.pedido_id,
    autor_id: user.id,
    texto: parsed.data.texto,
  });
  if (error) return { error: error.message };

  revalidatePath(`/vendas/${parsed.data.pedido_id}`);
  revalidatePath(`/logistica/${parsed.data.pedido_id}`);
  revalidatePath(`/historico/${parsed.data.pedido_id}`);
  return { ok: true as const };
}

export async function deleteComentarioAction(id: string, pedido_id: string) {
  const supabase = await createClient();
  const { error } = await supabase.from('pedido_comentarios').delete().eq('id', id);
  if (error) return { error: error.message };
  revalidatePath(`/vendas/${pedido_id}`);
  revalidatePath(`/logistica/${pedido_id}`);
  revalidatePath(`/historico/${pedido_id}`);
  return { ok: true as const };
}
