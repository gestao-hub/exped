import type { PedidoParsed } from './franzoni-erp';
import type { PedidoFormInput } from '@/lib/validators/pedido';

/** Converte a saída do parser para os defaults do PedidoForm. */
export function parsedToFormInput(
  p: PedidoParsed,
  storagePath: string | null,
): PedidoFormInput {
  return {
    documento_erp:    p.documento_erp ?? null,
    data_emissao:     p.data_emissao ?? null,
    data_entrega:     p.data_entrega ?? null,
    cliente_codigo:   p.cliente.codigo ?? null,
    cliente_nome:     p.cliente.nome ?? '',
    cliente_cnpj_cpf: p.cliente.cnpj_cpf ?? null,
    cliente_endereco: p.cliente.endereco ?? null,
    cliente_bairro:   p.cliente.bairro ?? null,
    cliente_cidade:   p.cliente.cidade ?? null,
    cliente_uf:       p.cliente.uf ?? null,
    cliente_cep:      p.cliente.cep ?? null,
    cliente_telefone: p.cliente.telefone ?? null,
    forma_pagamento:  p.forma_pagamento ?? null,
    parcelas:         p.parcelas ?? null,
    valor_total:      p.valor_total ?? 0,
    observacoes:      p.observacoes ?? null,
    storage_pdf_path: storagePath,
    pontos_retirada:  p.pontos_retirada.map((pt) => ({
      tipo:         pt.tipo,
      empresa_nome: pt.empresa_nome ?? '',
      endereco:     pt.endereco ?? null,
      itens:        pt.itens.map((it) => ({
        codigo:         it.codigo,
        descricao:      it.descricao,
        quantidade:     it.quantidade,
        unidade:        it.unidade,
        preco_unitario: it.preco_unitario,
        desconto:       it.desconto,
        total:          it.total,
        referencia:     it.referencia ?? null,
      })),
    })),
  };
}

/** Defaults vazios pra um pedido novo "do zero". */
export function emptyFormInput(empresaEmissora = ''): PedidoFormInput {
  return {
    documento_erp: null,
    data_emissao: null,
    data_entrega: null,
    cliente_codigo: null,
    cliente_nome: '',
    cliente_cnpj_cpf: null,
    cliente_endereco: null,
    cliente_bairro: null,
    cliente_cidade: null,
    cliente_uf: null,
    cliente_cep: null,
    cliente_telefone: null,
    forma_pagamento: null,
    parcelas: null,
    valor_total: 0,
    observacoes: null,
    storage_pdf_path: null,
    pontos_retirada: [
      { tipo: 'loja', empresa_nome: empresaEmissora, endereco: null, itens: [] },
    ],
  };
}
