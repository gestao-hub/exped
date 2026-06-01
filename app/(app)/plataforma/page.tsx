import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { PlataformaClient } from './plataforma-client';

/** Painel do operador da plataforma (platform admin). Cross-tenant. */
export default async function PlataformaPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { data: me } = await supabase
    .from('profiles').select('is_platform_admin').eq('id', user.id).single();
  if (!me?.is_platform_admin) redirect('/');

  const [{ data: empresas }, { data: dispositivos }, { data: mapeamentos }, { data: profiles }] =
    await Promise.all([
      supabase.from('empresas')
        .select('id, nome, slug, ativo, usa_os, logo_url, cor_primaria, notif_whatsapp_ativo, uazapi_url, uazapi_token, uazapi_instancia, notif_email_ativo, email_remetente, manutencao_lembrete_dias, os_situacao_autorizacao, os_situacao_pronto, agente_situacoes_venda, agente_sync_os, agente_situacoes_os, agente_poll_segundos')
        .order('nome'),
      supabase.from('dispositivos')
        .select('id, empresa_id, nome, ativo, last_seen_at, created_at')
        .order('created_at', { ascending: false }),
      supabase.from('hiper_vendedor_map')
        .select('empresa_id, hiper_usuario_id, hiper_usuario_nome, vendedor_id'),
      supabase.from('profiles').select('id, full_name, email, role, empresa_id'),
    ]);

  return (
    <PlataformaClient
      empresas={(empresas ?? []) as never}
      dispositivos={(dispositivos ?? []) as never}
      mapeamentos={(mapeamentos ?? []) as never}
      profiles={(profiles ?? []) as never}
    />
  );
}
