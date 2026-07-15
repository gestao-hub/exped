import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/types/database';
import type { PedidoFormInput } from '@/lib/validators/pedido';
import { upsertCliente } from '@/lib/clientes/upsert';

export type InserirPedidoResult =
  | { error: string }
  | { id: string; numero: number; updated?: boolean }
  | { duplicate: true; existing_id: string; existing_numero: number };

type ExistingPedido = {
  id: string;
  numero_mapa: number;
  status: string;
  cliente_id: string | null;
};

/** Insere pontos de retirada + itens de um pedido. Reusado pelo INSERT e pelo re-sync (UPSERT). */
async function inserirPontosItens(
  supabase: SupabaseClient<Database>,
  pedidoId: string,
  pontos: PedidoFormInput['pontos_retirada'],
): Promise<string | null> {
  for (let i = 0; i < pontos.length; i++) {
    const ponto = pontos[i];
    const { data: pontoRow, error: pontoErr } = await supabase
      .from('pedido_pontos_retirada')
      .insert({
        pedido_id: pedidoId,
        tipo: ponto.tipo,
        empresa_nome: ponto.empresa_nome,
        endereco: ponto.endereco ?? null,
        ordem: i,
      })
      .select('id')
      .single();
    if (pontoErr || !pontoRow) return `Falha no ponto ${i + 1}: ${pontoErr?.message}`;

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
      if (itErr) return `Falha nos itens do ponto ${i + 1}: ${itErr.message}`;
    }
  }
  return null;
}

/**
 * Insere pedido (cabeçalho + pontos + itens). Reutilizada pela server action
 * (sessão de usuário) e pelo endpoint de ingestão (service_role).
 *
 * - vendedorId: explícito (a action usa auth.uid(); o ingest usa o vendedor mapeado, ou
 *   `null` quando o vendedor do Hiper não está mapeado — aparece sem vendedor em vez de
 *   rejeitar o pedido).
 * - empresaId: opcional. Na sessão de usuário, omitir → a coluna usa o DEFAULT
 *   current_empresa_id(). No ingest (service_role, sem auth.uid()) é OBRIGATÓRIO
 *   passar, senão o DEFAULT resolveria null e violaria o NOT NULL. Quando passado,
 *   também escopa a dedup por empresa (importante porque service_role ignora RLS).
 * - upsertOnDuplicate: o ingest do Hiper passa `true` — quando o documento já existe E o
 *   pedido ainda está em `rascunho` E intocado (1 ponto = default da ingestão), ATUALIZA
 *   cabeçalho + itens (re-sync do Hiper: itens/cliente adicionados depois propagam). Se o
 *   vendedor já mexeu (status ≠ rascunho, ou já dividiu em híbrido = >1 ponto), NÃO
 *   sobrescreve — retorna duplicate. A action de usuário NÃO passa isto (mantém dedup pura).
 * `d` já deve estar validado por pedidoFormSchema.
 */
export async function inserirPedido(
  supabase: SupabaseClient<Database>,
  d: PedidoFormInput,
  opts: {
    vendedorId: string | null;
    status: 'rascunho' | 'pendente' | 'em_financeiro';
    empresaId?: string;
    upsertOnDuplicate?: boolean;
  },
): Promise<InserirPedidoResult> {
  // 1) dedup por documento_erp (não-cancelado, escopo empresa)
  let existing: ExistingPedido | null = null;
  if (d.documento_erp) {
    let q = supabase
      .from('pedidos')
      .select('id, numero_mapa, status, cliente_id')
      .eq('documento_erp', d.documento_erp)
      .neq('status', 'cancelado');
    if (opts.empresaId) q = q.eq('empresa_id', opts.empresaId);
    const { data } = await q.maybeSingle();
    existing = (data as ExistingPedido | null) ?? null;
  }

  // 2) cliente. Re-sync nunca cria outro cadastro: preserva o vínculo atual (inclusive
  // null). Criar cliente antes de decidir se o pedido seria atualizado gerava órfãos.
  let cliente_id: string | null = existing?.cliente_id ?? null;
  if (!existing && !cliente_id) {
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
  }

  // 3) campos de cabeçalho (compartilhados insert/update). SEM status (preservado no update)
  //    e SEM empresa_id (não muda no re-sync).
  const baseFields = {
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
    storage_pdf_path: d.storage_pdf_path ?? null,
    vendedor_id: opts.vendedorId,
  };

  // 4) Já existe (não-cancelado): re-sync (UPSERT) ou duplicate.
  if (existing) {
    const podeAtualizar = opts.upsertOnDuplicate === true && existing.status === 'rascunho';
    if (podeAtualizar) {
      // Intocado pelo vendedor? A ingestão cria SEMPRE 1 ponto; se há >1, o vendedor dividiu
      // em híbrido → NÃO sobrescreve (preserva o trabalho dele).
      const { count } = await supabase
        .from('pedido_pontos_retirada')
        .select('id', { count: 'exact', head: true })
        .eq('pedido_id', existing.id)
        .is('deleted_at', null);
      if ((count ?? 0) <= 1) {
        const updateObj: Database['public']['Tables']['pedidos']['Update'] = { ...baseFields };
        if (d.exige_emissao !== undefined) updateObj.exige_emissao = d.exige_emissao;
        const { error: upErr } = await supabase.from('pedidos').update(updateObj).eq('id', existing.id);
        if (upErr) return { error: upErr.message };

        // substitui pontos + itens pelo estado atual do Hiper
        const { data: pontosAntigos } = await supabase
          .from('pedido_pontos_retirada')
          .select('id')
          .eq('pedido_id', existing.id)
          .is('deleted_at', null);
        const ids = (pontosAntigos ?? []).map((p) => p.id as string);
        if (ids.length) {
          const now = new Date().toISOString();
          const { error: itemArchiveError } = await supabase
            .from('pedido_itens')
            .update({ deleted_at: now })
            .in('ponto_retirada_id', ids)
            .is('deleted_at', null);
          if (itemArchiveError) return { error: `Falha ao arquivar itens: ${itemArchiveError.message}` };

          const { error: pointArchiveError } = await supabase
            .from('pedido_pontos_retirada')
            .update({ deleted_at: now })
            .in('id', ids);
          if (pointArchiveError) return { error: `Falha ao arquivar pontos: ${pointArchiveError.message}` };
        }

        const err = await inserirPontosItens(supabase, existing.id, d.pontos_retirada);
        if (err) return { error: err };
        return { id: existing.id, numero: existing.numero_mapa, updated: true };
      }
    }
    return { duplicate: true, existing_id: existing.id, existing_numero: existing.numero_mapa };
  }

  // 5) INSERT novo
  const insertRow: Database['public']['Tables']['pedidos']['Insert'] = {
    ...baseFields,
    status: opts.status,
  };
  if (opts.empresaId) insertRow.empresa_id = opts.empresaId;
  // exige_emissao SÓ entra quando o VENDEDOR marcou (o agente Hiper não envia → pega o
  // DEFAULT false e a ingestão fica imune ao schema cache velho do PostgREST do hub).
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

  const err = await inserirPontosItens(supabase, pedido.id as string, d.pontos_retirada);
  if (err) return { error: err };

  return { id: pedido.id as string, numero: pedido.numero_mapa as number };
}
