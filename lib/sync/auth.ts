import { createHash } from 'node:crypto';
import type { createAdminClient } from '@/lib/supabase/admin';

type Admin = ReturnType<typeof createAdminClient>;

export type DeviceAuth = { empresaId: string; dispositivoId: string };

/**
 * Resolve o token de dispositivo (Authorization: Bearer <token>) → empresa_id,
 * mesmo padrão de `app/api/ingest/pedido/route.ts`. Atualiza o heartbeat.
 * Retorna `null` quando ausente/inválido/inativo (caller responde 401).
 */
export async function resolveDevice(
  supabase: Admin,
  authorization: string | null,
): Promise<DeviceAuth | null> {
  const auth = authorization ?? '';
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (!token) return null;
  const tokenHash = createHash('sha256').update(token).digest('hex');

  const { data: dispositivo } = await supabase
    .from('dispositivos')
    .select('id, empresa_id, ativo')
    .eq('token_hash', tokenHash)
    .maybeSingle();
  if (!dispositivo || !dispositivo.ativo) return null;

  await supabase
    .from('dispositivos')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', dispositivo.id);

  return { empresaId: dispositivo.empresa_id as string, dispositivoId: dispositivo.id as string };
}
