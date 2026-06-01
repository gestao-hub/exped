// app/api/provision/redeem/route.ts
import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/admin';
import { hashCodigo } from '@/lib/provisioning/code';
import { gerarTokenDispositivo } from '@/lib/crypto/token';

export const runtime = 'nodejs';

const CLOUD_API = process.env.EXPED_PUBLIC_CLOUD_API ?? 'https://app-exped.vercel.app';
const MAX_ATTEMPTS = 20; // por IP / 10 min
const schema = z.object({ code: z.string().min(4).max(40) });

/**
 * Resgate público do código de instalação. verify_jwt off; validação interna.
 * Gera o token de dispositivo AQUI (Node) e passa só o hash pro RPC, que cria o
 * dispositivo e marca o código como usado atomicamente. Erro sempre genérico + requestId.
 */
export async function POST(req: NextRequest) {
  // RPCs novos (redeem_provisioning_code, provision_note_attempt) ainda não estão
  // nos tipos gerados do banco; cast pontual até regenerar database.ts.
  const supabase = createAdminClient() as unknown as {
    rpc: (
      fn: string,
      args: Record<string, unknown>,
    ) => Promise<{ data: unknown; error: { message?: string } | null }>;
  };
  // XFF confiável: a Vercel sobrescreve x-forwarded-for na edge
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';

  // Valida o payload ANTES de contar a tentativa: payloads inválidos não consomem
  // a janela de throttle nem inflam a tabela de tentativas.
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'payload inválido' }, { status: 422 });

  const { data: attempts } = await supabase.rpc('provision_note_attempt', { p_ip: ip });
  if (typeof attempts === 'number' && attempts > MAX_ATTEMPTS) {
    return NextResponse.json({ error: 'muitas tentativas, tente mais tarde' }, { status: 429 });
  }

  const codeHash = hashCodigo(parsed.data.code);
  const { raw: deviceToken, hash: tokenHash } = gerarTokenDispositivo();
  const nome = `Hub ${new Date().toISOString().slice(0, 10)} ${Math.random().toString(36).slice(2, 6)}`;

  const { data, error } = await supabase.rpc('redeem_provisioning_code', {
    p_code_hash: codeHash, p_token_hash: tokenHash, p_dispositivo_nome: nome,
  });
  const row = (Array.isArray(data) ? data[0] : data) as
    | { empresa_id: string; empresa_nome: string }
    | undefined;
  if (error || !row) {
    const requestId = randomUUID().slice(0, 8);
    console.error(`[provision/redeem] req=${requestId}:`, (error as { message?: string })?.message ?? 'sem retorno');
    return NextResponse.json({ error: 'codigo invalido ou expirado', requestId }, { status: 400 });
  }

  return NextResponse.json({
    deviceToken,
    cloudApiUrl: CLOUD_API,
    empresaId: row.empresa_id,
    empresaNome: row.empresa_nome,
  });
}
