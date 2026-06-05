import { NextResponse, type NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { ingestPedidoSchema } from '@/lib/validators/ingest';
import { pedidoFormSchema, type PedidoFormInput } from '@/lib/validators/pedido';
import { extrairPagamentoDoPdfText } from '@/lib/parser/extrair-pagamento';
import { mapFormaPagamento, parseParcelas, isReceberNaEntrega } from '@/lib/parser/forma-pagamento';
import { inserirPedido } from '@/lib/pedidos/inserir';
import { parseIngestRequest } from '@/lib/ingest/parse-request';

export const runtime = 'nodejs';
export const maxDuration = 30;

const MAX_BYTES = 10 * 1024 * 1024;
const BUCKET = 'pedidos-pdfs';

/**
 * Ingestão de pedido vinda do agente local (Serviço Windows).
 * Autenticação: token de dispositivo (Authorization: Bearer <token>) → resolve a
 * empresa via tabela `dispositivos`. Dados estruturados vêm do banco do Hiper (JSON);
 * a forma de pagamento é extraída do PDF (não existe no banco a nível de pedido).
 */
export async function POST(req: NextRequest) {
  const supabase = createAdminClient();

  // 1) Auth por token de dispositivo
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
  // heartbeat
  await supabase
    .from('dispositivos')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', dispositivo.id);

  // 2) Aceita DOIS formatos (compat. entre versões do agente):
  //    - application/json: o corpo É o objeto de dados (agente sem PDF).
  //    - multipart/form-data: campo "dados" (JSON) + "file" (PDF opcional).
  const parsed = await parseIngestRequest(req);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  const dadosJson = parsed.dadosJson;
  const file: File | null = parsed.file;
  const dados = ingestPedidoSchema.safeParse(dadosJson);
  if (!dados.success) {
    return NextResponse.json(
      { error: dados.error.issues[0]?.message ?? 'dados inválidos' },
      { status: 422 },
    );
  }
  const d = dados.data;

  // 3) Pagamento do PDF (se enviado)
  let forma_pagamento: string | null = null;
  let parcelas: string | null = null;
  let buffer: Buffer | null = null;
  if (file instanceof File) {
    if (file.size > MAX_BYTES) return NextResponse.json({ error: 'PDF acima de 10 MB' }, { status: 413 });
    buffer = Buffer.from(await file.arrayBuffer());
    try {
      const { extractText, getDocumentProxy } = await import('unpdf');
      const pdf = await getDocumentProxy(new Uint8Array(buffer));
      const { text: pages } = await extractText(pdf, { mergePages: true });
      const text = Array.isArray(pages) ? pages.join('\n') : (pages ?? '');
      ({ forma_pagamento, parcelas } = extrairPagamentoDoPdfText(text));
    } catch {
      // sem pagamento — segue (vendedor preenche na revisão)
    }
  }

  // 4) Vendedor Hiper → Franzoni (por empresa)
  const { data: map } = await supabase
    .from('hiper_vendedor_map')
    .select('vendedor_id')
    .eq('empresa_id', empresaId)
    .eq('hiper_usuario_id', d.hiper_usuario_id)
    .maybeSingle();
  const vendedorId = map?.vendedor_id as string | undefined;
  if (!vendedorId) {
    return NextResponse.json(
      { error: `Vendedor Hiper ${d.hiper_usuario_id} não mapeado para esta empresa` },
      { status: 422 },
    );
  }

  // 5) Upload do PDF (opcional)
  let storage_pdf_path: string | null = null;
  if (buffer) {
    // Sanitiza documento_erp (vem do agente) — evita path traversal na chave do Storage.
    const safeDoc = (d.documento_erp ?? 'sem-doc').replace(/[^A-Za-z0-9._-]/g, '_');
    const path = `hiper-sync/${empresaId}/${safeDoc}-${Date.now()}.pdf`;
    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(path, buffer, { contentType: 'application/pdf', upsert: false });
    if (!upErr) storage_pdf_path = path;
  }

  // 6) Monta PedidoFormInput e valida
  const formInput: PedidoFormInput = {
    documento_erp: d.documento_erp ?? null,
    data_emissao: d.data_emissao ?? null,
    data_entrega: d.data_entrega ?? null,
    data_entrega_inicio: d.data_entrega_inicio ?? null,
    valor_frete: d.valor_frete ?? 0,
    nf_numero: d.nf_numero ?? null,
    nf_chave: d.nf_chave ?? null,
    nf_emitida_em: d.nf_emitida_em ?? null,
    nf_valor: d.nf_valor ?? null,
    cliente_codigo: d.cliente_codigo ?? null,
    cliente_nome: d.cliente_nome,
    cliente_cnpj_cpf: d.cliente_cnpj_cpf ?? null,
    cliente_endereco: d.cliente_endereco ?? null,
    cliente_bairro: d.cliente_bairro ?? null,
    cliente_cidade: d.cliente_cidade ?? null,
    cliente_uf: d.cliente_uf ?? null,
    cliente_cep: d.cliente_cep ?? null,
    cliente_telefone: d.cliente_telefone ?? null,
    cliente_endereco_id: null,
    // Pagamento estruturado do Hiper (negociacao) tem precedência sobre o do PDF.
    // Texto livre (agente ou PDF) → enum/int via helpers.
    forma_pagamento: mapFormaPagamento(d.forma_pagamento ?? forma_pagamento),
    parcelas: parseParcelas(d.parcelas ?? parcelas),
    // "Receber na entrega": explícito do agente, ou inferido do texto ("ENTREGA A RECEBER").
    receber_na_entrega: d.receber_na_entrega ?? isReceberNaEntrega(d.forma_pagamento ?? forma_pagamento),
    valor_total: d.valor_total,
    observacoes: d.observacoes ?? null,
    storage_pdf_path,
    pontos_retirada: d.pontos_retirada,
  };
  const valid = pedidoFormSchema.safeParse(formInput);
  if (!valid.success) {
    return NextResponse.json(
      { error: valid.error.issues[0]?.message ?? 'pedido inválido' },
      { status: 422 },
    );
  }

  // 7) Insere como 'rascunho' → cai na "Meus Pedidos" do vendedor MAPEADO (passo 4),
  //    que revisa e envia pra logística ("Revisar e enviar" → vira 'pendente').
  //    Decisão Franzoni 2026-06-05: pedido do Hiper passa pelo vendedor antes da logística.
  //    empresa explícita (service_role).
  const r = await inserirPedido(supabase, valid.data, {
    vendedorId,
    status: 'rascunho',
    empresaId,
  });
  if ('error' in r) return NextResponse.json(r, { status: 500 });
  if ('duplicate' in r) {
    return NextResponse.json({ duplicate: true, id: r.existing_id, numero: r.existing_numero }, { status: 200 });
  }
  return NextResponse.json({ id: r.id, numero: r.numero }, { status: 201 });
}
