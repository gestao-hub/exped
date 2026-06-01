// app/api/agent/config/route.ts
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { resolveDevice } from '@/lib/sync/auth';

export const runtime = 'nodejs';

/**
 * Config de comportamento do agente, por empresa. O agente chama o HUB LOCAL
 * (mesmo código do app); resolveDevice valida o token contra `dispositivos` local
 * (que desce via sync). Offline-safe. Erro genérico em 401.
 */
export async function GET(req: NextRequest) {
  const supabase = createAdminClient();
  const device = await resolveDevice(supabase, req.headers.get('authorization'));
  if (!device) return NextResponse.json({ error: 'Dispositivo inválido ou inativo' }, { status: 401 });

  // Colunas agente_* ainda não estão nos tipos gerados do banco; cast pontual
  // até regenerar database.ts.
  const { data } = (await supabase
    .from('empresas')
    .select('agente_situacoes_venda, agente_sync_os, agente_situacoes_os, agente_poll_segundos')
    .eq('id', device.empresaId)
    .single()) as {
    data: {
      agente_situacoes_venda?: string;
      agente_sync_os?: boolean;
      agente_situacoes_os?: string;
      agente_poll_segundos?: number;
    } | null;
  };

  return NextResponse.json({
    situacoesVenda: data?.agente_situacoes_venda ?? '2,5,7',
    syncOs: data?.agente_sync_os ?? false,
    situacoesOs: data?.agente_situacoes_os ?? '',
    pollSegundos: data?.agente_poll_segundos ?? 30,
  });
}
