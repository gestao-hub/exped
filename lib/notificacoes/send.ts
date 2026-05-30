/**
 * Envio efetivo de notificações. As credenciais vêm da empresa (multi-tenant) ou de env.
 * Tudo isolado: cada função retorna {ok} | {error} — o dispatcher decide o que fazer.
 *
 * ⚠️ ATIVAÇÃO: confirmar o formato exato da API do uazapi do cliente (endpoint/headers
 * podem variar por versão da instância). A chave de e-mail (Resend) é global por env.
 */

export type EnvioResult = { ok: true } | { ok: false; error: string };

export type CredsWhatsapp = {
  uazapi_url: string | null;
  uazapi_token: string | null;
  uazapi_instancia: string | null;
};

/** uazapi: POST {url}/send/text, header `token`, body {number, text}. Ajustar se a instância divergir. */
export async function enviarWhatsapp(
  creds: CredsWhatsapp,
  destino: string,
  texto: string,
): Promise<EnvioResult> {
  if (!creds.uazapi_url || !creds.uazapi_token) return { ok: false, error: 'uazapi não configurado' };
  const numero = destino.replace(/\D/g, '');
  if (!numero) return { ok: false, error: 'telefone inválido' };
  try {
    const res = await fetch(`${creds.uazapi_url.replace(/\/$/, '')}/send/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', token: creds.uazapi_token },
      body: JSON.stringify({ number: numero, text: texto }),
    });
    if (!res.ok) return { ok: false, error: `uazapi ${res.status}: ${(await res.text()).slice(0, 200)}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `uazapi falhou: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** E-mail via Resend (chave global RESEND_API_KEY). `remetente` = empresa.email_remetente. */
export async function enviarEmail(
  remetente: string | null,
  destino: string,
  assunto: string,
  texto: string,
): Promise<EnvioResult> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, error: 'RESEND_API_KEY ausente' };
  if (!remetente) return { ok: false, error: 'email_remetente não configurado' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ from: remetente, to: destino, subject: assunto, text: texto }),
    });
    if (!res.ok) return { ok: false, error: `resend ${res.status}: ${(await res.text()).slice(0, 200)}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `resend falhou: ${e instanceof Error ? e.message : String(e)}` };
  }
}
