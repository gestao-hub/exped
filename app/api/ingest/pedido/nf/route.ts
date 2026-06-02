import { NextResponse, type NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { ingestNfSchema } from '@/lib/validators/ingest';
import { mapFormaPagamento, parseParcelas } from '@/lib/parser/forma-pagamento';
import { atualizarNfPedido } from '@/lib/pedidos/atualizar-nf';

export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * Re-sync de NF/pagamento de um pedido já ingerido (vindo do agente quando o
 * pedido vira faturado no Hiper). Preenche só campos vazios; não atropela edição.
 */
export async function POST(req: NextRequest) {
  const supabase = createAdminClient();

  const auth = req.headers.get('authorization') ?? '';
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (!token) return NextResponse.json({ error: 'Token ausente' }, { status: 401 });
  const tokenHash = createHash('sha256').update(token).digest('hex');

  const { data: dispositivo } = await supabase
    .from('dispositivos')
    .select('id, empresa_id, ativo')
    .eq('token_hash', tokenHash)
    .maybeSingle();
  if (!dispositivo || !dispositivo.ativo) {
    return NextResponse.json({ error: 'Dispositivo inválido ou inativo' }, { status: 401 });
  }
  const empresaId = dispositivo.empresa_id as string;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }
  const parsed = ingestNfSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'dados inválidos' },
      { status: 422 },
    );
  }
  const d = parsed.data;

  const r = await atualizarNfPedido(supabase, {
    empresaId,
    documentoErp: d.documento_erp,
    nf: {
      nf_numero: d.nf_numero ?? null,
      nf_chave: d.nf_chave ?? null,
      nf_emitida_em: d.nf_emitida_em ?? null,
      nf_valor: d.nf_valor ?? null,
    },
    pagamento: {
      forma_pagamento: mapFormaPagamento(d.forma_pagamento ?? null),
      parcelas: parseParcelas(d.parcelas ?? null),
    },
  });

  if ('notfound' in r) return NextResponse.json({ notfound: true }, { status: 404 });
  return NextResponse.json(r, { status: 200 });
}
