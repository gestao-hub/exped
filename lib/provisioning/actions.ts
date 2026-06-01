// lib/provisioning/actions.ts
'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { gerarCodigoInstalacao } from '@/lib/provisioning/code';

async function isPlatformAdmin(): Promise<boolean> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;
  const { data } = await supabase.from('profiles').select('is_platform_admin').eq('id', user.id).single();
  return !!data?.is_platform_admin;
}

/** Gera um código de instalação (uso único, 24h) p/ a empresa. Devolve o cru 1x. */
export async function criarCodigoInstalacaoAction(
  empresaId: string,
): Promise<{ ok: true; codigo: string; expiraEm: string } | { error: string }> {
  if (!(await isPlatformAdmin())) return { error: 'Apenas o operador da plataforma' };
  if (!empresaId) return { error: 'Empresa obrigatória' };

  const { raw, hash } = gerarCodigoInstalacao();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  // cast até regenerar database.ts
  const { error } = await supabase.from('provisioning_codes' as never).insert({
    empresa_id: empresaId, code_hash: hash, expires_at: expiresAt, created_by: user?.id ?? null,
  } as never);
  if (error) return { error: error.message };

  revalidatePath('/plataforma');
  return { ok: true, codigo: raw, expiraEm: expiresAt };
}
