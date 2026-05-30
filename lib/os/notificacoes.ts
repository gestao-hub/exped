import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/types/database';

export type TipoNotificacao = 'autorizacao' | 'pronto' | 'lembrete_manutencao';
export type CanalNotificacao = 'whatsapp' | 'email';

type OsParaNotificar = {
  id: string;
  empresa_id: string;
  documento_erp: string | null;
  cliente_nome: string;
  cliente_telefone: string | null;
  cliente_email: string | null;
  objeto: string | null;
  valor_total: number | null;
  proxima_manutencao_obs: string | null;
};

type EmpresaNotif = {
  nome: string;
  notif_whatsapp_ativo: boolean;
  notif_email_ativo: boolean;
};

const fmtMoney = (n: number | null) =>
  Number(n ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** Texto da mensagem por tipo. pt-BR, sem emojis (VibeUX). Curto e direto. */
export function montarMensagem(
  tipo: TipoNotificacao,
  os: OsParaNotificar,
  empresa: EmpresaNotif,
): { assunto: string; corpo: string } {
  const nome = (os.cliente_nome || 'cliente').split(/\s+/)[0];
  const obj = os.objeto?.trim();
  const objFrase = obj ? `seu ${obj}` : 'seu serviço';
  const doc = os.documento_erp ? ` (OS ${os.documento_erp})` : '';
  switch (tipo) {
    case 'autorizacao':
      return {
        assunto: `Autorização do serviço${doc} — ${empresa.nome}`,
        corpo:
          `Olá, ${nome}! O orçamento${doc} de ${objFrase} está pronto` +
          `${os.valor_total ? `, no total de ${fmtMoney(os.valor_total)}` : ''}. ` +
          `Podemos autorizar a execução? Responda SIM para confirmarmos. — ${empresa.nome}`,
      };
    case 'pronto':
      return {
        assunto: `Serviço concluído${doc} — ${empresa.nome}`,
        corpo:
          `Olá, ${nome}! ${obj ? `Seu ${obj} está` : 'Seu serviço está'} pronto para retirada` +
          ` na ${empresa.nome}. Estamos à disposição. — ${empresa.nome}`,
      };
    case 'lembrete_manutencao':
      return {
        assunto: `Lembrete de manutenção — ${empresa.nome}`,
        corpo:
          `Olá, ${nome}! Está chegando a hora da ${os.proxima_manutencao_obs?.trim() || 'próxima manutenção'} ` +
          `${obj ? `do seu ${obj}` : ''}. Que tal agendar? Conte com a ${empresa.nome}.`,
      };
  }
}

/**
 * Enfileira a notificação nos canais ativos da empresa para os quais há destino.
 * Não envia — só insere na outbox `os_notificacoes` (o dispatcher envia quando vencer).
 * Idempotente por (os_id, tipo, canal) enquanto a anterior estiver pendente/enviada
 * (evita duplicar se o operador clicar duas vezes).
 * Retorna quantos canais foram enfileirados (0 = nenhum canal ativo/destino).
 */
export async function enfileirarNotificacao(
  supabase: SupabaseClient<Database>,
  args: {
    os: OsParaNotificar;
    empresa: EmpresaNotif;
    tipo: TipoNotificacao;
    agendadaPara?: string; // ISO; default = agora
  },
): Promise<number> {
  const { os, empresa, tipo } = args;
  const { assunto, corpo } = montarMensagem(tipo, os, empresa);
  const agendada = args.agendadaPara ?? new Date().toISOString();

  const alvos: { canal: CanalNotificacao; destino: string }[] = [];
  if (empresa.notif_whatsapp_ativo && os.cliente_telefone)
    alvos.push({ canal: 'whatsapp', destino: os.cliente_telefone });
  if (empresa.notif_email_ativo && os.cliente_email)
    alvos.push({ canal: 'email', destino: os.cliente_email });
  if (alvos.length === 0) return 0;

  let enfileiradas = 0;
  for (const { canal, destino } of alvos) {
    // dedup: já existe uma desse tipo/canal pra essa OS ainda viva?
    const { data: existente } = await supabase
      .from('os_notificacoes')
      .select('id')
      .eq('os_id', os.id)
      .eq('tipo', tipo)
      .eq('canal', canal)
      .in('status', ['pendente', 'enviada'])
      .maybeSingle();
    if (existente) continue;

    const { error } = await supabase.from('os_notificacoes').insert({
      empresa_id: os.empresa_id,
      os_id: os.id,
      canal,
      tipo,
      destino,
      assunto,
      corpo,
      agendada_para: agendada,
    });
    if (!error) enfileiradas++;
  }
  return enfileiradas;
}
