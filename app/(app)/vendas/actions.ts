'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { pedidoFormSchema, type PedidoFormInput } from '@/lib/validators/pedido';
import { upsertCliente } from '@/lib/clientes/upsert';

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

  // Dedup explícito (UX > confiar só no unique index) — só quando o ERP forneceu doc.
  if (d.documento_erp) {
    const { data: existing } = await supabase
      .from('pedidos')
      .select('id, numero_mapa')
      .eq('documento_erp', d.documento_erp)
      .neq('status', 'cancelado')
      .maybeSingle();
    if (existing) {
      return {
        duplicate: true,
        existing_id: existing.id as string,
        existing_numero: existing.numero_mapa as number,
      };
    }
  }

  // Upsert do cliente (cadastro central) — opcional, tolera falha
  let cliente_id: string | null = null;
  try {
    const { id } = await upsertCliente(supabase, {
      cnpj_cpf:   d.cliente_cnpj_cpf,
      codigo_erp: d.cliente_codigo,
      nome:       d.cliente_nome,
      endereco:   d.cliente_endereco,
      bairro:     d.cliente_bairro,
      cidade:     d.cliente_cidade,
      uf:         d.cliente_uf,
      cep:        d.cliente_cep,
      telefone:   d.cliente_telefone,
    });
    cliente_id = id;
  } catch {
    // não-bloqueante: pedido salva com cliente_id=null se upsert falhar
    cliente_id = null;
  }

  const { data: pedido, error: insErr } = await supabase
    .from('pedidos')
    .insert({
      documento_erp:    d.documento_erp ?? null,
      data_emissao:     d.data_emissao ?? null,
      data_entrega:     d.data_entrega ?? null,
      cliente_codigo:   d.cliente_codigo ?? null,
      cliente_nome:     d.cliente_nome,
      cliente_cnpj_cpf: d.cliente_cnpj_cpf ?? null,
      cliente_endereco: d.cliente_endereco ?? null,
      cliente_bairro:   d.cliente_bairro ?? null,
      cliente_cidade:   d.cliente_cidade ?? null,
      cliente_uf:       d.cliente_uf ?? null,
      cliente_cep:      d.cliente_cep ?? null,
      cliente_telefone: d.cliente_telefone ?? null,
      cliente_id,
      forma_pagamento:  d.forma_pagamento ?? null,
      parcelas:         d.parcelas ?? null,
      valor_total:      d.valor_total,
      observacoes:      d.observacoes ?? null,
      status,
      storage_pdf_path: d.storage_pdf_path ?? null,
      vendedor_id:      user.id,
    })
    .select('id, numero_mapa')
    .single();

  if (insErr || !pedido) {
    return { error: insErr?.message ?? 'Falha ao criar pedido' };
  }

  // Insere pontos e itens (sequencial pra preservar ordem)
  for (let i = 0; i < d.pontos_retirada.length; i++) {
    const ponto = d.pontos_retirada[i];
    const { data: pontoRow, error: pontoErr } = await supabase
      .from('pedido_pontos_retirada')
      .insert({
        pedido_id:    pedido.id,
        tipo:         ponto.tipo,
        empresa_nome: ponto.empresa_nome,
        endereco:     ponto.endereco ?? null,
        ordem:        i,
      })
      .select('id')
      .single();

    if (pontoErr || !pontoRow) {
      return { error: `Falha no ponto ${i + 1}: ${pontoErr?.message}` };
    }

    if (ponto.itens.length > 0) {
      const itensPayload = ponto.itens.map((it, idx) => ({
        ponto_retirada_id: pontoRow.id,
        codigo:            it.codigo,
        descricao:         it.descricao,
        quantidade:        it.quantidade,
        unidade:           it.unidade,
        preco_unitario:    it.preco_unitario,
        desconto:          it.desconto,
        total:             it.total,
        referencia:        it.referencia ?? null,
        ordem:             idx,
      }));
      const { error: itErr } = await supabase.from('pedido_itens').insert(itensPayload);
      if (itErr) return { error: `Falha nos itens do ponto ${i + 1}: ${itErr.message}` };
    }
  }

  revalidatePath('/vendas');
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

export async function redirectToVendas() {
  redirect('/vendas');
}
