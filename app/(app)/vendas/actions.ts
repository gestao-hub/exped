'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { pedidoFormSchema, type PedidoFormInput } from '@/lib/validators/pedido';
import { inserirPedido } from '@/lib/pedidos/inserir';

export type SavePedidoResult =
  | { error: string }
  | { id: string; numero: number }
  | { duplicate: true; existing_id: string; existing_numero: number };

/**
 * Cria um novo pedido (cabeçalho + pontos + itens) com status `rascunho` ou `pendente`.
 * `vendedor_id` é setado para auth.uid() (RLS exige).
 * Se já existe um pedido ativo com o mesmo documento_erp, retorna { duplicate }.
 */
export async function criarPedidoAction(
  raw: PedidoFormInput,
  status: 'rascunho' | 'pendente',
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
    revalidatePath('/logistica');
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
  status: 'rascunho' | 'pendente',
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
      valor_total: d.valor_total,
      observacoes: d.observacoes ?? null,
      status,
    })
    .eq('id', id)
    .eq('status', 'rascunho') // transição atômica: não corre com mudança de status
    .select('id, numero_mapa')
    .single();
  if (upErr || !pedido) return { error: upErr?.message ?? 'Pedido não encontrado ou não é mais rascunho' };

  // Substitui pontos/itens (rascunho ainda não tem entrega registrada).
  const { data: pontosAntigos } = await supabase
    .from('pedido_pontos_retirada')
    .select('id')
    .eq('pedido_id', id);
  const idsAntigos = (pontosAntigos ?? []).map((p) => p.id);
  if (idsAntigos.length) {
    await supabase.from('pedido_itens').delete().in('ponto_retirada_id', idsAntigos);
    await supabase.from('pedido_pontos_retirada').delete().eq('pedido_id', id);
  }
  for (let i = 0; i < d.pontos_retirada.length; i++) {
    const ponto = d.pontos_retirada[i];
    const { data: pontoRow, error: pErr } = await supabase
      .from('pedido_pontos_retirada')
      .insert({
        pedido_id: id,
        tipo: ponto.tipo,
        empresa_nome: ponto.empresa_nome,
        endereco: ponto.endereco ?? null,
        ordem: i,
      })
      .select('id')
      .single();
    if (pErr || !pontoRow) return { error: `Falha no ponto ${i + 1}: ${pErr?.message}` };
    if (ponto.itens.length) {
      const itens = ponto.itens.map((it, idx) => ({
        ponto_retirada_id: pontoRow.id,
        codigo: it.codigo,
        descricao: it.descricao,
        quantidade: it.quantidade,
        unidade: it.unidade,
        preco_unitario: it.preco_unitario,
        desconto: it.desconto,
        total: it.total,
        referencia: it.referencia ?? null,
        ordem: idx,
      }));
      const { error: iErr } = await supabase.from('pedido_itens').insert(itens);
      if (iErr) return { error: `Falha nos itens do ponto ${i + 1}: ${iErr.message}` };
    }
  }

  revalidatePath('/vendas');
  revalidatePath(`/vendas/${id}`);
  revalidatePath('/logistica');
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

  // Verifica que TODOS itens pertencem ao mesmo pedido
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
    .eq('pedido_id', input.pedido_id);
  const pontoIdsTodos = (pontosTodos ?? []).map((p) => p.id);
  const { data: itensTodos } = await supabase
    .from('pedido_itens')
    .select('quantidade, quantidade_entregue')
    .in('ponto_retirada_id', pontoIdsTodos);

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
    .in('status', ['em_separacao', 'parcialmente_entregue'])
    .select('id');
  if (error) return { error: error.message };

  revalidatePath('/logistica');
  revalidatePath('/historico');
  return { ok: true as const, updated: (data ?? []).length };
}

export async function redirectToVendas() {
  redirect('/vendas');
}
