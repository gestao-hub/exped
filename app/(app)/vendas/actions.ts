'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { pedidoFormSchema, type PedidoFormInput } from '@/lib/validators/pedido';
import { inserirPedido } from '@/lib/pedidos/inserir';
import { reconcileChildren, type ExistingPonto } from '@/lib/pedidos/reconcile';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/types/database';

/**
 * Persiste pontos/itens de um pedido IN-PLACE usando reconcileChildren:
 * UPDATE (mantém id) p/ os que continuam, INSERT p/ novos, soft-delete p/ os que
 * saíram (set deleted_at = now()). Retorna mensagem de erro ou null em sucesso.
 */
async function persistirFilhosPedido(
  supabase: SupabaseClient<Database>,
  pedidoId: string,
  pontosForm: PedidoFormInput['pontos_retirada'],
): Promise<string | null> {
  // Estado atual (apenas vivo: deleted_at is null) pra reconciliar.
  const { data: pontosAtuais, error: eAtual } = await supabase
    .from('pedido_pontos_retirada')
    .select('id, itens:pedido_itens(id)')
    .eq('pedido_id', pedidoId)
    .is('deleted_at', null)
    .is('itens.deleted_at', null); // ignora itens já soft-deletados na reconciliação
  if (eAtual) return eAtual.message;

  const existing: ExistingPonto[] = (pontosAtuais ?? []).map((p) => ({
    id: p.id as string,
    itens: ((p.itens ?? []) as { id: string }[]).map((it) => ({ id: it.id as string })),
  }));

  const { pontos } = reconcileChildren(existing, pontosForm);
  const now = new Date().toISOString();

  for (const op of pontos) {
    if (op.kind === 'softDelete') {
      // soft-delete itens primeiro, depois o ponto
      if (op.itens.length) {
        const ids = op.itens.map((i) => ('id' in i ? i.id : '')).filter(Boolean);
        if (ids.length) {
          const { error } = await supabase
            .from('pedido_itens')
            .update({ deleted_at: now })
            .in('id', ids);
          if (error) return `Falha ao remover itens: ${error.message}`;
        }
      }
      const { error } = await supabase
        .from('pedido_pontos_retirada')
        .update({ deleted_at: now })
        .eq('id', op.id);
      if (error) return `Falha ao remover ponto: ${error.message}`;
      continue;
    }

    // determina o ponto_retirada_id alvo (update mantém; insert cria e captura)
    let pontoId: string;
    if (op.kind === 'update') {
      const { error } = await supabase
        .from('pedido_pontos_retirada')
        .update({
          tipo: op.data.tipo,
          empresa_nome: op.data.empresa_nome,
          endereco: op.data.endereco ?? null,
          ordem: op.ordem,
        })
        .eq('id', op.id);
      if (error) return `Falha ao atualizar ponto: ${error.message}`;
      pontoId = op.id;
    } else {
      const { data: novo, error } = await supabase
        .from('pedido_pontos_retirada')
        .insert({
          pedido_id: pedidoId,
          tipo: op.data.tipo,
          empresa_nome: op.data.empresa_nome,
          endereco: op.data.endereco ?? null,
          ordem: op.ordem,
        })
        .select('id')
        .single();
      if (error || !novo) return `Falha ao criar ponto: ${error?.message}`;
      pontoId = novo.id as string;
    }

    // reconcilia itens deste ponto
    for (const it of op.itens) {
      if (it.kind === 'softDelete') {
        const { error } = await supabase
          .from('pedido_itens')
          .update({ deleted_at: now })
          .eq('id', it.id);
        if (error) return `Falha ao remover item: ${error.message}`;
      } else if (it.kind === 'update') {
        const { error } = await supabase
          .from('pedido_itens')
          .update({
            // Reancora o item ao ponto atual. Hoje a reconciliação só casa um item
            // (por PK) dentro do MESMO ponto, então isto é um no-op defensivo; mantém
            // update e insert simétricos e blinda contra mudanças futuras no matching.
            ponto_retirada_id: pontoId,
            codigo: it.data.codigo,
            descricao: it.data.descricao,
            quantidade: it.data.quantidade,
            unidade: it.data.unidade,
            preco_unitario: it.data.preco_unitario,
            desconto: it.data.desconto,
            total: it.data.total,
            modalidade: it.data.modalidade,
            referencia: it.data.referencia ?? null,
            saldo_estoque: it.data.saldo_estoque ?? null,
            ordem: it.ordem,
          })
          .eq('id', it.id);
        if (error) return `Falha ao atualizar item: ${error.message}`;
      } else {
        const { error } = await supabase.from('pedido_itens').insert({
          ponto_retirada_id: pontoId,
          codigo: it.data.codigo,
          descricao: it.data.descricao,
          quantidade: it.data.quantidade,
          unidade: it.data.unidade,
          preco_unitario: it.data.preco_unitario,
          desconto: it.data.desconto,
          total: it.data.total,
          modalidade: it.data.modalidade,
          referencia: it.data.referencia ?? null,
          saldo_estoque: it.data.saldo_estoque ?? null,
          ordem: it.ordem,
        });
        if (error) return `Falha ao criar item: ${error.message}`;
      }
    }
  }

  return null;
}

