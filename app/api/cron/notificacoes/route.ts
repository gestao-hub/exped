import { NextResponse, type NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { enviarWhatsapp, enviarEmail } from '@/lib/notificacoes/send';

export const runtime = 'nodejs';
export const maxDuration = 60;

const LOTE = 50;        // máx por execução
const MAX_TENTATIVAS = 4;

/**
 * Dispatcher da outbox `os_notificacoes`. Envia as pendentes vencidas (agendada_para <= now)
 * pelos canais configurados na empresa. Idempotente por status (marca enviada/falha).
 * Protegido por CRON_SECRET (header Authorization: Bearer <secret> ou ?secret=).
 * Disparar por Vercel Cron (ex.: a cada 5 min) ou manualmente.
 */
export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}

async function handle(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get('authorization') ?? '';
    const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    const qs = req.nextUrl.searchParams.get('secret') ?? '';
    if (bearer !== secret && qs !== secret) {
      return NextResponse.json({ error: 'não autorizado' }, { status: 401 });
    }
  }

  const supabase = createAdminClient();
  const agora = new Date().toISOString();

  const { data: pendentes, error } = await supabase
    .from('os_notificacoes')
    .select('id, empresa_id, canal, tipo, destino, assunto, corpo, tentativas')
    .eq('status', 'pendente')
    .lte('agendada_para', agora)
    .order('agendada_para', { ascending: true })
    .limit(LOTE);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!pendentes || pendentes.length === 0) return NextResponse.json({ enviadas: 0, falhas: 0 });

  // Cache de config por empresa (evita refetch).
  const empresas = new Map<
    string,
    { notif_whatsapp_ativo: boolean; notif_email_ativo: boolean; uazapi_url: string | null; uazapi_token: string | null; uazapi_instancia: string | null; email_remetente: string | null }
  >();
  async function empresaCfg(id: string) {
    if (empresas.has(id)) return empresas.get(id)!;
    const { data } = await supabase
      .from('empresas')
      .select('notif_whatsapp_ativo, notif_email_ativo, uazapi_url, uazapi_token, uazapi_instancia, email_remetente')
      .eq('id', id)
      .single();
    const cfg = data ?? {
      notif_whatsapp_ativo: false, notif_email_ativo: false,
      uazapi_url: null, uazapi_token: null, uazapi_instancia: null, email_remetente: null,
    };
    empresas.set(id, cfg);
    return cfg;
  }

  let enviadas = 0;
  let falhas = 0;
  for (const n of pendentes) {
    const cfg = await empresaCfg(n.empresa_id);
    let r: { ok: true } | { ok: false; error: string };
    if (n.canal === 'whatsapp') {
      r = cfg.notif_whatsapp_ativo
        ? await enviarWhatsapp(cfg, n.destino, n.corpo)
        : { ok: false, error: 'whatsapp desativado na empresa' };
    } else {
      r = cfg.notif_email_ativo
        ? await enviarEmail(cfg.email_remetente, n.destino, n.assunto ?? 'Notificação', n.corpo)
        : { ok: false, error: 'e-mail desativado na empresa' };
    }

    const tentativas = (n.tentativas ?? 0) + 1;
    if (r.ok) {
      await supabase
        .from('os_notificacoes')
        .update({ status: 'enviada', enviada_em: new Date().toISOString(), tentativas })
        .eq('id', n.id);
      enviadas++;
    } else {
      // estoura tentativas → falha definitiva; senão continua pendente pra próxima rodada
      await supabase
        .from('os_notificacoes')
        .update({
          status: tentativas >= MAX_TENTATIVAS ? 'falha' : 'pendente',
          tentativas,
          erro: r.error.slice(0, 500),
        })
        .eq('id', n.id);
      falhas++;
    }
  }

  return NextResponse.json({ enviadas, falhas, processadas: pendentes.length });
}
