import { describe, it, expect, vi, beforeEach } from 'vitest';

// Estado dos "selects" mockados (lido lazy dentro dos métodos → sem problema de hoisting).
let deviceRow: { id: string; empresa_id: string; ativo: boolean } | null = null;
let vendedorRow: { vendedor_id: string } | null = null;
const upload = vi.fn();
const attachPdf = vi.fn();

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from(table: string) {
      if (table === 'hiper_vendedor_map') {
        return {
          select() { return this; },
          eq() { return this; },
          async maybeSingle() { return { data: vendedorRow }; },
        };
      }
      if (table === 'pedidos') {
        const query = {
          update() { return query; },
          eq() { return query; },
          then(resolve: (value: { error: null }) => unknown) {
            return Promise.resolve({ error: null }).then(resolve);
          },
        };
        return query;
      }
      // dispositivos (auth + heartbeat)
      return {
        select() { return this; },
        eq() { return this; },
        async maybeSingle() { return { data: deviceRow }; },
        update() { return { eq: async () => ({ data: null }) }; },
      };
    },
    // upload do PDF (caminho multipart) — best-effort, devolve sucesso no teste
    storage: {
      from: () => ({
        upload: (...args: unknown[]) => upload(...args),
      }),
    },
    rpc: (...args: unknown[]) => attachPdf(...args),
  }),
}));

const inserirPedido = vi.fn();
vi.mock('@/lib/pedidos/inserir', () => ({
  inserirPedido: (...args: unknown[]) => inserirPedido(...args),
  calcularHashSnapshotIngest: () => 'd'.repeat(64),
}));

import { POST } from '../route';
import { ingestPedidoSchema } from '@/lib/validators/ingest';

/** Payload como o agente Hiper manda: itens SEM `modalidade` (campo só existe no Exped). */
function payloadAgente(): Record<string, unknown> {
  return {
    documento_erp: 'L4077',
    hiper_usuario_id: 3,
    cliente_nome: 'Cliente Teste',
    valor_total: 100,
    pontos_retirada: [
      {
        tipo: 'loja',
        empresa_nome: 'Loja Centro',
        itens: [
          // sem `modalidade` de propósito — é o caso de regressão (agente não envia)
          { codigo: 'A1', descricao: 'Cimento', quantidade: 2, unidade: 'UN', preco_unitario: 50, desconto: 0, total: 100 },
        ],
      },
    ],
  };
}

function req(body: unknown, token?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request('http://127.0.0.1:3000/api/ingest/pedido', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

/** Monta um POST multipart/form-data (campo 'dados' JSON + 'file' PDF) — é o transporte
 *  que o agente Hiper usa em produção quando há PDF do pedido. */
function multipartReq(body: unknown, token: string): Request {
  const CRLF = '\r\n';
  const boundary = '----exped-test-boundary';
  const parts = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="dados"',
    'Content-Type: text/plain; charset=utf-8',
    '',
    JSON.stringify(body),
    `--${boundary}`,
    'Content-Disposition: form-data; name="file"; filename="pedido.pdf"',
    'Content-Type: application/pdf',
    '',
    '%PDF-1.4 fake',
    `--${boundary}--`,
    '',
  ];
  return new Request('http://127.0.0.1:3000/api/ingest/pedido', {
    method: 'POST',
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      authorization: `Bearer ${token}`,
    },
    body: parts.join(CRLF),
  });
}

beforeEach(() => {
  deviceRow = { id: 'D1', empresa_id: 'E1', ativo: true };
  vendedorRow = { vendedor_id: 'V1' };
  inserirPedido.mockReset();
  upload.mockReset().mockResolvedValue({ error: null });
  attachPdf.mockReset().mockResolvedValue({ data: { attached: true }, error: null });
});

