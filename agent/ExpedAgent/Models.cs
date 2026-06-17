using System.Text.Json.Serialization;
namespace ExpedAgent;

public sealed class PedidoHeader
{
    public int IdPedidoVenda { get; set; }
    public string Codigo { get; set; } = "";
    public DateTime DataHoraGeracao { get; set; }
    public int IdEntidadeCliente { get; set; }
    public int IdUsuarioVendedor { get; set; }
    public DateTime? DataEntrega { get; set; }        // fim da janela (data_previsao_entrega_final)
    public DateTime? DataEntregaInicio { get; set; }  // início da janela (data_previsao_entrega_inicial)
    public decimal ValorFrete { get; set; }
    public string? Observacao { get; set; }
    // Último item adicionado (MAX item_pedido_venda.data_hora_cadastro) — gatilho da
    // estabilização ("só cai completo"): só sincroniza quando o pedido parou de mudar.
    public DateTime? UltItemCadastro { get; set; }
    // NF-e (preenchida quando o pedido já foi faturado no Hiper)
    public string? NfNumero { get; set; }
    public string? NfChave { get; set; }
    public DateTime? NfEmitidaEm { get; set; }
    public decimal? NfValor { get; set; }
    // Pagamento estruturado (só em pedido finalizado, via negociacao)
    public string? FormaPagamento { get; set; }
    public string? Parcelas { get; set; }
}

public sealed class ClienteRow
{
    public string Nome { get; set; } = "";
    public string? CpfCnpj { get; set; }
    public string? Logradouro { get; set; }
    public string? Numero { get; set; }
    public string? Complemento { get; set; }
    public string? Bairro { get; set; }
    public string? Cep { get; set; }
    public string? Cidade { get; set; }
    public string? Uf { get; set; }
    public string? FoneDdd { get; set; }
    public string? FoneNumero { get; set; }
}

public sealed class ItemRow
{
    public int IdProduto { get; set; }
    public string Codigo { get; set; } = "";
    public string Descricao { get; set; } = "";
    public decimal Quantidade { get; set; }
    public decimal ValorUnitario { get; set; }
    public decimal ValorUnitarioComDesconto { get; set; }
    public decimal? SaldoEstoque { get; set; }
}

// ---- payload pro endpoint (snake_case, igual ingestPedidoSchema) ----
public sealed class IngestItem
{
    [JsonPropertyName("codigo")] public string Codigo { get; set; } = "";
    [JsonPropertyName("descricao")] public string Descricao { get; set; } = "";
    [JsonPropertyName("quantidade")] public decimal Quantidade { get; set; }
    [JsonPropertyName("unidade")] public string Unidade { get; set; } = "UN";
    [JsonPropertyName("preco_unitario")] public decimal PrecoUnitario { get; set; }
    [JsonPropertyName("desconto")] public decimal Desconto { get; set; }
    [JsonPropertyName("total")] public decimal Total { get; set; }
    [JsonPropertyName("referencia")] public string? Referencia { get; set; }
    [JsonPropertyName("saldo_estoque")] public decimal? SaldoEstoque { get; set; }
}
public sealed class IngestPonto
{
    [JsonPropertyName("tipo")] public string Tipo { get; set; } = "loja";
    [JsonPropertyName("empresa_nome")] public string EmpresaNome { get; set; } = "";
    [JsonPropertyName("endereco")] public string? Endereco { get; set; }
    [JsonPropertyName("itens")] public List<IngestItem> Itens { get; set; } = new();
}
// ---- Ordem de Serviço (leitura do Hiper) ----
public sealed class OsHeader
{
    public int IdOrdemServico { get; set; }
    public int IdEntidadeCliente { get; set; }
    public int IdUsuarioResponsavel { get; set; }
    public short? Situacao { get; set; }
    public short? Prioridade { get; set; }
    public DateTime? DataAbertura { get; set; }
    public DateTime? DataPrevisao { get; set; }
    public DateTime? DataConclusao { get; set; }
    public string? Categoria { get; set; }
    public string? Observacao { get; set; }
    public string? DefeitoRelatado { get; set; }
    public string? Diagnostico { get; set; }
    public DateTime? GarantiaInicio { get; set; }
    public DateTime? GarantiaFim { get; set; }
}
public sealed class OsServicoRow
{
    public string Descricao { get; set; } = "";
    public decimal Quantidade { get; set; }
    public decimal ValorUnitario { get; set; }
    public decimal ValorTotal { get; set; }
    public string? TecnicoNome { get; set; }
}

