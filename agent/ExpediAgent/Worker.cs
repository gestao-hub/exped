using Microsoft.Extensions.Logging;
namespace ExpediAgent;

public sealed class Worker(AgentConfig cfg, HiperRepository repo, IngestClient client, StateStore state, ILogger<Worker> log)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        log.LogInformation("ExpediAgent {Ver} iniciado. Poll a cada {S}s, situações-gatilho {Sit}.", AgentInfo.Version, cfg.PollIntervalSeconds, cfg.SituacoesGatilho);
        await ChecarSchemaAsync(ct);
        int tick = 0;
        while (!ct.IsCancellationRequested)
        {
            try { await TickAsync(ct); }
            catch (Exception ex) { log.LogError(ex, "Erro no ciclo de sync"); }
            await client.HeartbeatAsync(ct);
            if (tick % 120 == 0) await ChecarVersaoAsync(ct); // ~1x/h (120 ticks de 30s)
            tick++;
            try { await Task.Delay(TimeSpan.FromSeconds(cfg.PollIntervalSeconds), ct); }
            catch (TaskCanceledException) { break; }
        }
    }

    private async Task ChecarVersaoAsync(CancellationToken ct)
    {
        var latest = await client.LatestVersionAsync(ct);
        if (!string.IsNullOrEmpty(latest) && latest != AgentInfo.Version)
            log.LogWarning("Agente desatualizado: rodando {Cur}, disponível {New}. Reinstale a versão nova.", AgentInfo.Version, latest);
    }

    private async Task ChecarSchemaAsync(CancellationToken ct)
    {
        try
        {
            var faltando = await repo.VerificarSchemaAsync(ct);
            if (faltando.Count == 0)
                log.LogInformation("Schema do Hiper: OK.");
            else
                log.LogWarning("Schema do Hiper DIVERGENTE — colunas não encontradas: {Cols}. Ajuste as queries em HiperRepository.cs para esta versão do Hiper.", string.Join(", ", faltando));
        }
        catch (Exception ex) { log.LogWarning("Não consegui verificar o schema do Hiper: {Msg}", ex.Message); }
    }

    private async Task TickAsync(CancellationToken ct)
    {
        int hwm = state.GetHwm();
        var novos = await repo.NovosPedidosAsync(hwm, cfg.SituacoesArray, ct);
        if (novos.Count == 0) return;

        int maxOk = hwm;
        foreach (var h in novos)
        {
            string pdf = Path.Combine(cfg.ResolvedTempDir, $"PedidoVenda_{h.IdPedidoVenda}.pdf");
            bool pdfExiste = File.Exists(pdf);
            bool dentroCarencia = (DateTime.Now - h.DataHoraGeracao).TotalMinutes < cfg.PdfGraceMinutes;

            // Espera o PDF (impressão) enquanto na carência; não avança o HWM.
            if (!pdfExiste && dentroCarencia)
            {
                log.LogInformation("Pedido {Cod}: aguardando PDF (carência).", h.Codigo);
                break; // preserva ordem; tenta de novo no próximo poll
            }

            var cli = await repo.ClienteAsync(h.IdEntidadeCliente, ct);
            var itens = await repo.ItensAsync(h.IdPedidoVenda, ct);
            if (itens.Count == 0)
            {
                log.LogWarning("Pedido {Cod} sem itens — pulando.", h.Codigo);
                maxOk = h.IdPedidoVenda; continue;
            }

            var payload = PayloadBuilder.Build(h, cli, itens);
            var r = await client.EnviarAsync(payload, pdfExiste ? pdf : null, ct);

            if (r is IngestResult.Created or IngestResult.Duplicate)
            {
                log.LogInformation("Pedido {Cod} sincronizado ({R}{Pdf}).", h.Codigo, r, pdfExiste ? ", com PDF" : ", sem PDF");
                maxOk = h.IdPedidoVenda;
            }
            else
            {
                log.LogWarning("Pedido {Cod} falhou ({R}); parando o lote (tenta no próximo poll).", h.Codigo, r);
                break; // não avança além de uma falha pra preservar ordem
            }
        }
        if (maxOk > hwm) state.SetHwm(maxOk);
    }
}