describe('POST /api/ingest/pedido — modalidade por item (retrocompat do agente)', () => {
  it('documenta o motivo da injeção: o schema EXIGE modalidade no item', () => {
    // Se isto passar a aceitar item sem modalidade, a injeção no endpoint vira redundante.
    expect(ingestPedidoSchema.safeParse(payloadAgente()).success).toBe(false);
  });

  it('item sem modalidade → endpoint injeta "loja" e cria o pedido (201)', async () => {
    inserirPedido.mockResolvedValue({ id: 'P1', numero: 42 });
    const res = await POST(req(payloadAgente(), 'tok') as never);
    expect(res.status).toBe(201);
    expect(inserirPedido).toHaveBeenCalledOnce();
    // inserirPedido(supabase, valid.data, opts) → 2º arg é o pedido já validado.
    const validado = inserirPedido.mock.calls[0][1] as {
      pontos_retirada: { itens: { modalidade: string }[] }[];
    };
    expect(validado.pontos_retirada[0].itens[0].modalidade).toBe('loja');
  });

  it('modalidade explícita NÃO é sobrescrita pela injeção', async () => {
    inserirPedido.mockResolvedValue({ id: 'P2', numero: 43 });
    const payload = payloadAgente();
    (payload.pontos_retirada as { itens: { modalidade?: string }[] }[])[0].itens[0].modalidade = 'entrega';
    const res = await POST(req(payload, 'tok') as never);
    expect(res.status).toBe(201);
    const validado = inserirPedido.mock.calls[0][1] as {
      pontos_retirada: { itens: { modalidade: string }[] }[];
    };
    expect(validado.pontos_retirada[0].itens[0].modalidade).toBe('entrega');
  });

  it('multipart com PDF (transporte real do agente) → injeta "loja" e cria o pedido (201)', async () => {
    inserirPedido.mockResolvedValue({ id: 'P3', numero: 44 });
    const res = await POST(multipartReq(payloadAgente(), 'tok') as never);
    expect(res.status).toBe(201);
    expect(inserirPedido).toHaveBeenCalledOnce();
    const validado = inserirPedido.mock.calls[0][1] as {
      pontos_retirada: { itens: { modalidade: string }[] }[];
    };
    expect(validado.pontos_retirada[0].itens[0].modalidade).toBe('loja');
    expect(upload).toHaveBeenCalledOnce();
    expect(attachPdf).toHaveBeenCalledWith('attach_pedido_ingest_pdf', expect.objectContaining({
      p_pedido_id: 'P3',
      p_storage_pdf_path: expect.any(String),
    }));
  });

  it('backfill duplicado com PDF nao faz novo upload', async () => {
    inserirPedido.mockResolvedValue({ duplicate: true, existing_id: 'P3', existing_numero: 44 });

    const res = await POST(multipartReq(payloadAgente(), 'tok') as never);

    expect(res.status).toBe(200);
    expect(upload).not.toHaveBeenCalled();
    expect(attachPdf).not.toHaveBeenCalled();
  });

  it('backfill duplicado recupera o PDF quando o caminho segue nulo', async () => {
    inserirPedido.mockResolvedValue({
      duplicate: true,
      existing_id: 'P3',
      existing_numero: 44,
      existingPdfPath: 'hiper-sync/E1/pdf-do-snapshot-antigo.pdf',
      pdfRecoveryHash: 'a'.repeat(64),
    });

    const res = await POST(multipartReq(payloadAgente(), 'tok') as never);

    expect(res.status).toBe(200);
    expect(upload).toHaveBeenCalledOnce();
    expect(attachPdf).toHaveBeenCalledOnce();
  });

  it('pedido protegido com PDF nulo nao recebe recuperacao fora da guarda transacional', async () => {
    inserirPedido.mockResolvedValue({
      duplicate: true,
      existing_id: 'P3',
      existing_numero: 44,
      existingPdfPath: null,
    });

    const res = await POST(multipartReq(payloadAgente(), 'tok') as never);

    expect(res.status).toBe(200);
    expect(upload).not.toHaveBeenCalled();
    expect(attachPdf).not.toHaveBeenCalled();
  });

  it('falha no upload devolve erro recuperavel para o agente tentar novamente', async () => {
    upload.mockResolvedValue({ error: { message: 'storage indisponivel' } });
    inserirPedido.mockResolvedValue({
      duplicate: true,
      existing_id: 'P3',
      existing_numero: 44,
      existingPdfPath: null,
      pdfRecoveryHash: 'b'.repeat(64),
    });

    const res = await POST(multipartReq(payloadAgente(), 'tok') as never);

    expect(res.status).toBe(503);
    expect(attachPdf).not.toHaveBeenCalled();
  });

  it('falha ao vincular o caminho devolve erro e reutiliza o mesmo objeto no retry', async () => {
    attachPdf.mockResolvedValue({ data: null, error: { message: 'banco indisponivel' } });
    inserirPedido.mockResolvedValue({
      duplicate: true,
      existing_id: 'P3',
      existing_numero: 44,
      existingPdfPath: null,
      pdfRecoveryHash: 'c'.repeat(64),
    });

    const first = await POST(multipartReq(payloadAgente(), 'tok') as never);
    const second = await POST(multipartReq(payloadAgente(), 'tok') as never);

    expect(first.status).toBe(503);
    expect(second.status).toBe(503);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls[0][0]).toBe(upload.mock.calls[1][0]);
    expect(upload.mock.calls[0][2]).toMatchObject({ upsert: true });
  });

  it('vinculo tardio do cliente nao armazena outra copia do mesmo PDF', async () => {
    inserirPedido.mockResolvedValue({
      id: 'P3',
      numero: 44,
      updated: true,
      snapshotChanged: false,
    });

    const res = await POST(multipartReq(payloadAgente(), 'tok') as never);

    expect(res.status).toBe(200);
    expect(upload).not.toHaveBeenCalled();
    expect(attachPdf).not.toHaveBeenCalled();
  });

  it('vendedor Hiper não mapeado → ainda cria o pedido com vendedor nulo (não 422)', async () => {
    // Mudança 2026-06-17: o 422 derrubava o pedido (nunca caía). Agora entra com
    // vendedor_id null (aparece sem vendedor; admin/caixa atribui).
    vendedorRow = null;
    inserirPedido.mockResolvedValue({ id: 'P9', numero: 99 });
    const res = await POST(req(payloadAgente(), 'tok') as never);
    expect(res.status).toBe(201);
    expect(inserirPedido).toHaveBeenCalledOnce();
    const opts = inserirPedido.mock.calls[0][2] as { vendedorId: string | null };
    expect(opts.vendedorId).toBeNull();
  });
});
