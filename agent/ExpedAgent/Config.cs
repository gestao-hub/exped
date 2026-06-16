namespace ExpedAgent;

public sealed class AgentConfig
{
    public string ApiBaseUrl { get; set; } = "";
    public string DeviceToken { get; set; } = "";
    public string SqlConnectionString { get; set; } = "";
    public int PollIntervalSeconds { get; set; } = 30;
    public string SituacoesGatilho { get; set; } = "2,5,7";
    // CSV -> short[] (ignora vazios/espaços). NÃO inclui 6 (cancelado) no default.
    public short[] SituacoesArray => ParseSituacoes(SituacoesGatilho);
    // Ordem de Serviço (opcional — liga só pra cliente que usa OS no Hiper)
    public bool SyncOs { get; set; } = false;
    public string SituacoesOsGatilho { get; set; } = ""; // vazio = sem filtro de situação
    public short[] SituacoesOsArray => ParseSituacoes(SituacoesOsGatilho);

    // CSV -> short[] (ignora vazios/espaços). Helper compartilhado (defaults locais e config remota).
    public static short[] ParseSituacoes(string csv) =>
        (csv ?? "")
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(short.Parse)
            .ToArray();

    public int PdfGraceMinutes { get; set; } = 3;
    public string TempDir { get; set; } = "";
    public string ResolvedTempDir => string.IsNullOrWhiteSpace(TempDir) ? Path.GetTempPath() : TempDir;

    // Backfill: o cursor (HWM por id_pedido_venda) PULA pedido que so vira elegivel (sit 2/5/7)
    // DEPOIS do cursor passar (orcamento finalizado fora de ordem de id). Periodicamente re-varremos
    // a janela [hwm-BackfillWindow, hwm] e re-POSTamos; o dedup do ingest (por documento_erp) recria
    // so o que falta. BackfillEveryTicks=0 desliga.
    public int BackfillWindow { get; set; } = 1000;
    public int BackfillEveryTicks { get; set; } = 150; // ~5min a 2s de poll
    // ROBUSTEZ: após N falhas no MESMO pedido, pula ele (dado quebrado) em vez de travar a fila.
    public int MaxFalhasPorPedido { get; set; } = 3;
}
