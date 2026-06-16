namespace ExpedAgent;

public static class PayloadBuilder
{
    // Blindagem contra rejeição do ingest: nunca enviar valor negativo nem string acima do limite.
    static decimal NN(decimal v) => v < 0m ? 0m : v;
    static decimal? NN(decimal? v) => v.HasValue ? NN(v.Value) : (decimal?)null;
    static string? Cut(string? s, int max) => string.IsNullOrEmpty(s) ? s : (s.Length > max ? s.Substring(0, max) : s);

    public static IngestPayload Build(PedidoHeader h, ClienteRow? c, List<ItemRow> itens, string empresaNome = "Loja")
    {
        var pontoItens = itens.Select(it => new IngestItem
        {
            Codigo = Cut(it.Codigo, 80) ?? "",
            Descricao = Cut(string.IsNullOrWhiteSpace(it.Descricao) ? "Item" : it.Descricao, 250)!,
            Quantidade = NN(it.Quantidade),
            Unidade = "UN",
            PrecoUnitario = NN(it.ValorUnitario),
            Desconto = Math.Max(0m, (it.ValorUnitario - it.ValorUnitarioComDesconto) * it.Quantidade),
            Total = NN(it.Quantidade * it.ValorUnitarioComDesconto),
            SaldoEstoque = it.SaldoEstoque,
        }).ToList();

        var endereco = string.Join(" ", new[] { c?.Logradouro, c?.Numero, c?.Complemento }
            .Where(s => !string.IsNullOrWhiteSpace(s))).Trim();
        var fone = string.Join("", new[] { c?.FoneDdd, c?.FoneNumero }.Where(s => !string.IsNullOrWhiteSpace(s)));

        return new IngestPayload
        {
            DocumentoErp = h.Codigo,
            DataEmissao = h.DataHoraGeracao.ToString("yyyy-MM-dd"),
            DataEntrega = h.DataEntrega?.ToString("yyyy-MM-dd"),
            DataEntregaInicio = h.DataEntregaInicio?.ToString("yyyy-MM-dd"),
            ValorFrete = NN(h.ValorFrete),
            NfNumero = h.NfNumero,
            NfChave = h.NfChave,
            NfEmitidaEm = h.NfEmitidaEm?.ToString("yyyy-MM-dd HH:mm:ss"),
            NfValor = NN(h.NfValor),
            FormaPagamento = h.FormaPagamento,
            Parcelas = h.Parcelas,
            HiperUsuarioId = h.IdUsuarioVendedor,
            ClienteNome = Cut(string.IsNullOrWhiteSpace(c?.Nome) ? "Cliente" : c!.Nome, 250)!,
            ClienteCnpjCpf = Cut(string.IsNullOrWhiteSpace(c?.CpfCnpj) ? null : c!.CpfCnpj, 80),
            ClienteEndereco = Cut(string.IsNullOrWhiteSpace(endereco) ? null : endereco, 1000),
            ClienteBairro = Cut(c?.Bairro, 250),
            ClienteCidade = Cut(c?.Cidade, 250),
            ClienteUf = Cut(c?.Uf, 2),
            ClienteCep = Cut(c?.Cep, 80),
            ClienteTelefone = Cut(string.IsNullOrWhiteSpace(fone) ? null : fone, 80),
            ValorTotal = NN(pontoItens.Sum(i => i.Total)),
            Observacoes = Cut(h.Observacao, 5000),
            PontosRetirada = new List<IngestPonto>
            {
                new() { Tipo = "loja", EmpresaNome = empresaNome, Itens = pontoItens }
            },
        };
    }

    public static IngestOsPayload BuildOs(OsHeader h, ClienteRow? c, List<IngestItem> itens, List<OsServicoRow> servicos)
    {
        var fone = string.Join("", new[] { c?.FoneDdd, c?.FoneNumero }.Where(s => !string.IsNullOrWhiteSpace(s)));
        return new IngestOsPayload
        {
            DocumentoErp = h.IdOrdemServico.ToString(),
            OsErpId = h.IdOrdemServico,
            HiperUsuarioId = h.IdUsuarioResponsavel,
            ClienteNome = string.IsNullOrWhiteSpace(c?.Nome) ? "Cliente" : c!.Nome,
            ClienteCnpjCpf = string.IsNullOrWhiteSpace(c?.CpfCnpj) ? null : c!.CpfCnpj,
            ClienteTelefone = string.IsNullOrWhiteSpace(fone) ? null : fone,
            Categoria = h.Categoria,
            SituacaoErp = h.Situacao,
            Prioridade = h.Prioridade,
            DataAbertura = h.DataAbertura?.ToString("yyyy-MM-dd"),
            DataPrevisao = h.DataPrevisao?.ToString("yyyy-MM-dd"),
            DataConclusao = h.DataConclusao?.ToString("yyyy-MM-dd"),
            DefeitoRelatado = h.DefeitoRelatado,
            Diagnostico = h.Diagnostico,
            GarantiaInicio = h.GarantiaInicio?.ToString("yyyy-MM-dd"),
            GarantiaFim = h.GarantiaFim?.ToString("yyyy-MM-dd"),
            Observacao = h.Observacao,
            Itens = itens,
            Servicos = servicos.Select(s => new IngestOsServico
            {
                Descricao = s.Descricao, Quantidade = s.Quantidade,
                ValorUnitario = s.ValorUnitario, Total = s.ValorTotal, TecnicoNome = s.TecnicoNome,
            }).ToList(),
        };
    }
}
