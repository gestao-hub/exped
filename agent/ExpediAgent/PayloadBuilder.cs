namespace ExpediAgent;

public static class PayloadBuilder
{
    public static IngestPayload Build(PedidoHeader h, ClienteRow? c, List<ItemRow> itens, string empresaNome = "Loja")
    {
        var pontoItens = itens.Select(it => new IngestItem
        {
            Codigo = it.Codigo,
            Descricao = it.Descricao,
            Quantidade = it.Quantidade,
            Unidade = "UN",
            PrecoUnitario = it.ValorUnitario,
            Desconto = Math.Max(0m, (it.ValorUnitario - it.ValorUnitarioComDesconto) * it.Quantidade),
            Total = it.Quantidade * it.ValorUnitarioComDesconto,
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
            ValorFrete = h.ValorFrete,
            NfNumero = h.NfNumero,
            NfChave = h.NfChave,
            NfEmitidaEm = h.NfEmitidaEm?.ToString("yyyy-MM-dd HH:mm:ss"),
            NfValor = h.NfValor,
            FormaPagamento = h.FormaPagamento,
            Parcelas = h.Parcelas,
            HiperUsuarioId = h.IdUsuarioVendedor,
            ClienteNome = string.IsNullOrWhiteSpace(c?.Nome) ? "Cliente" : c!.Nome,
            ClienteCnpjCpf = string.IsNullOrWhiteSpace(c?.CpfCnpj) ? null : c!.CpfCnpj,
            ClienteEndereco = string.IsNullOrWhiteSpace(endereco) ? null : endereco,
            ClienteBairro = c?.Bairro,
            ClienteCidade = c?.Cidade,
            ClienteUf = c?.Uf,
            ClienteCep = c?.Cep,
            ClienteTelefone = string.IsNullOrWhiteSpace(fone) ? null : fone,
            ValorTotal = pontoItens.Sum(i => i.Total),
            Observacoes = h.Observacao,
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
