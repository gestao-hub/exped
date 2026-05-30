'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { enfileirarNotificacao, type TipoNotificacao } from '@/lib/os/notificacoes';

export type NotificarResult = { ok: true; enfileiradas: number } | { error: string };

const CAMPOS_OS =
  'id, empresa_id, documento_erp, cliente_nome, cliente_telefone, cliente_email, objeto, valor_total, proxima_manutencao_obs';

/** Carrega OS + empresa e checa que o usuário é admin da empresa. */
async function contexto(osId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: 'Não autenticado' };

  const { data: perfil } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (perfil?.role !== 'admin') return { ok: false as const, error: 'Apenas admin pode enviar notificações' };

  const { data: os } = await supabase.from('ordens_servico').select(CAMPOS_OS).eq('id', osId).single();
  if (!os) return { ok: false as const, error: 'OS não encontrada' };

  const { data: empresa } = await supabase
    .from('empresas')
    .select('nome, notif_whatsapp_ativo, notif_email_ativo, manutencao_lembrete_dias')
    .eq('id', os.empresa_id)
    .single();
  if (!empresa) return { ok: false as const, error: 'Empresa não encontrada' };

  return { ok: true as const, supabase, os, empresa };
}

async function notificar(osId: string, tipo: TipoNotificacao, agendadaPara?: string): Promise<NotificarResult> {
  const ctx = await contexto(osId);
  if (!ctx.ok) return { error: ctx.error };
  const { supabase, os, empresa } = ctx;

  if (!empresa.notif_whatsapp_ativo && !empresa.notif_email_ativo)
    return { error: 'Nenhum canal de notificação ativo. Configure WhatsApp/e-mail nas configurações da empresa.' };
  if (!os.cliente_telefone && !os.cliente_email)
    return { error: 'OS sem telefone nem e-mail do cliente.' };

  const n = await enfileirarNotificacao(supabase, {
    os,
    empresa: { nome: empresa.nome, notif_whatsapp_ativo: empresa.notif_whatsapp_ativo, notif_email_ativo: empresa.notif_email_ativo },
    tipo,
    agendadaPara,
  });
  revalidatePath(`/os/${osId}`);
  if (n === 0) return { error: 'Nada enfileirado (canal ativo sem destino correspondente, ou já enviado).' };
  return { ok: true, enfileiradas: n };
}

export async function pedirAutorizacaoAction(osId: string): Promise<NotificarResult> {
  return notificar(osId, 'autorizacao');
}

export async function avisarProntoAction(osId: string): Promise<NotificarResult> {
  return notificar(osId, 'pronto');
}

/**
 * Agenda a próxima manutenção: grava data+obs na OS e enfileira o lembrete para
 * (data − manutencao_lembrete_dias da empresa), à meia-noite. O dispatcher envia quando vencer.
 */
export async function agendarManutencaoAction(
  osId: string,
  data: string,        // 'yyyy-mm-dd'
  obs: string | null,
): Promise<NotificarResult> {
  const ctx = await contexto(osId);
  if (!ctx.ok) return { error: ctx.error };
  const { supabase, empresa } = ctx;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return { error: 'Data inválida' };

  const { error: upErr } = await supabase
    .from('ordens_servico')
    .update({ data_proxima_manutencao: data, proxima_manutencao_obs: obs })
    .eq('id', osId);
  if (upErr) return { error: upErr.message };

  // dispara o lembrete N dias antes da data alvo
  const alvo = new Date(`${data}T09:00:00`);
  alvo.setDate(alvo.getDate() - (empresa.manutencao_lembrete_dias ?? 7));
  const agendada = alvo.toISOString();

  // recarrega a OS já com a obs nova pra montar a mensagem
  return notificar(osId, 'lembrete_manutencao', agendada);
}