export type SavePedidoResult =
  | { error: string }
  | { id: string; numero: number }
  | { duplicate: true; existing_id: string; existing_numero: number };

/**
 * Cria um novo pedido (cabeçalho + pontos + itens) com status `rascunho` ou
 * `em_financeiro` (envia pro financeiro, que depois libera p/ logística).
 * `vendedor_id` é setado para auth.uid() (RLS exige).
 * Se já existe um pedido ativo com o mesmo documento_erp, retorna { duplicate }.
 */
export async function criarPedidoAction(
  raw: PedidoFormInput,
  status: 'rascunho' | 'em_financeiro',
): Promise<SavePedidoResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: 'Não autenticado' };

  const parsed = pedidoFormSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos' };
  }
  const d = parsed.data;

  // Sessão de usuário: vendedor = auth.uid(); empresa_id é preenchido pelo
  // DEFAULT current_empresa_id() no banco (não buscamos a empresa aqui).
  const r = await inserirPedido(supabase, d, { vendedorId: user.id, status });
  if (!('error' in r)) {
    revalidatePath('/vendas');
    revalidatePath('/financeiro');
  }
  return r;
}

/**
 * Atualiza um pedido existente (cabeçalho + substitui pontos/itens) e define o
 * status. Usado na tela de revisão do rascunho sincronizado do Hiper: o vendedor
 * completa observação + endereço de entrega e envia pra logística.
 */
export async function atualizarPedidoAction(
  id: string,
  raw: PedidoFormInput,
  status: 'rascunho' | 'em_financeiro',
): Promise<SavePedidoResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: 'Não autenticado' };

  const parsed = pedidoFormSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos' };
  }
  const d = parsed.data;

  // Precondição: só rascunho pode ser editado aqui (RLS já escopa dono/empresa).
  // Evita que esta ação apague/recrie pontos/itens de um pedido já enviado.
  const { data: atual } = await supabase
    .from('pedidos')
    .select('status')
    .eq('id', id)
    .single();
  if (!atual) return { error: 'Pedido não encontrado' };
  if (atual.status !== 'rascunho') return { error: 'Apenas rascunhos podem ser editados' };

  const { data: pedido, error: upErr } = await supabase
    .from('pedidos')
    .update({
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
      exige_emissao: d.exige_emissao ?? false,
      valor_total: d.valor_total,
      valor_frete: d.valor_frete ?? 0,
      observacoes: d.observacoes ?? null,
      status,
    })
    .eq('id', id)
    .eq('status', 'rascunho') // transição atômica: não corre com mudança de status
    .select('id, numero_mapa')
    .single();
  if (upErr || !pedido) return { error: upErr?.message ?? 'Pedido não encontrado ou não é mais rascunho' };

  // Reconcilia pontos/itens IN-PLACE (PK estável p/ sincronizador multi-site):
  // itens que continuam → UPDATE (mantém id); novos → INSERT; removidos → soft-delete.
  // NÃO faz delete+reinsert (geraria uuids novos a cada save e quebraria o merge).
  const recErr = await persistirFilhosPedido(supabase, id, d.pontos_retirada);
  if (recErr) return { error: recErr };

  revalidatePath('/vendas');
  revalidatePath(`/vendas/${id}`);
  revalidatePath('/financeiro');
  return { id: pedido.id as string, numero: pedido.numero_mapa as number };
}

