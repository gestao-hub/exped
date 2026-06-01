// lib/empresa/agente-config-actions.ts
'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';

export type AgenteConfig = {
  agente_situacoes_venda: string;
  agente_sync_os: boolean;
  agente_situacoes_os: string;
  agente_poll_segundos: number;
};

async function isPlatformAdmin(): Promise<boolean> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;
  const { data } = await supabase.from('profiles').select('is_platform_admin').eq('id', user.id).single();
  return !!data?.is_platform_admin;
}

/** Salva a config do agente na empresa (só platform admin). Sincroniza pro hub. */
export async function salvarAgenteConfigAction(
  empresaId: string, cfg: AgenteConfig,
): Promise<{ ok: true } | { error: string }> {
  if (!(await isPlatformAdmin())) return { error: 'Apenas o operador da plataforma' };
  const poll = Number.isFinite(cfg.agente_poll_segundos) ? Math.max(5, Math.min(600, cfg.agente_poll_segundos)) : 30;
  const supabase = await createClient();
  // cast até regenerar database.ts
  const { error } = await supabase.from('empresas').update({
    agente_situacoes_venda: cfg.agente_situacoes_venda.trim() || '2,5,7',
    agente_sync_os: cfg.agente_sync_os,
    agente_situacoes_os: cfg.agente_situacoes_os.trim(),
    agente_poll_segundos: poll,
  } as never).eq('id', empresaId);
  if (error) return { error: error.message };
  revalidatePath('/plataforma');
  return { ok: true };
}
