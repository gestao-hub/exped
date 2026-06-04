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

  // Retorna a linha criada (com autor) pro cliente fazer append otimista — assim o comentário
  // aparece na hora MESMO no hub (onde o realtime via WebSocket não funciona). Na nuvem o canal
  // também entrega, mas o componente deduplica por id.
  const { data: novo, error } = await supabase
    .from('pedido_comentarios')
    .insert({ pedido_id: parsed.data.pedido_id, autor_id: user.id, texto: parsed.data.texto })
    .select('id, pedido_id, autor_id, texto, created_at, autor:profiles(full_name, email, role)')
    .single();
  if (error || !novo) return { error: error?.message ?? 'Falha ao comentar' };

  revalidatePath(`/vendas/${parsed.data.pedido_id}`);
  revalidatePath(`/logistica/${parsed.data.pedido_id}`);
  revalidatePath(`/historico/${parsed.data.pedido_id}`);
  return { ok: true as const, comentario: novo };
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