/**
 * Cancela um pedido (status → cancelado). Vendedor pode cancelar enquanto
 * estiver rascunho/pendente; admin sempre.
 */
export async function cancelarPedidoAction(id: string) {
  const supabase = await createClient();
  const { error } = await supabase
    .from('pedidos')
    .update({ status: 'cancelado' })
    .eq('id', id);
  if (error) return { error: error.message };
  revalidatePath('/vendas');
  revalidatePath(`/vendas/${id}`);
  return { ok: true as const };
}

/**
 * Vendedor "corrige" um pedido que já está no caixa: devolve de em_financeiro → rascunho
 * pra reabrir a edição (sai da fila do caixa). Depois ele revisa e reenvia. Transição
 * atômica .eq('status','em_financeiro'); a RLS garante que só o dono (ou admin) faça isso
 * e evita corrida com o financeiro liberando ao mesmo tempo.
 */
export async function corrigirPedidoAction(id: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('pedidos')
    .update({ status: 'rascunho' })
    .eq('id', id)
    .eq('status', 'em_financeiro')
    .select('id')
    .single();
  if (error || !data) {
    return {
      error:
        error?.message ?? 'Pedido não está mais no caixa (talvez já liberado para a logística).',
    };
  }
  revalidatePath('/vendas');
  revalidatePath(`/vendas/${id}`);
  return { ok: true as const };
}

/**
 * Logística: marca como em separação.
 */
export async function iniciarSeparacaoAction(id: string) {
  const supabase = await createClient();
  const { error } = await supabase
    .from('pedidos')
    .update({ status: 'em_separacao' })
    .eq('id', id);
  if (error) return { error: error.message };
  revalidatePath('/logistica');
  revalidatePath(`/logistica/${id}`);
  return { ok: true as const };
}

/**
 * Logística: marca que o pedido saiu para entrega (caminhão na rua).
 * Só faz sentido em pedido de envio (tem ponto tipo='entrega'); o pedido só será
 * finalizado quando o caminhão voltar ao galpão. Carimba `saiu_entrega_em`.
 * Transição atômica a partir de em_separacao/parcialmente_entregue.
 */
export async function marcarSaiuEntregaAction(id: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('pedidos')
    .update({ status: 'em_transporte', saiu_entrega_em: new Date().toISOString() })
    .eq('id', id)
    .in('status', ['em_separacao', 'parcialmente_entregue'])
    .select('id')
    .single();
  if (error || !data) {
    return { error: error?.message ?? 'Pedido não está em separação' };
  }
  revalidatePath('/logistica');
  revalidatePath(`/logistica/${id}`);
  return { ok: true as const };
}

/**
 * Logística: marca como finalizado.
 */
export async function finalizarPedidoAction(id: string) {
  const supabase = await createClient();
  const { error } = await supabase
    .from('pedidos')
    .update({ status: 'finalizado' })
    .eq('id', id);
  if (error) return { error: error.message };
  revalidatePath('/logistica');
  revalidatePath(`/logistica/${id}`);
  revalidatePath('/historico');
  return { ok: true as const };
}

/**
 * Logística: registra entrega (parcial ou total) — recebe ids dos itens
 * com a quantidade entregue NESTA viagem. Soma na coluna acumulada.
 * Decide novo status:
 *   - Tudo entregue (q_entregue == q em todos os itens) → finalizado
 *   - Algum > 0 mas < total → parcialmente_entregue
 *   - Nada entregue ainda → mantém status atual (em_separacao ou outro)
 */
