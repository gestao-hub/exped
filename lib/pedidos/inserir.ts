import type { SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import type { Database } from '@/lib/types/database';
import type { PedidoFormInput } from '@/lib/validators/pedido';
import { upsertCliente } from '@/lib/clientes/upsert';

export type InserirPedidoResult =
  | { error: string }
  | {
      id: string;
      numero: number;
      updated?: boolean;
      snapshotChanged?: boolean;
      previousPdfPath?: string | null;
      pdfRecoveryHash?: string;
    }
  | {
      duplicate: true;
      existing_id: string;
      existing_numero: number;
      existingPdfPath?: string | null;
      pdfRecoveryHash?: string;
    };

type ExistingPedido = {
  id: string;
  numero_mapa: number;
  status: string;
  cliente_id: string | null;
  ingest_pdf_snapshot_hash: string | null;
  ingest_snapshot_hash: string | null;
  storage_pdf_path: string | null;
};

type PedidoResyncResolution = {
  updated: boolean;
  reason?: 'protected' | 'not_found' | 'unchanged' | 'client_resolved' | 'client_unresolved';
  snapshot_changed?: boolean;
  id?: string;
  numero?: number;
};

/**
 * Identifica o estado de negocio recebido do Hiper sem campos volateis. IDs locais,
 * caminho do PDF e saldo de estoque nao representam alteracao do pedido e, portanto,
 * nao podem disparar a recriacao dos filhos durante o backfill.
 */
export function calcularHashSnapshotIngest(
  d: PedidoFormInput,
  vendedorId: string | null,
): string {
  const snapshot = {
    header: {
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
      cliente_endereco_id: d.cliente_endereco_id ?? null,
      forma_pagamento: d.forma_pagamento ?? null,
      parcelas: d.parcelas ?? null,
      receber_na_entrega: d.receber_na_entrega ?? false,
      exige_emissao: d.exige_emissao ?? null,
      valor_total: d.valor_total,
      observacoes: d.observacoes ?? null,
      vendedor_id: vendedorId,
    },
    pontos_retirada: d.pontos_retirada.map((ponto) => ({
      tipo: ponto.tipo,
      empresa_nome: ponto.empresa_nome,
      endereco: ponto.endereco ?? null,
      itens: ponto.itens.map((item) => ({
        codigo: item.codigo,
        descricao: item.descricao,
        quantidade: item.quantidade,
        unidade: item.unidade,
        preco_unitario: item.preco_unitario,
        desconto: item.desconto,
        total: item.total,
        modalidade: item.modalidade,
        referencia: item.referencia ?? null,
      })),
    })),
  };

  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

type PedidoResyncRpcClient = {
  rpc(
    name: 'resync_pedido_ingest',
    args: {
      p_pedido_id: string;
      p_empresa: string;
      p_header: Record<string, unknown>;
      p_cliente: Record<string, unknown>;
      p_pontos: PedidoFormInput['pontos_retirada'];
    },
  ): Promise<{ data: unknown; error: { message?: string } | null }>;
};

type PedidoCreateResolution = {
  created: boolean;
  duplicate?: boolean;
  id?: string;
  numero?: number;
  storage_pdf_path?: string | null;
  pdf_recovery_allowed?: boolean;
};

type PedidoCreateRpcClient = {
  rpc(
    name: 'create_pedido_ingest',
    args: {
      p_empresa: string;
      p_header: Record<string, unknown>;
      p_cliente: Record<string, unknown>;
      p_pontos: PedidoFormInput['pontos_retirada'];
    },
  ): Promise<{ data: unknown; error: { message?: string } | null }>;
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
  const ingestSnapshotHash = calcularHashSnapshotIngest(d, opts.vendedorId);
  const temIdentidadeCliente = Boolean(
    d.cliente_cnpj_cpf?.trim() || d.cliente_codigo?.trim(),
  );

  // 1) dedup por documento_erp (não-cancelado, escopo empresa)
  let existing: ExistingPedido | null = null;
  if (d.documento_erp) {
    let q = supabase
      .from('pedidos')
      .select('id, numero_mapa, status, cliente_id, ingest_pdf_snapshot_hash, ingest_snapshot_hash, storage_pdf_path')
      .eq('documento_erp', d.documento_erp)
      .neq('status', 'cancelado');
    if (opts.empresaId) q = q.eq('empresa_id', opts.empresaId);
    const { data } = await q.maybeSingle();
    existing = (data as ExistingPedido | null) ?? null;
  }

  // Evita a chamada remota quando o estado observado ja esta protegido. A RPC
  // repete esta guarda sob lock para fechar a janela de concorrencia.
  if (existing) {
    const podeAtualizar = opts.upsertOnDuplicate === true && existing.status === 'rascunho';
    const snapshotConcluido = existing.ingest_snapshot_hash === ingestSnapshotHash
      && (existing.cliente_id !== null || !temIdentidadeCliente);
    if (!podeAtualizar || snapshotConcluido) {
      return {
        duplicate: true,
        existing_id: existing.id,
        existing_numero: existing.numero_mapa,
        ...(existing.storage_pdf_path !== undefined
          ? { existingPdfPath: existing.storage_pdf_path }
          : {}),
        ...(podeAtualizar
          && existing.ingest_snapshot_hash === ingestSnapshotHash
          && existing.ingest_pdf_snapshot_hash !== ingestSnapshotHash
          ? { pdfRecoveryHash: ingestSnapshotHash }
          : {}),
      };
    }
  }

  const clienteInput = {
    cnpj_cpf: d.cliente_cnpj_cpf,
    codigo_erp: d.cliente_codigo,
    nome: d.cliente_nome,
    endereco: d.cliente_endereco,
    bairro: d.cliente_bairro,
    cidade: d.cliente_cidade,
    uf: d.cliente_uf,
    cep: d.cliente_cep,
    telefone: d.cliente_telefone,
  };

  // 2) campos de cabeçalho (compartilhados insert/update). SEM status (preservado no update)
  //    e SEM empresa_id (não muda no re-sync).
  const snapshotFields = {
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
    ingest_snapshot_hash: ingestSnapshotHash,
    vendedor_id: opts.vendedorId,
  };

  // 3) Pedido existente: a RPC bloqueia e revalida o pedido, resolve o cliente,
  // arquiva os filhos antigos e insere os novos na mesma transacao.
  if (existing) {
    if (!opts.empresaId) return { error: 'Empresa ausente no re-sync do pedido' };
    const header: Record<string, unknown> = {
      ...snapshotFields,
      cliente_id: existing.cliente_id,
      storage_pdf_path: d.storage_pdf_path ?? existing.storage_pdf_path,
    };
    if (d.exige_emissao !== undefined) header.exige_emissao = d.exige_emissao;

    const { data, error } = await (supabase as unknown as PedidoResyncRpcClient).rpc(
      'resync_pedido_ingest',
      {
        p_pedido_id: existing.id,
        p_empresa: opts.empresaId,
        p_header: header,
        p_cliente: clienteInput,
        p_pontos: d.pontos_retirada,
      },
    );
    if (error) return { error: `Falha no re-sync do pedido: ${error.message ?? 'desconhecida'}` };
    if (!data || typeof data !== 'object' || typeof (data as { updated?: unknown }).updated !== 'boolean') {
      return { error: 'Falha no re-sync do pedido: resposta invalida' };
    }

    const resolution = data as PedidoResyncResolution;
    if (!resolution.updated) {
      return {
        duplicate: true,
        existing_id: resolution.id ?? existing.id,
        existing_numero: resolution.numero ?? existing.numero_mapa,
        ...(existing.storage_pdf_path !== undefined
          ? { existingPdfPath: existing.storage_pdf_path }
          : {}),
        ...(resolution.reason !== 'protected'
          && resolution.reason !== 'not_found'
          && existing.ingest_snapshot_hash === ingestSnapshotHash
          && existing.ingest_pdf_snapshot_hash !== ingestSnapshotHash
          ? { pdfRecoveryHash: ingestSnapshotHash }
          : {}),
      };
    }
    const result: Extract<InserirPedidoResult, { id: string }> = {
      id: resolution.id ?? existing.id,
      numero: resolution.numero ?? existing.numero_mapa,
      updated: true,
    };
    if (typeof resolution.snapshot_changed === 'boolean') {
      result.snapshotChanged = resolution.snapshot_changed;
    }
    if (existing.storage_pdf_path !== undefined) {
      result.previousPdfPath = existing.storage_pdf_path;
    }
    result.pdfRecoveryHash = ingestSnapshotHash;
    return result;
  }

  // 4) O ingest de um pedido novo e inteiramente transacional no banco. Isso
  // impede que um segundo backfill observe cabecalho sem filhos ou concorra com
  // a insercao de pontos/itens ainda em andamento.
  if (opts.empresaId && opts.upsertOnDuplicate === true) {
    const header: Record<string, unknown> = { ...snapshotFields };
    if (d.exige_emissao !== undefined) header.exige_emissao = d.exige_emissao;

    const { data, error } = await (supabase as unknown as PedidoCreateRpcClient).rpc(
      'create_pedido_ingest',
      {
        p_empresa: opts.empresaId,
        p_header: header,
        p_cliente: clienteInput,
        p_pontos: d.pontos_retirada,
      },
    );
    if (error) return { error: `Falha ao criar pedido no ingest: ${error.message ?? 'desconhecida'}` };
    if (!data || typeof data !== 'object' || typeof (data as { created?: unknown }).created !== 'boolean') {
      return { error: 'Falha ao criar pedido no ingest: resposta invalida' };
    }

    const resolution = data as PedidoCreateResolution;
    if (typeof resolution.id !== 'string' || typeof resolution.numero !== 'number') {
      return { error: 'Falha ao criar pedido no ingest: pedido ausente na resposta' };
    }
    if (!resolution.created) {
      return {
        duplicate: true,
        existing_id: resolution.id,
        existing_numero: resolution.numero,
        ...(resolution.storage_pdf_path === null || typeof resolution.storage_pdf_path === 'string'
          ? { existingPdfPath: resolution.storage_pdf_path }
          : {}),
        ...(resolution.pdf_recovery_allowed === true
          ? { pdfRecoveryHash: ingestSnapshotHash }
          : {}),
      };
    }

    return {
      id: resolution.id,
      numero: resolution.numero,
      previousPdfPath: null,
      pdfRecoveryHash: ingestSnapshotHash,
    };
  }

  // 5) Pedido novo da interface: resolve o cliente antes do insert. Falhas de identidade nao
  // impedem a entrada do pedido, que permanece com cliente_id nulo.
  let cliente_id: string | null = null;
  try {
    const { id } = await upsertCliente(supabase, clienteInput, opts.empresaId);
    cliente_id = id;
  } catch {
    cliente_id = null;
  }

  const insertRow: Database['public']['Tables']['pedidos']['Insert'] = {
    ...snapshotFields,
    cliente_id,
    // Pedidos manuais nao participam do protocolo de replay do agente.
    ingest_snapshot_hash: null,
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
