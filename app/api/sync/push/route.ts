import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/admin';
import { resolveDevice } from '@/lib/sync/auth';
import { makeSupabaseSyncDb } from '@/lib/sync/supabase-db';
import { runPush, PushError, type Row } from '@/lib/sync/engine';

export const runtime = 'nodejs';
// Cada linha usa uma RPC atomica; o engine limita a concorrencia do lote para
// reduzir o catch-up sem saturar o banco. A janela maior cobre backlogs extensos.
export const maxDuration = 60;

/**
 * Push de lote do hub. Auth por token de dispositivo → empresa_id. A nuvem é a
 * autoridade de merge: cada linha two-way vai para uma RPC que trava a PK e faz
 * leitura, merge e escrita na mesma transacao. Tabelas `down` → 403. Escopo por
 * empresa SEMPRE server-side (empresa_id forçado; filhas travam/validam o pai).
 *
 * A RPC `sync_merge_upsert` preserva field_updated_at/updated_at e devolve a
 * canonica resultante. Idempotente por PK.
 */
const pushSchema = z.object({
  rows: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))).default({}),
});

export async function POST(req: NextRequest) {
  const supabase = createAdminClient();

  const device = await resolveDevice(supabase, req.headers.get('authorization'));
  if (!device) return NextResponse.json({ error: 'Dispositivo inválido ou inativo' }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Body JSON inválido' }, { status: 400 });
  }
  const parsed = pushSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'payload inválido' }, { status: 422 });
  }

  const db = makeSupabaseSyncDb(supabase);
  try {
    const result = await runPush(db, device.empresaId, parsed.data.rows as Record<string, Row[]>);
    return NextResponse.json(result, { status: 200 });
  } catch (e) {
    if (e instanceof PushError) {
      return NextResponse.json(
        { error: e.message, ...(e.blockedRow ? { blockedRow: e.blockedRow } : {}) },
        {
          status: e.status,
          ...(e.status === 503 ? { headers: { 'Retry-After': '30' } } : {}),
        },
      );
    }
    console.error('[sync/push] erro:', e);
    return NextResponse.json({ error: 'Falha no push de sync' }, { status: 500 });
  }
}
