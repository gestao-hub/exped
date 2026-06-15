import type { PedidoFormInput } from '@/lib/validators/pedido';
import type { Database } from '@/lib/types/database';

type FormaPagamentoDb = Database['public']['Enums']['forma_pagamento_tipo'];

type PedidoRow = {
  documento_erp: string | null; data_emissao: string | null; data_entrega: string | null;
  cliente_codigo: string | null; cliente_nome: string; cliente_cnpj_cpf: string | null;
  cliente_endereco: string | null; cliente_bairro: string | null; cliente_cidade: string | null;
  cliente_uf: string | null; cliente_cep: string | null; cliente_telefone: string | null;
  cliente_endereco_id: string | null; forma_pagamento: FormaPagamentoDb | null; parcelas: number | null;
  receber_na_entrega: boolean; exige_emissao: boolean;
  valor_total: number; valor_frete: number | null; observacoes: string | null; storage_pdf_path: string | null;
};
type ModalidadeDb = Database['public']['Enums']['modalidade_item'];
type PontoDestinoDb = Database['public']['Enums']['ponto_retirada_destino'];
type ItemRow = {
  id: string; codigo: string; descricao: string; quantidade: number; unidade: string;
  preco_unitario: number; desconto: number; total: number; modalidade: ModalidadeDb;
  referencia: string | null; saldo_estoque: number | null; ordem: number | null;
};
type PontoRow = {
  id: string; tipo: PontoDestinoDb; empresa_nome: string; endereco: string | null; ordem: number | null;
  itens: ItemRow[];
};

/** Converte linhas do banco (pedido + pontos + itens) em PedidoFormInput. */
export function pedidoRowsToFormInput(pedido: PedidoRow, pontos: PontoRow[]): PedidoFormInput {
  return {
    documento_erp: pedido.documento_erp,
    data_emissao: pedido.data_emissao,
    data_entrega: pedido.data_entrega,
    cliente_codigo: pedido.cliente_codigo,
    cliente_nome: pedido.cliente_nome,
    cliente_cnpj_cpf: pedido.cliente_cnpj_cpf,
    cliente_endereco: pedido.cliente_endereco,
    cliente_bairro: pedido.cliente_bairro,
    cliente_cidade: pedido.cliente_cidade,
    cliente_uf: pedido.cliente_uf,
    cliente_cep: pedido.cliente_cep,
    cliente_telefone: pedido.cliente_telefone,
    cliente_endereco_id: pedido.cliente_endereco_id,
    forma_pagamento: pedido.forma_pagamento,
    parcelas: pedido.parcelas,
    receber_na_entrega: pedido.receber_na_entrega,
    exige_emissao: pedido.exige_emissao,
    valor_total: pedido.valor_total,
    valor_frete: pedido.valor_frete,
    observacoes: pedido.observacoes,
    storage_pdf_path: pedido.storage_pdf_path,
    pontos_retirada: [...pontos]
      .sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0))
      .map((p) => ({
        id: p.id,
        tipo: p.tipo,
        empresa_nome: p.empresa_nome,
        endereco: p.endereco,
        itens: [...(p.itens ?? [])]
          .sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0))
          .map((it) => ({
            id: it.id,
            codigo: it.codigo, descricao: it.descricao, quantidade: it.quantidade,
            unidade: it.unidade, preco_unitario: it.preco_unitario, desconto: it.desconto,
            total: it.total, modalidade: it.modalidade,
            referencia: it.referencia, saldo_estoque: it.saldo_estoque,
          })),
      })),
  };
}
