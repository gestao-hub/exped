import { NextResponse, type NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { ingestPedidoSchema } from '@/lib/validators/ingest';
import { pedidoFormSchema, type PedidoFormInput } from '@/lib/validators/pedido';
import { extrairPagamentoDoPdfText } from '@/lib/parser/extrair-pagamento';
import { mapFormaPagamento, parseParcelas, isReceberNaEntrega } from '@/lib/parser/forma-pagamento';
import { calcularHashSnapshotIngest, inserirPedido } from '@/lib/pedidos/inserir';
import { parseIngestRequest } from '@/lib/ingest/parse-request';

export const runtime = 'nodejs';
export const maxDuration = 30;

const MAX_BYTES = 10 * 1024 * 1024;
const BUCKET = 'pedidos-pdfs';

type PedidoPdfAttachResolution = {
  attached: boolean;
  reason?: 'already_attached' | 'protected' | 'snapshot_changed' | 'not_found';
};

type PedidoPdfAttachRpcClient = {
  rpc(
    name: 'attach_pedido_ingest_pdf',
    args: {
      p_pedido_id: string;
      p_empresa: string;
      p_expected_hash: string;
      p_storage_pdf_path: string;
    },
  ): Promise<{ data: unknown; error: { message?: string } | null }>;
};

/**
 * Injeta `modalidade: 'loja'` em itens que não trazem o campo (payload do agente Hiper,
 * que não conhece o conceito). Mutação in-place no JSON cru, ANTES da validação Zod — o
 * schema do item exige `modalidade`. Tolerante ao formato: só mexe onde a estrutura bate
 * e nunca lança (validação real fica para o `safeParse`).
 */
function preencherModalidadePadrao(dadosJson: unknown): void {
  if (!dadosJson || typeof dadosJson !== 'object') return;
  const pontos = (dadosJson as { pontos_retirada?: unknown }).pontos_retirada;
  if (!Array.isArray(pontos)) return;
  for (const ponto of pontos) {
    if (!ponto || typeof ponto !== 'object') continue;
    const itens = (ponto as { itens?: unknown }).itens;
    if (!Array.isArray(itens)) continue;
    for (const item of itens) {
      if (item && typeof item === 'object' && (item as { modalidade?: unknown }).modalidade == null) {
        (item as { modalidade?: string }).modalidade = 'loja';
      }
    }
  }
}

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
  // Retrocompat: o agente Hiper NÃO envia `modalidade` por item (esse campo é novo e vive
  // só no Exped — Hiper não tem o conceito). O schema do item exige modalidade, então
  // injetamos o default 'loja' por item ANTES de validar. Pedido do Hiper sempre entra como
  // 'loja' (retirada); o vendedor reclassifica itens p/ entrega/imediato na revisão.
  preencherModalidadePadrao(dadosJson);
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

  // 4) Vendedor Hiper → Franzoni (por empresa).
  // Vendedor NÃO mapeado: NÃO rejeita (o 422 derrubava o pedido — ele nunca caía no Exped).
  // Entra com vendedor_id NULL (aparece sem vendedor; admin/caixa pode atribuir). Mapear o
  // usuário no hiper_vendedor_map faz o vendedor real aparecer.
  const { data: map } = await supabase
    .from('hiper_vendedor_map')
    .select('vendedor_id')
    .eq('empresa_id', empresaId)
    .eq('hiper_usuario_id', d.hiper_usuario_id)
    .maybeSingle();
  const vendedorId = (map?.vendedor_id as string | undefined) ?? null;

  // 5) Monta PedidoFormInput e valida. O PDF e persistido somente depois que o
  // snapshot for aceito; um backfill identico nao deve criar objetos orfaos.
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
    storage_pdf_path: null,
    pontos_retirada: d.pontos_retirada,
  };
  const valid = pedidoFormSchema.safeParse(formInput);
  if (!valid.success) {
    return NextResponse.json(
      { error: valid.error.issues[0]?.message ?? 'pedido inválido' },
      { status: 422 },
    );
  }

  // 6) Insere como 'rascunho' → cai na "Meus Pedidos" do vendedor MAPEADO (passo 4),
  //    que revisa e envia pra logística ("Revisar e enviar" → vira 'pendente').
  //    Decisão Franzoni 2026-06-05: pedido do Hiper passa pelo vendedor antes da logística.
  //    empresa explícita (service_role).
  //    upsertOnDuplicate: re-sync do Hiper atualiza o pedido (itens/cliente que entraram
  //    depois) ENQUANTO estiver em rascunho e intocado — senão preserva o trabalho do vendedor.
  const r = await inserirPedido(supabase, valid.data, {
    vendedorId,
    status: 'rascunho',
    empresaId,
    upsertOnDuplicate: true,
  });
  if ('error' in r) return NextResponse.json(r, { status: 500 });

  const persistirPdf = async (
    pedidoId: string,
    expectedHash: string,
  ): Promise<string | null> => {
    if (!buffer) return null;

    const safeDoc = (d.documento_erp ?? 'sem-doc').replace(/[^A-Za-z0-9._-]/g, '_');
    // A chave deterministica impede que retries ou chamadas concorrentes
    // acumulem blobs: o mesmo snapshot sempre reutiliza o mesmo objeto.
    const path = `hiper-sync/${empresaId}/${safeDoc}-${expectedHash}.pdf`;
    const storage = supabase.storage.from(BUCKET);
    const { error: upErr } = await storage.upload(path, buffer, {
      contentType: 'application/pdf',
      upsert: true,
    });
    if (upErr) return `Falha temporaria ao armazenar PDF: ${upErr.message}`;

    const { data, error } = await (supabase as unknown as PedidoPdfAttachRpcClient).rpc(
      'attach_pedido_ingest_pdf',
      {
        p_pedido_id: pedidoId,
        p_empresa: empresaId,
        p_expected_hash: expectedHash,
        p_storage_pdf_path: path,
      },
    );
    if (error) return `Falha temporaria ao vincular PDF: ${error.message ?? 'desconhecida'}`;
    if (!data || typeof data !== 'object' || typeof (data as { attached?: unknown }).attached !== 'boolean') {
      return 'Falha temporaria ao vincular PDF: resposta invalida';
    }

    const resolution = data as PedidoPdfAttachResolution;
    if (!resolution.attached && resolution.reason === 'not_found') {
      return 'Falha temporaria ao vincular PDF: pedido nao encontrado';
    }
    // protected/snapshot_changed significam que uma edicao venceu a corrida.
    // O objeto deterministico pode ser reutilizado, sem alterar o pedido protegido.
    return null;
  };

  if ('duplicate' in r) {
    // Um pedido pode ter sido aceito antes de uma indisponibilidade do Storage.
    // O hash impede recriar filhos, mas um caminho explicitamente nulo permite
    // que o mesmo backfill complete apenas o PDF ausente.
    if (buffer && r.pdfRecoveryHash) {
      const pdfError = await persistirPdf(r.existing_id, r.pdfRecoveryHash);
      if (pdfError) return NextResponse.json({ error: pdfError }, { status: 503 });
    }
    return NextResponse.json({ duplicate: true, id: r.existing_id, numero: r.existing_numero }, { status: 200 });
  }

  // 7) O snapshot mudou ou foi criado: agora o PDF pode ser armazenado sem gerar
  // um novo arquivo a cada rechecagem identica. Um vinculo tardio so tenta o
  // upload quando o pedido ainda declara explicitamente que nao possui PDF.
  if (buffer && (r.snapshotChanged !== false || r.previousPdfPath === null)) {
    const pdfHash = r.pdfRecoveryHash ?? calcularHashSnapshotIngest(valid.data, vendedorId);
    const pdfError = await persistirPdf(r.id, pdfHash);
    if (pdfError) return NextResponse.json({ error: pdfError }, { status: 503 });
  }

  // updated=true → re-sync atualizou um pedido existente (200); senão criou novo (201).
  return NextResponse.json({ id: r.id, numero: r.numero }, { status: r.updated ? 200 : 201 });
}
