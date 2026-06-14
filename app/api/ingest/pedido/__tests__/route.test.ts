import { describe, it, expect, vi, beforeEach } from 'vitest';

// Estado dos "selects" mockados (lido lazy dentro dos métodos → sem problema de hoisting).
let deviceRow: { id: string; empresa_id: string; ativo: boolean } | null = null;
let vendedorRow: { vendedor_id: string } | null = null;

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
      // dispositivos (auth + heartbeat)
      return {
        select() { return this; },
        eq() { return this; },
        async maybeSingle() { return { data: deviceRow }; },
        update() { return { eq: async () => ({ data: null }) }; },
      };
    },
    // upload do PDF (caminho multipart) — best-effort, devolve sucesso no teste
    storage: { from: () => ({ upload: async () => ({ error: null }) }) },
  }),
}));

const inserirPedido = vi.fn();
vi.mock('@/lib/pedidos/inserir', () => ({
  inserirPedido: (...args: unknown[]) => inserirPedido(...args),
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
  });

  it('vendedor Hiper não mapeado → 422 (não cria pedido)', async () => {
    vendedorRow = null;
    const res = await POST(req(payloadAgente(), 'tok') as never);
    expect(res.status).toBe(422);
    expect(inserirPedido).not.toHaveBeenCalled();
  });
});