// payload OS pro endpoint /api/ingest/os (snake_case)
public sealed class IngestOsServico
{
    [JsonPropertyName("descricao")] public string Descricao { get; set; } = "";
    [JsonPropertyName("quantidade")] public decimal Quantidade { get; set; }
    [JsonPropertyName("valor_unitario")] public decimal ValorUnitario { get; set; }
    [JsonPropertyName("total")] public decimal Total { get; set; }
    [JsonPropertyName("tecnico_nome")] public string? TecnicoNome { get; set; }
}
public sealed class IngestOsPayload
{
    [JsonPropertyName("documento_erp")] public string? DocumentoErp { get; set; }
    [JsonPropertyName("os_erp_id")] public int OsErpId { get; set; }
    [JsonPropertyName("hiper_usuario_id")] public int HiperUsuarioId { get; set; }
    [JsonPropertyName("cliente_nome")] public string ClienteNome { get; set; } = "";
    [JsonPropertyName("cliente_cnpj_cpf")] public string? ClienteCnpjCpf { get; set; }
    [JsonPropertyName("cliente_telefone")] public string? ClienteTelefone { get; set; }
    [JsonPropertyName("categoria")] public string? Categoria { get; set; }
    [JsonPropertyName("situacao_erp")] public int? SituacaoErp { get; set; }
    [JsonPropertyName("prioridade")] public int? Prioridade { get; set; }
    [JsonPropertyName("data_abertura")] public string? DataAbertura { get; set; }
    [JsonPropertyName("data_previsao")] public string? DataPrevisao { get; set; }
    [JsonPropertyName("data_conclusao")] public string? DataConclusao { get; set; }
    [JsonPropertyName("defeito_relatado")] public string? DefeitoRelatado { get; set; }
    [JsonPropertyName("diagnostico")] public string? Diagnostico { get; set; }
    [JsonPropertyName("garantia_inicio")] public string? GarantiaInicio { get; set; }
    [JsonPropertyName("garantia_fim")] public string? GarantiaFim { get; set; }
    [JsonPropertyName("observacao")] public string? Observacao { get; set; }
    [JsonPropertyName("itens")] public List<IngestItem> Itens { get; set; } = new();
    [JsonPropertyName("servicos")] public List<IngestOsServico> Servicos { get; set; } = new();
}

public sealed class IngestPayload
{
    [JsonPropertyName("documento_erp")] public string? DocumentoErp { get; set; }
    [JsonPropertyName("data_emissao")] public string? DataEmissao { get; set; }
    [JsonPropertyName("data_entrega")] public string? DataEntrega { get; set; }
    [JsonPropertyName("data_entrega_inicio")] public string? DataEntregaInicio { get; set; }
    [JsonPropertyName("valor_frete")] public decimal ValorFrete { get; set; }
    [JsonPropertyName("nf_numero")] public string? NfNumero { get; set; }
    [JsonPropertyName("nf_chave")] public string? NfChave { get; set; }
    [JsonPropertyName("nf_emitida_em")] public string? NfEmitidaEm { get; set; }
    [JsonPropertyName("nf_valor")] public decimal? NfValor { get; set; }
    [JsonPropertyName("hiper_usuario_id")] public int HiperUsuarioId { get; set; }
    [JsonPropertyName("cliente_codigo")] public string? ClienteCodigo { get; set; }
    [JsonPropertyName("cliente_nome")] public string ClienteNome { get; set; } = "";
    [JsonPropertyName("cliente_cnpj_cpf")] public string? ClienteCnpjCpf { get; set; }
    [JsonPropertyName("cliente_endereco")] public string? ClienteEndereco { get; set; }
    [JsonPropertyName("cliente_bairro")] public string? ClienteBairro { get; set; }
    [JsonPropertyName("cliente_cidade")] public string? ClienteCidade { get; set; }
    [JsonPropertyName("cliente_uf")] public string? ClienteUf { get; set; }
    [JsonPropertyName("cliente_cep")] public string? ClienteCep { get; set; }
    [JsonPropertyName("cliente_telefone")] public string? ClienteTelefone { get; set; }
    [JsonPropertyName("valor_total")] public decimal ValorTotal { get; set; }
    [JsonPropertyName("forma_pagamento")] public string? FormaPagamento { get; set; }
    [JsonPropertyName("parcelas")] public string? Parcelas { get; set; }
    [JsonPropertyName("observacoes")] public string? Observacoes { get; set; }
    [JsonPropertyName("pontos_retirada")] public List<IngestPonto> PontosRetirada { get; set; } = new();
}

public sealed class IngestNfPayload
{
    [JsonPropertyName("documento_erp")] public string DocumentoErp { get; set; } = "";
    [JsonPropertyName("nf_numero")] public string? NfNumero { get; set; }
    [JsonPropertyName("nf_chave")] public string? NfChave { get; set; }
    [JsonPropertyName("nf_emitida_em")] public string? NfEmitidaEm { get; set; }
    [JsonPropertyName("nf_valor")] public decimal? NfValor { get; set; }
    [JsonPropertyName("forma_pagamento")] public string? FormaPagamento { get; set; }
    [JsonPropertyName("parcelas")] public string? Parcelas { get; set; }
}