export async function registrarEntregaAction(input: {
  pedido_id: string;
  itens: { id: string; entregue_agora: number }[];
}) {
  if (!input.pedido_id) return { error: 'pedido_id obrigatório' };
  if (!Array.isArray(input.itens) || input.itens.length === 0) {
    return { error: 'Informe ao menos 1 item' };
  }

  const supabase = await createClient();

  // Role check (defesa em profundidade — RLS é a barreira primária)
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Não autenticado' };
  const { data: prof } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();
  if (!prof || (prof.role !== 'admin' && prof.role !== 'logistica')) {
    return { error: 'Apenas logística/admin pode registrar entrega' };
  }

  // Busca quantidades atuais (precisa pra somar e checar limite)
  const ids = input.itens.map((i) => i.id);
  const { data: atuais, error: e0 } = await supabase
    .from('pedido_itens')
    .select('id, quantidade, quantidade_entregue, ponto_retirada_id')
    .in('id', ids);
  if (e0) return { error: e0.message };

  // Verifica que TODOS itens pertencem ao mesmo pedido. ponto_retirada_id é NOT NULL no
  // banco (todo item — inclusive 'imediato' — vive num ponto-container; ver migration
  // 20260614000001), e os tipos gerados já refletem isso (string, não nullable).
  const pontoIds = Array.from(new Set((atuais ?? []).map((a) => a.ponto_retirada_id)));
  const { data: pontosDoPedido } = await supabase
    .from('pedido_pontos_retirada')
    .select('id, pedido_id')
    .in('id', pontoIds);
  const pedidoIdsEnvolvidos = new Set((pontosDoPedido ?? []).map((p) => p.pedido_id));
  if (pedidoIdsEnvolvidos.size !== 1 || !pedidoIdsEnvolvidos.has(input.pedido_id)) {
    return { error: 'Itens não pertencem ao pedido informado' };
  }

  // Update um por um (não dá pra fazer batch com valores diferentes via PostgREST)
  for (const item of input.itens) {
    const atual = atuais?.find((a) => a.id === item.id);
    if (!atual) continue;
    const novaEntregue = Math.max(
      0,
      Math.min(Number(atual.quantidade), Number(atual.quantidade_entregue) + Number(item.entregue_agora)),
    );
    const { error } = await supabase
      .from('pedido_itens')
      .update({ quantidade_entregue: novaEntregue })
      .eq('id', item.id);
    if (error) return { error: `Item ${item.id}: ${error.message}` };
  }

  // Recalcula status baseado em TODOS os itens do pedido (não só os updated)
  const { data: pontosTodos } = await supabase
    .from('pedido_pontos_retirada')
    .select('id')
    .eq('pedido_id', input.pedido_id)
    .is('deleted_at', null);
  const pontoIdsTodos = (pontosTodos ?? []).map((p) => p.id);
  const { data: itensTodos } = await supabase
    .from('pedido_itens')
    .select('quantidade, quantidade_entregue')
    .in('ponto_retirada_id', pontoIdsTodos)
    .is('deleted_at', null);

  let novoStatus: 'em_separacao' | 'parcialmente_entregue' | 'finalizado' = 'em_separacao';
  if (itensTodos && itensTodos.length > 0) {
    const total = itensTodos.reduce((s, i) => s + Number(i.quantidade), 0);
    const entregue = itensTodos.reduce((s, i) => s + Number(i.quantidade_entregue), 0);
    if (total > 0 && entregue >= total) novoStatus = 'finalizado';
    else if (entregue > 0) novoStatus = 'parcialmente_entregue';
  }

  const { error: eStatus } = await supabase
    .from('pedidos')
    .update({ status: novoStatus })
    .eq('id', input.pedido_id);
  if (eStatus) return { error: eStatus.message };

  revalidatePath(`/logistica/${input.pedido_id}`);
  revalidatePath(`/vendas/${input.pedido_id}`);
  revalidatePath('/logistica');
  revalidatePath('/vendas');
  if (novoStatus === 'finalizado') revalidatePath('/historico');
  return { ok: true as const, status: novoStatus };
}

