import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/types/database';
import type { PedidoFormInput } from '@/lib/validators/pedido';
import { upsertCliente } from '@/lib/clientes/upsert';

export type InserirPedidoResult =
  | { error: string }
  | { id: string; numero: number }
  | { duplicate: true; existing_id: string; existing_numero: number };

/**
 * Insere pedido (cabeçalho + pontos + itens). Reutilizada pela server action
 * (sessão de usuário) e pelo endpoint de ingestão (service_role).
 *
 * - vendedorId: explícito (a action usa auth.uid(); o ingest usa o vendedor mapeado).
 * - empresaId: opcional. Na sessão de usuário, omitir → a coluna usa o DEFAULT
 *   current_empresa_id(). No ingest (service_role, sem auth.uid()) é OBRIGATÓRIO
 *   passar, senão o DEFAULT resolveria null e violaria o NOT NULL. Quando passado,
 *   também escopa a dedup por empresa (importante porque service_role ignora RLS).
 * `d` já deve estar validado por pedidoFormSchema.
 */
export async function inserirPedido(
  supabase: SupabaseClient<Database>,
  d: PedidoFormInput,
  opts: { vendedorId: string; status: 'rascunho' | 'pendente' | 'em_financeiro'; empresaId?: string },
): Promise<InserirPedidoResult> {
  if (d.documento_erp) {
    let q = supabase
      .from('pedidos')
      .select('id, numero_mapa')
      .eq('documento_erp', d.documento_erp)
      .neq('status', 'cancelado');
    if (opts.empresaId) q = q.eq('empresa_id', opts.empresaId);
    const { data: existing } = await q.maybeSingle();
    if (existing) {
      return {
        duplicate: true,
        existing_id: existing.id as string,
        existing_numero: existing.numero_mapa as number,
      };
    }
  }

  let cliente_id: string | null = null;
  try {
    const { id } = await upsertCliente(supabase, {
      cnpj_cpf: d.cliente_cnpj_cpf,
      codigo_erp: d.cliente_codigo,
      nome: d.cliente_nome,
      endereco: d.cliente_endereco,
      bairro: d.cliente_bairro,
      cidade: d.cliente_cidade,
      uf: d.cliente_uf,
      cep: d.cliente_cep,
      telefone: d.cliente_telefone,
    }, opts.empresaId);
    cliente_id = id;
  } catch {
    cliente_id = null;
  }

  const insertRow: Database['public']['Tables']['pedidos']['Insert'] = {
    documento_erp: d.documento_erp ?? null,
    data_emissao: d.data_emissao ?? null,
    data_entrega: d.data_entrega ?? null,
    cliente_codigo: d.cliente_codigo ?? null,
    cliente_nome: d.cliente_nome,
    cliente_cnpj_cpf: d.cliente_cnpj_cpf ?? null,
    cliente_endereco: d.cliente_endereco ?? null,
    cliente_bairro: d.cliente_bairro ?? null,
    cliente_cidade: d.cliente_cidade ?? null,
    cliente_uf: d.cliente_uf ?? null,
    cliente_cep: d.cliente_cep ?? null,
    cliente_telefone: d.cliente_telefone ?? null,
    cliente_id,
    cliente_endereco_id: d.cliente_endereco_id ?? null,
    forma_pagamento: d.forma_pagamento ?? null,
    parcelas: d.parcelas ?? null,
    receber_na_entrega: d.receber_na_entrega ?? false,
    valor_total: d.valor_total,
    valor_frete: d.valor_frete ?? 0,
    data_entrega_inicio: d.data_entrega_inicio ?? null,
    nf_numero: d.nf_numero ?? null,
    nf_chave: d.nf_chave ?? null,
    nf_emitida_em: d.nf_emitida_em ?? null,
    nf_valor: d.nf_valor ?? null,
    observacoes: d.observacoes ?? null,
    status: opts.status,
    storage_pdf_path: d.storage_pdf_path ?? null,
    vendedor_id: opts.vendedorId,
  };
  if (opts.empresaId) insertRow.empresa_id = opts.empresaId;
  // exige_emissao SÓ entra no INSERT quando o VENDEDOR marcou no form (d definido).
  // O agente Hiper NÃO envia esse campo → fica de fora e pega o DEFAULT false do banco.
  // Assim a INGESTÃO não referencia a coluna e fica imune ao schema cache velho do
  // PostgREST do hub (o erro "Could not find the 'exige_emissao' column ... in the
  // schema cache" que derrubava pedidos do Hiper). O vendedor segue podendo marcar.
  if (d.exige_emissao !== undefined) insertRow.exige_emissao = d.exige_emissao;

  const { data: pedido, error: insErr } = await supabase
    .from('pedidos')
    .insert(insertRow)
    .select('id, numero_mapa')
    .single();

  if (insErr || !pedido) {
    if (insErr?.code === '23505' && insErr.message.includes('pedidos_documento_erp_uniq')) {
      return {
        error: `Já existe um pedido ativo com o documento ${d.documento_erp}. Ele pode ter sido criado por outro vendedor — fale com um admin se precisar reaproveitar este documento.`,
      };
    }
    return { error: insErr?.message ?? 'Falha ao criar pedido' };
  }

  for (let i = 0; i < d.pontos_retirada.length; i++) {
    const ponto = d.pontos_retirada[i];
    const { data: pontoRow, error: pontoErr } = await supabase
      .from('pedido_pontos_retirada')
      .insert({
        pedido_id: pedido.id,
        tipo: ponto.tipo,
        empresa_nome: ponto.empresa_nome,
        endereco: ponto.endereco ?? null,
        ordem: i,
      })
      .select('id')
      .single();
    if (pontoErr || !pontoRow) return { error: `Falha no ponto ${i + 1}: ${pontoErr?.message}` };

    if (ponto.itens.length > 0) {
      const itensPayload = ponto.itens.map((it, idx) => ({
        ponto_retirada_id: pontoRow.id,
        codigo: it.codigo,
        descricao: it.descricao,
        quantidade: it.quantidade,
        unidade: it.unidade,
        preco_unitario: it.preco_unitario,
        desconto: it.desconto,
        total: it.total,
        // Modalidade é a fonte da verdade do item; sem isto o DEFAULT 'loja' do banco
        // sobrescreveria itens imediato/entrega ao criar (some a info no reload).
        modalidade: it.modalidade,
        referencia: it.referencia ?? null,
        saldo_estoque: it.saldo_estoque ?? null,
        ordem: idx,
      }));
      const { error: itErr } = await supabase.from('pedido_itens').insert(itensPayload);
      if (itErr) return { error: `Falha nos itens do ponto ${i + 1}: ${itErr.message}` };
    }
  }

  return { id: pedido.id as string, numero: pedido.numero_mapa as number };
}
