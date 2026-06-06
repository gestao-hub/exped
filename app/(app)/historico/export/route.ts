import { NextResponse, type NextRequest } from 'next/server';
import { format } from 'date-fns';
import { createClient } from '@/lib/supabase/server';
import type { PedidoStatus } from '@/lib/types';

const VALID_STATUS: PedidoStatus[] = ['rascunho', 'em_financeiro', 'pendente', 'em_separacao', 'em_transporte', 'parcialmente_entregue', 'finalizado', 'cancelado'];
// Status "terminais" (finitos) podem exportar sem período; os demais (e 'todos') exigem from+to
// pra não varrer a base inteira em volume.
const TERMINAL = new Set(['finalizado', 'cancelado']);
const PAGE = 1000;

const SELECT = `numero_mapa, documento_erp, data_emissao, data_entrega,
  cliente_nome, cliente_cnpj_cpf, cliente_bairro, cliente_cidade, cliente_uf,
  forma_pagamento, parcelas, valor_total, status, observacoes,
  created_at,
  logistica:pedido_logistica(motorista, veiculo, conferente, regiao, km_inicial, km_final, peso_bruto_total, peso_liquido_total, observacoes)`;

const HEADERS = [
  'Nº', 'Documento ERP', 'Data Emissão', 'Data Entrega', 'Cliente', 'CNPJ/CPF', 'Bairro', 'Cidade', 'UF',
  'Forma Pagamento', 'Parcelas', 'Valor (R$)', 'Status', 'Motorista', 'Veículo', 'Conferente', 'Região',
  'Km Inicial', 'Km Final', 'Peso Bruto Total', 'Peso Líquido Total', 'Observações Pedido',
  'Observações Logística', 'Criado em',
];

export const runtime = 'nodejs';

/**
 * GET /historico/export?from=YYYY-MM-DD&to=YYYY-MM-DD&status=finalizado
 *
 * CSV em STREAMING (páginas de 1000) — não carrega tudo em memória. Respeita RLS
 * (vendedor vê só os dele; logística/admin veem todos). Status não-terminal exige período.
 */
export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Não autenticado' }, { status: 401 });
  }

  const sp = req.nextUrl.searchParams;
  const from = sp.get('from');
  const to = sp.get('to');
  const status = sp.get('status') ?? 'finalizado';

  if (!TERMINAL.has(status) && !(from && to)) {
    return NextResponse.json(
      { error: 'Informe um período (from e to) para exportar este status.' },
      { status: 400 },
    );
  }

  function pageQuery(offset: number) {
    let q = supabase
      .from('pedidos')
      .select(SELECT)
      .order('created_at', { ascending: false })
      .range(offset, offset + PAGE - 1);
    if (status !== 'todos' && (VALID_STATUS as string[]).includes(status)) {
      q = q.eq('status', status as PedidoStatus);
    }
    if (from) q = q.gte('data_entrega', from);
    if (to) q = q.lte('data_entrega', to);
    return q;
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        // BOM UTF-8 (Excel) + cabeçalho
        controller.enqueue(encoder.encode('﻿' + HEADERS.join(';') + '\r\n'));
        let offset = 0;
        for (;;) {
          const { data, error } = await pageQuery(offset);
          if (error) throw new Error(error.message);
          const rows = (data ?? []) as Array<Record<string, unknown>>;
          if (rows.length === 0) break;
          controller.enqueue(encoder.encode(rows.map(pedidoToLine).join('\r\n') + '\r\n'));
          if (rows.length < PAGE) break;
          offset += PAGE;
        }
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });

  const dt = format(new Date(), 'yyyyMMdd-HHmm');
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="franzoni-historico-${dt}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}

/** Monta uma linha CSV (`;`-separada) de um pedido + sua logística embutida. */
function pedidoToLine(p: Record<string, unknown>): string {
  const log = Array.isArray(p.logistica)
    ? (p.logistica[0] as Record<string, unknown> | undefined)
    : (p.logistica as Record<string, unknown> | undefined);
  const row = [
    p.numero_mapa,
    p.documento_erp,
    p.data_emissao,
    p.data_entrega,
    p.cliente_nome,
    p.cliente_cnpj_cpf,
    p.cliente_bairro,
    p.cliente_cidade,
    p.cliente_uf,
    p.forma_pagamento,
    p.parcelas,
    typeof p.valor_total === 'number' ? p.valor_total.toFixed(2).replace('.', ',') : p.valor_total,
    p.status,
    log?.motorista,
    log?.veiculo,
    log?.conferente,
    log?.regiao,
    log?.km_inicial,
    log?.km_final,
    log?.peso_bruto_total,
    log?.peso_liquido_total,
    p.observacoes,
    log?.observacoes,
    p.created_at,
  ];
  return row.map(csvCell).join(';');
}

/**
 * Escapa célula CSV (RFC 4180-ish): aspas duplas e `;`/quebra de linha forçam quoting;
 * aspas dentro do conteúdo viram duplas.
 */
function csvCell(v: unknown): string {
  if (v == null || v === '') return '';
  const s = String(v);
  if (/[;"\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
