'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';

const mapSchema = z.object({
  empresa_id: z.uuid(),
  hiper_usuario_id: z.number().int(),
  hiper_usuario_nome: z.string().max(250).nullable().optional(),
  vendedor_id: z.uuid(),
});
export type VendedorMapInput = z.infer<typeof mapSchema>;

async function isPlatformAdmin(): Promise<boolean> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;
  const { data: me } = await supabase
    .from('profiles').select('is_platform_admin').eq('id', user.id).single();
  return !!me?.is_platform_admin;
}

/** Mapeia (ou atualiza) um vendedor do Hiper → vendedor Exped, por empresa. */
export async function salvarVendedorMapAction(
  input: VendedorMapInput,
): Promise<{ ok: true } | { error: string }> {
  if (!(await isPlatformAdmin())) return { error: 'Apenas o operador da plataforma' };
  const parsed = mapSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos' };
  const d = parsed.data;

  const supabase = await createClient();
  const { error } = await supabase.from('hiper_vendedor_map').upsert(
    {
      empresa_id: d.empresa_id,
      hiper_usuario_id: d.hiper_usuario_id,
      hiper_usuario_nome: d.hiper_usuario_nome ?? null,
      vendedor_id: d.vendedor_id,
    },
    { onConflict: 'empresa_id,hiper_usuario_id' },
  );
  if (error) return { error: error.message };

  revalidatePath('/admin/plataforma');
  return { ok: true };
}
