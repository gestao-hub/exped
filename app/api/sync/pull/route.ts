import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/admin';
import { resolveDevice } from '@/lib/sync/auth';
import { makeSupabaseSyncDb } from '@/lib/sync/supabase-db';
import { runPull } from '@/lib/sync/engine';

export const runtime = 'nodejs';

/**
 * Pull de deltas canônicos desde os cursores do hub. Auth por token de dispositivo
 * → empresa_id; escopo por empresa SEMPRE server-side. Inclui linhas com deleted_at
 * (o hub precisa saber das remoções).
 */
const pullSchema = z.object({
  cursors: z.record(z.string(), z.string()).default({}),
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
  const parsed = pullSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'payload inválido' }, { status: 422 });
  }

  const db = makeSupabaseSyncDb(supabase);
  try {
    const result = await runPull(db, device.empresaId, parsed.data.cursors);
    return NextResponse.json(result, { status: 200 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[sync/pull] erro:', msg, e);
    return NextResponse.json({ error: `pull falhou: ${msg}` }, { status: 500 });
  }
}
