using Microsoft.Data.SqlClient;
namespace ExpediAgent;

// ⚠️ Nomes de coluna do cliente (numero_endereco, fone_primario_*, etc.) vieram do
// mapeamento; confirmar 1x no SQL Server real e ajustar se divergir (o log mostra o erro).
public sealed class HiperRepository(string connectionString)
{
    private readonly string _cs = connectionString;

    public async Task<List<PedidoHeader>> NovosPedidosAsync(int hwm, short[] situacoes, CancellationToken ct)
    {
        if (situacoes is null || situacoes.Length == 0) return new();
        // placeholders dinâmicos @s0,@s1,... — só NOMES de parâmetro entram na string;
        // os VALORES vão por SqlParameter (sem interpolar dados → sem risco de injeção).
        var nomes = situacoes.Select((_, i) => "@s" + i).ToArray();
        string sql = $@"
SELECT pv.id_pedido_venda, pv.codigo, pv.data_hora_geracao, pv.id_entidade_cliente,
       pv.id_usuario_vendedor, pv.data_previsao_entrega_final, pv.data_previsao_entrega_inicial, pv.observacao
FROM pedido_venda pv WITH (NOLOCK)
WHERE pv.excluido = 0 AND pv.situacao IN ({string.Join(",", nomes)}) AND pv.id_pedido_venda > @hwm
ORDER BY pv.id_pedido_venda;";
        var list = new List<PedidoHeader>();
        await using var cn = new SqlConnection(_cs);
        await cn.OpenAsync(ct);
        await using var cmd = new SqlCommand(sql, cn);
        for (int i = 0; i < situacoes.Length; i++)
            cmd.Parameters.AddWithValue(nomes[i], situacoes[i]);
        cmd.Parameters.AddWithValue("@hwm", hwm);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        while (await r.ReadAsync(ct))
        {
            list.Add(new PedidoHeader
            {
                IdPedidoVenda = r.GetInt32(0),
                Codigo = r.GetString(1),
                DataHoraGeracao = r.GetDateTime(2),
                IdEntidadeCliente = r.GetInt32(3),
                IdUsuarioVendedor = r.IsDBNull(4) ? 0 : Convert.ToInt32(r.GetValue(4)), // id_usuario_vendedor é smallint no Hiper
                DataEntrega = !r.IsDBNull(5) ? r.GetDateTime(5) : (r.IsDBNull(6) ? null : r.GetDateTime(6)),
                Observacao = r.IsDBNull(7) ? null : r.GetString(7),
            });
        }
        return list;
    }

    public async Task<ClienteRow?> ClienteAsync(int idEntidade, CancellationToken ct)
    {
        const string sql = @"
SELECT e.nome,
       COALESCE(pf.cpf, pj.cnpj) AS cpf_cnpj,
       e.logradouro, e.numero_endereco, e.complemento, e.bairro, e.cep,
       c.nome AS cidade, c.uf, e.fone_primario_ddd, e.fone_primario_numero
FROM entidade e WITH (NOLOCK)
LEFT JOIN pessoa_fisica pf WITH (NOLOCK) ON pf.id_entidade = e.id_entidade
LEFT JOIN pessoa_juridica pj WITH (NOLOCK) ON pj.id_entidade = e.id_entidade
LEFT JOIN cidade c WITH (NOLOCK) ON c.id_cidade = e.id_cidade
WHERE e.id_entidade = @id;";
        await using var cn = new SqlConnection(_cs);
        await cn.OpenAsync(ct);
        await using var cmd = new SqlCommand(sql, cn);
        cmd.Parameters.AddWithValue("@id", idEntidade);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        if (!await r.ReadAsync(ct)) return null;
        string? S(int i) => r.IsDBNull(i) ? null : Convert.ToString(r.GetValue(i));
        return new ClienteRow
        {
            Nome = r.GetString(0), CpfCnpj = S(1), Logradouro = S(2), Numero = S(3),
            Complemento = S(4), Bairro = S(5), Cep = S(6), Cidade = S(7), Uf = S(8),
            FoneDdd = S(9), FoneNumero = S(10),
        };
    }

