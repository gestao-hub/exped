'use server';

import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { novaEmpresaSchema, type NovaEmpresaInput } from '@/lib/validators/empresa';

/**
 * Cria uma nova empresa (tenant) + convida o 1º usuário como admin DELA.
 * Só platform admin (operador do produto) pode chamar.
 *
 * SEGURANÇA: não passamos role/empresa_id no metadata do convite — o trigger
 * handle_new_user ignora metadata de propósito (anti-bypass de tenant). O profile
 * nasce com empresa_id=NULL/role='vendedor' e nós atribuímos empresa+role logo
 * depois via service_role (o trigger anti-escalonamento permite porque auth.uid()
 * é null nesse contexto de servidor).
 */
export async function criarEmpresaComAdminAction(
  input: NovaEmpresaInput,
): Promise<{ ok: true; empresa_id: string } | { error: string }> {
  const supa = await createClient();
  const {
    data: { user },
  } = await supa.auth.getUser();
  if (!user) return { error: 'Não autenticado' };

  const { data: me } = await supa
    .from('profiles')
    .select('is_platform_admin')
    .eq('id', user.id)
    .single();
  if (!me?.is_platform_admin) return { error: 'Apenas o operador da plataforma pode criar empresas' };

  const parsed = novaEmpresaSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos' };
  const d = parsed.data;

  const admin = createAdminClient();

  // 1) Cria a empresa
  const { data: emp, error: e1 } = await admin
    .from('empresas')
    .insert({ nome: d.nome, slug: d.slug })
    .select('id')
    .single();
  if (e1 || !emp) return { error: e1?.message ?? 'Falha ao criar empresa' };

  // 2) Convida o 1º usuário (SEM role/empresa no metadata)
  const { data: invited, error: e2 } = await admin.auth.admin.inviteUserByEmail(d.admin_email, {
    data: { full_name: d.admin_nome },
  });
  if (e2 || !invited?.user) return { error: `Empresa criada, mas convite falhou: ${e2?.message}` };

  // 3) Atribui empresa + role admin via service_role (trigger permite: auth.uid() null)
  const { error: e3 } = await admin
    .from('profiles')
    .update({ empresa_id: emp.id as string, role: 'admin' })
    .eq('id', invited.user.id);
  if (e3) return { error: `Empresa/convite OK, mas atribuição de admin falhou: ${e3.message}` };

  return { ok: true, empresa_id: emp.id as string };
}

export type NotifConfigInput = {
  notif_whatsapp_ativo: boolean;
  uazapi_url: string | null;
  uazapi_token: string | null;
  uazapi_instancia: string | null;
  notif_email_ativo: boolean;
  email_remetente: string | null;
  manutencao_lembrete_dias: number;
  os_situacao_autorizacao: number | null;
  os_situacao_pronto: number | null;
};

/**
 * Salva a config de notificação de uma empresa. Só platform admin (operador).
 * As credenciais (uazapi/remetente) e os gatilhos de situação são plugados aqui.
 */
export async function salvarNotifConfigAction(
  empresaId: string,
  cfg: NotifConfigInput,
): Promise<{ ok: true } | { error: string }> {
  const supa = await createClient();
  const { data: { user } } = await supa.auth.getUser();
  if (!user) return { error: 'Não autenticado' };
  const { data: me } = await supa.from('profiles').select('is_platform_admin').eq('id', user.id).single();
  if (!me?.is_platform_admin) return { error: 'Apenas o operador pode configurar notificações' };

  const dias = Number.isFinite(cfg.manutencao_lembrete_dias)
    ? Math.min(90, Math.max(0, Math.trunc(cfg.manutencao_lembrete_dias)))
    : 7;
  const norm = (s: string | null) => (s && s.trim() ? s.trim() : null);

  const admin = createAdminClient();
  const { error } = await admin
    .from('empresas')
    .update({
      notif_whatsapp_ativo: cfg.notif_whatsapp_ativo,
      uazapi_url: norm(cfg.uazapi_url),
      uazapi_token: norm(cfg.uazapi_token),
      uazapi_instancia: norm(cfg.uazapi_instancia),
      notif_email_ativo: cfg.notif_email_ativo,
      email_remetente: norm(cfg.email_remetente),
      manutencao_lembrete_dias: dias,
      os_situacao_autorizacao: cfg.os_situacao_autorizacao ?? null,
      os_situacao_pronto: cfg.os_situacao_pronto ?? null,
    })
    .eq('id', empresaId);
  if (error) return { error: error.message };
  return { ok: true };
}

export type EmpresaConfigInput = {
  usa_os: boolean;
  ativo: boolean;
  logo_url: string | null;
  cor_primaria: string | null;
};

/**
 * Config geral da empresa (operador): liga/desliga Ordem de Serviço, ativo, e marca
 * (logo + cor). Tira a dependência de SQL pra habilitar OS num cliente novo.
 */
export async function salvarEmpresaConfigAction(
  empresaId: string,
  cfg: EmpresaConfigInput,
): Promise<{ ok: true } | { error: string }> {
  const supa = await createClient();
  const { data: { user } } = await supa.auth.getUser();
  if (!user) return { error: 'Não autenticado' };
  const { data: me } = await supa.from('profiles').select('is_platform_admin').eq('id', user.id).single();
  if (!me?.is_platform_admin) return { error: 'Apenas o operador pode configurar a empresa' };

  const norm = (s: string | null) => (s && s.trim() ? s.trim() : null);
  const cor = norm(cfg.cor_primaria);
  if (cor && !/^#[0-9a-fA-F]{6}$/.test(cor)) return { error: 'Cor inválida (use #RRGGBB)' };

  const admin = createAdminClient();
  const { error } = await admin
    .from('empresas')
    .update({ usa_os: cfg.usa_os, ativo: cfg.ativo, logo_url: norm(cfg.logo_url), cor_primaria: cor })
    .eq('id', empresaId);
  if (error) return { error: error.message };
  return { ok: true };
}
