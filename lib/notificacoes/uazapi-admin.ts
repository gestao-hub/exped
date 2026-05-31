/**
 * Cliente do servidor uazapi (lado servidor — nunca exposto ao cliente).
 * Usa o ADMIN token (env) para PROVISIONAR a instância de cada empresa (criar/conectar),
 * e o token DA INSTÂNCIA para o status. O envio de mensagens fica em send.ts.
 *
 * Envs: UAZAPI_URL (base do servidor) + UAZAPI_ADMIN_TOKEN (token admin do servidor).
 */

const BASE = (process.env.UAZAPI_URL ?? 'https://grupoide.uazapi.com').replace(/\/$/, '');
const ADMIN = process.env.UAZAPI_ADMIN_TOKEN ?? '';

/** Procura uma chave em qualquer nível raso do JSON (top-level ou .instance). */
function pick(obj: unknown, keys: string[]): string | null {
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const candidatos = [o, o.instance, o.data].filter(Boolean) as Record<string, unknown>[];
  for (const c of candidatos) {
    for (const k of keys) {
      const v = c?.[k];
      if (typeof v === 'string' && v) return v;
    }
  }
  return null;
}

export type Conexao = { status: string | null; qrcode: string | null; paircode: string | null };

async function req(path: string, method: string, headers: Record<string, string>, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text();
  let json: unknown = null;
  try { json = txt ? JSON.parse(txt) : null; } catch { /* texto cru */ }
  return { ok: res.ok, status: res.status, json, txt };
}

/** Cria uma instância no servidor e retorna o TOKEN dela (pra guardar na empresa). */
export async function criarInstancia(nome: string): Promise<{ token: string } | { error: string }> {
  if (!ADMIN) return { error: 'UAZAPI_ADMIN_TOKEN não configurado no servidor' };
  const r = await req('/instance/init', 'POST', { admintoken: ADMIN }, { name: nome, systemName: 'Exped' });
  if (!r.ok) return { error: `uazapi init ${r.status}: ${r.txt.slice(0, 200)}` };
  const token = pick(r.json, ['token']);
  if (!token) return { error: 'uazapi não retornou token da instância' };
  return { token };
}

/** Inicia a conexão (gera QR/pair code) usando o token da instância. */
export async function conectarInstancia(instanceToken: string): Promise<Conexao | { error: string }> {
  const r = await req('/instance/connect', 'POST', { token: instanceToken }, {});
  if (!r.ok) return { error: `uazapi connect ${r.status}: ${r.txt.slice(0, 200)}` };
  return {
    status: pick(r.json, ['status', 'connection_status', 'connectionStatus']),
    qrcode: pick(r.json, ['qrcode', 'qrCode', 'base64']),
    paircode: pick(r.json, ['paircode', 'pairCode', 'code']),
  };
}

/** Status atual da instância (e QR atualizado, se ainda conectando). */
export async function statusInstancia(instanceToken: string): Promise<Conexao | { error: string }> {
  const r = await req('/instance/status', 'GET', { token: instanceToken });
  if (!r.ok) return { error: `uazapi status ${r.status}: ${r.txt.slice(0, 200)}` };
  return {
    status: pick(r.json, ['status', 'connection_status', 'connectionStatus']),
    qrcode: pick(r.json, ['qrcode', 'qrCode', 'base64']),
    paircode: pick(r.json, ['paircode', 'pairCode', 'code']),
  };
}

/** Desconecta (logout) a instância. */
export async function desconectarInstancia(instanceToken: string): Promise<{ ok: true } | { error: string }> {
  const r = await req('/instance/disconnect', 'POST', { token: instanceToken });
  if (!r.ok) return { error: `uazapi disconnect ${r.status}: ${r.txt.slice(0, 200)}` };
  return { ok: true };
}

/** "connected" / "open" → conectado. */
export function estaConectado(status: string | null): boolean {
  if (!status) return false;
  const s = status.toLowerCase();
  return s === 'connected' || s === 'open' || s === 'online';
}
