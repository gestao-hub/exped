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
    // Roda TODA passada (era 150). O scan-pra-frente por id PULA orçamento finalizado fora de ordem
    // de id (id já passou pelo HWM quando virou sit 2/5/7) — quem os pega é o backfill (re-scan da
    // janela). Rodando todo tick, esses pedidos caem em ~1 poll em vez de horas. Barato: o
    // _backfillSeen pula o que já foi conferido ANTES de buscar cliente/itens (só trabalha no que falta).
    public int BackfillEveryTicks { get; set; } = 1;
    // ROBUSTEZ: após N falhas no MESMO pedido, pula ele (dado quebrado) em vez de travar a fila.
    public int MaxFalhasPorPedido { get; set; } = 3;

    // Re-sync de NF: roda a cada N ticks (não todo ciclo) e checa em LOTE (1 query). Mantém o
    // ciclo de pedido novo leve mesmo com a lista de NF pendente grande (venda à vista não emite
    // NF-e → a lista acumula até o TTL). NfEveryTicks=0 desliga o throttle (roda todo ciclo).
    public int NfEveryTicks { get; set; } = 12;
    public int NfTtlDias { get; set; } = 7;

    // "Só cai completo": só sincroniza o pedido depois que ele PAROU de mudar — sem item novo há
    // EstabilizacaoSegundos. Evita capturar pela metade (itens add ao longo de minutos) e o pedido
    // avançar pro financeiro incompleto. Cap: após MaxEsperaEstabilizacaoMin desde a criação,
    // sincroniza mesmo assim (não trava num pedido sempre-mudando).
    public int EstabilizacaoSegundos { get; set; } = 90;
    public int MaxEsperaEstabilizacaoMin { get; set; } = 15;
}