/**
 * Logística — lote: marca vários como em_separacao (só os que estão pendentes).
 * Retorna { updated } com a quantidade efetivamente atualizada.
 */
export async function iniciarSeparacaoLoteAction(ids: string[]) {
  if (!Array.isArray(ids) || ids.length === 0) return { error: 'Nenhum pedido selecionado' };
  if (ids.length > 100) return { error: 'Máximo 100 pedidos por lote' };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('pedidos')
    .update({ status: 'em_separacao' })
    .in('id', ids)
    .eq('status', 'pendente')
    .select('id');
  if (error) return { error: error.message };

  revalidatePath('/logistica');
  return { ok: true as const, updated: (data ?? []).length };
}

/**
 * Logística — lote: marca vários como finalizado (só os que estão em_separacao).
 */
export async function finalizarLoteAction(ids: string[]) {
  if (!Array.isArray(ids) || ids.length === 0) return { error: 'Nenhum pedido selecionado' };
  if (ids.length > 100) return { error: 'Máximo 100 pedidos por lote' };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('pedidos')
    .update({ status: 'finalizado' })
    .in('id', ids)
    .in('status', ['em_separacao', 'em_transporte', 'parcialmente_entregue'])
    .select('id');
  if (error) return { error: error.message };

  revalidatePath('/logistica');
  revalidatePath('/historico');
  return { ok: true as const, updated: (data ?? []).length };
}

export async function redirectToVendas() {
  redirect('/vendas');
}

/**
 * Botão "Puxar": pede ao AGENTE LOCAL (no hub) pra sincronizar AGORA os pedidos recentes do
 * vendedor logado, sem esperar o ciclo automático. Resolve o(s) hiper_usuario_id do vendedor
 * pelo mapa (service-role, pois o vendedor pode não ter RLS de leitura nele) e chama o agente
 * em AGENT_SYNC_URL (só existe no hub). NÃO puxa pedido de outro vendedor.
 */
export async function puxarDoHiperAction(): Promise<{ ok: boolean; synced?: number; message: string }> {
  const agentUrl = process.env.AGENT_SYNC_URL;
  if (!agentUrl) return { ok: false, message: 'Indisponível neste ambiente.' };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: 'Não autenticado.' };

  const admin = createAdminClient();
  const { data: maps } = await admin
    .from('hiper_vendedor_map')
    .select('hiper_usuario_id')
    .eq('vendedor_id', user.id);
  const ids = (maps ?? [])
    .map((m) => m.hiper_usuario_id as number)
    .filter((n) => Number.isFinite(n));
  if (ids.length === 0) {
    return { ok: false, message: 'Seu usuário não está vinculado a um vendedor do Hiper.' };
  }

  try {
    const res = await fetch(`${agentUrl}/sync-now?ids=${ids.join(',')}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(20000),
    });
    const json = (await res.json().catch(() => ({}))) as {
      success?: unknown;
      synced?: unknown;
      error?: unknown;
    };
    if (!res.ok || json.success !== true) {
      const agentError =
        typeof json.error === 'string' && json.error.trim() ? json.error.trim() : null;
      return {
        ok: false,
        message:
          agentError ??
          (res.ok
            ? 'O agente local retornou uma resposta inválida.'
            : `O agente local falhou ao sincronizar (HTTP ${res.status}).`),
      };
    }

    revalidatePath('/vendas');
    const synced = typeof json.synced === 'number' ? json.synced : 0;
    return {
      ok: true,
      synced,
      message: synced > 0 ? `${synced} pedido(s) puxado(s) do Hiper.` : 'Nenhum pedido novo do Hiper agora.',
    };
  } catch {
    return { ok: false, message: 'Não consegui falar com o agente local. Ele está rodando?' };
  }
}
