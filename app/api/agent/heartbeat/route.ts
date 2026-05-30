import { NextResponse, type NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { hashToken } from '@/lib/crypto/token';

export const runtime = 'nodejs';

/**
 * Heartbeat do agente: autentica por token de dispositivo e atualiza last_seen_at.
 * Usado pelo painel da frota pra mostrar quem está online. Idempotente.
 */
export async function POST(req: NextRequest) {
  const auth = req.headers.get('authorization') ?? '';
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (!token) return NextResponse.json({ error: 'Token ausente' }, { status: 401 });

  const supabase = createAdminClient();
  const { data: d } = await supabase
    .from('dispositivos')
    .select('id, ativo')
    .eq('token_hash', hashToken(token))
    .maybeSingle();
  if (!d || !d.ativo) {
    return NextResponse.json({ error: 'Dispositivo inválido ou inativo' }, { status: 401 });
  }

  await supabase
    .from('dispositivos')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', d.id);

  return NextResponse.json({ ok: true });
}
