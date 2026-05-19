import { NextResponse, type NextRequest } from 'next/server';
import { format } from 'date-fns';
import { createClient } from '@/lib/supabase/server';
import type { PedidoStatus } from '@/lib/types';

const VALID_STATUS: PedidoStatus[] = ['rascunho', 'pendente', 'em_separacao', 'parcialmente_entregue', 'finalizado', 'cancelado'];

export const runtime = 'nodejs';

/**
 * GET /historico/export?from=YYYY-MM-DD&to=YYYY-MM-DD&status=finalizado
 *
 * Devolve CSV com pedidos filtrados (default: finalizados, sem range).
 * Respeita RLS — vendedor vê só os dele, logistica/admin vêem todos.
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

  let query = supabase
    .from('pedidos')
    .select(
      `numero_mapa, documento_erp, data_emissao, data_entrega,
       cliente_nome, cliente_cnpj_cpf, cliente_bairro, cliente_cidade, cliente_uf,
       forma_pagamento, parcelas, valor_total, status, observacoes,
       created_at,
       logistica:pedido_logistica(motorista, veiculo, conferente, regiao, km_inicial, km_final, peso_bruto_total, peso_liquido_total, observacoes)`,
    )
    .order('created_at', { ascending: false })
    .limit(50_000);

  if (status !== 'todos' && (VALID_STATUS as string[]).includes(status)) {
    query = query.eq('status', status as PedidoStatus);
  }
  if (from) query = query.gte('data_entrega', from);
  if (to) query = query.lte('data_entrega', to);

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Monta CSV
  const headers = [
    'Mapa',
    'Documento ERP',
    'Data Emissão',
    'Data Entrega',
    'Cliente',
    'CNPJ/CPF',
    'Bairro',
    'Cidade',
    'UF',
    'Forma Pagamento',
    'Parcelas',
    'Valor (R$)',
    'Status',
    'Motorista',
    'Veículo',
    'Conferente',
    'Região',
    'Km Inicial',
    'Km Final',
    'Peso Bruto Total',
    'Peso Líquido Total',
    'Observações Pedido',
    'Observações Logística',
    'Criado em',
  ];

  const lines: string[] = [headers.join(';')];
  for (const p of (data ?? []) as Array<Record<string, unknown>>) {
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
      typeof p.valor_total === 'number'
        ? p.valor_total.toFixed(2).replace('.', ',')
        : p.valor_total,
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
    lines.push(row.map(csvCell).join(';'));
  }

  // BOM UTF-8 pra Excel reconhecer acentos
  const csv = '﻿' + lines.join('\r\n');
  const dt = format(new Date(), 'yyyyMMdd-HHmm');
  const filename = `franzoni-historico-${dt}.csv`;

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * Escapa célula CSV (RFC 4180-ish): aspas duplas e vírgulas/quebra de linha
 * forçam quoting; aspas dentro do conteúdo viram duplas.
 */
function csvCell(v: unknown): string {
  if (v == null || v === '') return '';
  const s = String(v);
  if (/[;"\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
