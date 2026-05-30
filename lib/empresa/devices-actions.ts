'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { gerarTokenDispositivo } from '@/lib/crypto/token';

/** Confirma que o chamador é platform admin. Devolve o user id ou null. */
async function platformAdminId(): Promise<string | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: me } = await supabase
    .from('profiles').select('is_platform_admin').eq('id', user.id).single();
  return me?.is_platform_admin ? user.id : null;
}

/**
 * Cria um dispositivo (agente) pra uma empresa e devolve o token CRU uma única vez
 * (guardamos só o hash). Só platform admin. RLS de `dispositivos` exige platform admin
 * pra escrita.
 */
export async function criarDispositivoAction(
  empresaId: string,
  nome: string,
): Promise<{ ok: true; token: string } | { error: string }> {
  if (!(await platformAdminId())) return { error: 'Apenas o operador da plataforma' };
  if (!empresaId || !nome?.trim()) return { error: 'Empresa e nome são obrigatórios' };

  const { raw, hash } = gerarTokenDispositivo();
  const supabase = await createClient();
  const { error } = await supabase.from('dispositivos').insert({
    empresa_id: empresaId,
    nome: nome.trim(),
    token_hash: hash,
    ativo: true,
  });
  if (error) return { error: error.message };

  revalidatePath('/admin/plataforma');
  return { ok: true, token: raw };
}

/** Ativa/desativa um dispositivo (revogar = ativo:false). Só platform admin. */
export async function setDispositivoAtivoAction(
  id: string,
  ativo: boolean,
): Promise<{ ok: true } | { error: string }> {
  if (!(await platformAdminId())) return { error: 'Apenas o operador da plataforma' };
  const supabase = await createClient();
  const { error } = await supabase.from('dispositivos').update({ ativo }).eq('id', id);
  if (error) return { error: error.message };
  revalidatePath('/admin/plataforma');
  return { ok: true };
}
