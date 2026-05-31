namespace ExpedAgent;

public sealed class AgentConfig
{
    public string ApiBaseUrl { get; set; } = "";
    public string DeviceToken { get; set; } = "";
    public string SqlConnectionString { get; set; } = "";
    public int PollIntervalSeconds { get; set; } = 30;
    public string SituacoesGatilho { get; set; } = "2,5,7";
    // CSV -> short[] (ignora vazios/espaços). NÃO inclui 6 (cancelado) no default.
    public short[] SituacoesArray =>
        (SituacoesGatilho ?? "")
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(short.Parse)
            .ToArray();
    // Ordem de Serviço (opcional — liga só pra cliente que usa OS no Hiper)
    public bool SyncOs { get; set; } = false;
    public string SituacoesOsGatilho { get; set; } = ""; // vazio = sem filtro de situação
    public short[] SituacoesOsArray =>
        (SituacoesOsGatilho ?? "")
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(short.Parse)
            .ToArray();

    public int PdfGraceMinutes { get; set; } = 3;
    public string TempDir { get; set; } = "";
    public string ResolvedTempDir => string.IsNullOrWhiteSpace(TempDir) ? Path.GetTempPath() : TempDir;
}