    public async Task<List<ItemRow>> ItensAsync(int idPedido, CancellationToken ct)
    {
        const string sql = @"
SELECT p.codigo, p.nome, g.quantidade, ipv.valor_unitario, ipv.valor_unitario_com_desconto
FROM item_pedido_venda ipv WITH (NOLOCK)
JOIN grade_pedido_venda g WITH (NOLOCK)
  ON g.id_pedido_venda = ipv.id_pedido_venda AND g.sequencia_item = ipv.sequencia_item
JOIN produto p WITH (NOLOCK) ON p.id_produto = ipv.id_produto
WHERE ipv.id_pedido_venda = @id AND ipv.excluido = 0 AND ipv.cancelado = 0
ORDER BY ipv.sequencia_item;";
        var list = new List<ItemRow>();
        await using var cn = new SqlConnection(_cs);
        await cn.OpenAsync(ct);
        await using var cmd = new SqlCommand(sql, cn);
        cmd.Parameters.AddWithValue("@id", idPedido);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        while (await r.ReadAsync(ct))
        {
            list.Add(new ItemRow
            {
                Codigo = Convert.ToString(r.GetValue(0)) ?? "",
                Descricao = r.GetString(1),
                Quantidade = r.GetDecimal(2),
                ValorUnitario = r.GetDecimal(3),
                ValorUnitarioComDesconto = r.GetDecimal(4),
            });
        }
        return list;
    }

    /// <summary>
    /// Self-check de schema: confere no INFORMATION_SCHEMA se as colunas que as queries
    /// usam existem no Hiper. Devolve a lista das que FALTAM (vazia = schema ok). Roda no
    /// startup pra avisar claramente numa versão divergente do Hiper, em vez de quebrar no meio.
    /// </summary>
    public async Task<List<string>> VerificarSchemaAsync(CancellationToken ct)
    {
        var esperado = new (string T, string C)[]
        {
            ("pedido_venda","id_pedido_venda"), ("pedido_venda","codigo"), ("pedido_venda","situacao"),
            ("pedido_venda","data_hora_geracao"), ("pedido_venda","id_entidade_cliente"),
            ("pedido_venda","id_usuario_vendedor"), ("pedido_venda","data_previsao_entrega_final"),
            ("pedido_venda","data_previsao_entrega_inicial"), ("pedido_venda","observacao"), ("pedido_venda","excluido"),
            ("entidade","nome"), ("entidade","logradouro"), ("entidade","numero_endereco"), ("entidade","complemento"),
            ("entidade","bairro"), ("entidade","cep"), ("entidade","fone_primario_ddd"),
            ("entidade","fone_primario_numero"), ("entidade","id_cidade"),
            ("pessoa_fisica","cpf"), ("pessoa_juridica","cnpj"),
            ("cidade","nome"), ("cidade","uf"), ("cidade","id_cidade"),
            ("item_pedido_venda","sequencia_item"), ("item_pedido_venda","id_produto"),
            ("item_pedido_venda","valor_unitario"), ("item_pedido_venda","valor_unitario_com_desconto"),
            ("item_pedido_venda","excluido"), ("item_pedido_venda","cancelado"),
            ("grade_pedido_venda","quantidade"), ("grade_pedido_venda","sequencia_item"),
            ("grade_pedido_venda","id_pedido_venda"),
            ("produto","codigo"), ("produto","nome"), ("produto","id_produto"),
        };
        var tabelas = esperado.Select(e => e.T).Distinct().ToArray();
        var nomes = tabelas.Select((_, i) => "@t" + i).ToArray();
        var sql = $"select TABLE_NAME, COLUMN_NAME from INFORMATION_SCHEMA.COLUMNS where TABLE_NAME in ({string.Join(",", nomes)})";
        var existentes = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        await using var cn = new SqlConnection(_cs);
        await cn.OpenAsync(ct);
        await using var cmd = new SqlCommand(sql, cn);
        for (int i = 0; i < tabelas.Length; i++) cmd.Parameters.AddWithValue(nomes[i], tabelas[i]);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        while (await r.ReadAsync(ct))
            existentes.Add($"{r.GetString(0)}.{r.GetString(1)}");
        return esperado
            .Where(e => !existentes.Contains($"{e.T}.{e.C}"))
            .Select(e => $"{e.T}.{e.C}")
            .ToList();
    }
}
