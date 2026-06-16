using Microsoft.Extensions.Logging;
namespace ExpedAgent;

public sealed class Worker(AgentConfig cfg, HiperRepository repo, IngestClient client, StateStore state, RemoteConfigClient remote, ILogger<Worker> log)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        log.LogInformation("ExpedAgent {Ver} iniciado. Poll a cada {S}s, situações-gatilho {Sit}.", AgentInfo.Version, cfg.PollIntervalSeconds, cfg.SituacoesGatilho);
        await ChecarSchemaAsync(ct);
        int tick = 0;
        while (!ct.IsCancellationRequested)
        {
            var rc = await remote.GetAsync(ct);
            var situacoesVenda = AgentConfig.ParseSituacoes(rc.SituacoesVenda);

            try { await TickAsync(situacoesVenda, ct); }
            catch (Exception ex) { log.LogError(ex, "Erro no ciclo de sync"); }
            // Backfill periodico: repesca pedido finalizado fora de ordem de id que o cursor pulou.
            if (cfg.BackfillEveryTicks > 0 && tick % cfg.BackfillEveryTicks == 0)
            {
                try { await TickBackfillAsync(situacoesVenda, ct); }
                catch (Exception ex) { log.LogError(ex, "Erro no backfill"); }
            }
            try { await TickNfPendentesAsync(ct); }
            catch (Exception ex) { log.LogError(ex, "Erro no re-sync de NF"); }
            if (rc.SyncOs)
            {
                try { await TickOsAsync(AgentConfig.ParseSituacoes(rc.SituacoesOs), ct); }
                catch (Exception ex) { log.LogError(ex, "Erro no ciclo de OS"); }
            }
            await client.HeartbeatAsync(ct);
            if (tick % 120 == 0) await ChecarVersaoAsync(ct); // ~1x/h (120 ticks de 30s)
            tick++;
            try { await Task.Delay(TimeSpan.FromSeconds(rc.PollSegundos), ct); }
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

    private async Task TickOsAsync(short[] situacoesOs, CancellationToken ct)
    {
        int hwm = state.GetOsHwm();
        var novas = await repo.NovasOrdensServicoAsync(hwm, situacoesOs, ct);
        if (novas.Count == 0) return;
        int maxOk = hwm;
        foreach (var h in novas)
        {
            var cli = await repo.ClienteAsync(h.IdEntidadeCliente, ct);
            var itens = await repo.ItensOsAsync(h.IdOrdemServico, ct);
            var servicos = await repo.ServicosOsAsync(h.IdOrdemServico, ct);
            var payload = PayloadBuilder.BuildOs(h, cli, itens, servicos);
            var r = await client.EnviarOsAsync(payload, ct);
            if (r is IngestResult.Created or IngestResult.Duplicate)
            {
                log.LogInformation("OS {Id} sincronizada ({R}).", h.IdOrdemServico, r);
                maxOk = h.IdOrdemServico;
            }
            else
            {
                log.LogWarning("OS {Id} falhou ({R}); parando o lote.", h.IdOrdemServico, r);
                break;
            }
        }
        if (maxOk > hwm) state.SetOsHwm(maxOk);
    }

    private async Task TickAsync(short[] situacoesVenda, CancellationToken ct)
    {
        int hwm = state.GetHwm();
        var novos = await repo.NovosPedidosAsync(hwm, situacoesVenda, ct);
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

            // #3 NF-e (best-effort): não pode quebrar o sync do pedido.
            try
            {
                var nf = await repo.NfDoPedidoAsync(h.IdPedidoVenda, ct);
                if (nf is { } n)
                {
                    h.NfNumero = n.Numero; h.NfChave = n.Chave;
                    h.NfEmitidaEm = n.Emitida; h.NfValor = n.Valor;
                }
            }
            catch (Exception ex) { log.LogWarning("NF do pedido {Cod} indisponível: {Msg}", h.Codigo, ex.Message); }

            // #5 estoque (best-effort): saldo snapshot por item.
            try
            {
                var saldos = await repo.SaldosAsync(itens.Select(i => i.IdProduto).ToArray(), ct);
                foreach (var it in itens)
                    if (saldos.TryGetValue(it.IdProduto, out var s)) it.SaldoEstoque = s;
            }
            catch (Exception ex) { log.LogWarning("Saldos do pedido {Cod} indisponíveis: {Msg}", h.Codigo, ex.Message); }

            // #2 pagamento estruturado (best-effort): só finalizado tem negociacao.
            try
            {
                var pg = await repo.PagamentoDoPedidoAsync(h.IdPedidoVenda, ct);
                if (pg is { } p && !string.IsNullOrWhiteSpace(p.Forma))
                {
                    h.FormaPagamento = p.Forma; h.Parcelas = p.Parcelas;
                }
            }
            catch (Exception ex) { log.LogWarning("Pagamento do pedido {Cod} indisponível (usa PDF): {Msg}", h.Codigo, ex.Message); }

            var payload = PayloadBuilder.Build(h, cli, itens);
            var r = await client.EnviarAsync(payload, pdfExiste ? pdf : null, ct);

            if (r is IngestResult.Created or IngestResult.Duplicate)
            {
                log.LogInformation("Pedido {Cod} sincronizado ({R}{Pdf}).", h.Codigo, r, pdfExiste ? ", com PDF" : ", sem PDF");
                maxOk = h.IdPedidoVenda;
                // Ingerido sem NF → observa pra re-sincronizar quando faturar (2→5).
                if (string.IsNullOrWhiteSpace(h.NfNumero))
                    state.AddNfPendente(h.IdPedidoVenda, h.Codigo, DateTime.UtcNow);
            }
            else
            {
                log.LogWarning("Pedido {Cod} falhou ({R}); parando o lote (tenta no próximo poll).", h.Codigo, r);
                break; // não avança além de uma falha pra preservar ordem
            }
        }
        if (maxOk > hwm) state.SetHwm(maxOk);
    }

    /// <summary>
    /// Backfill: o cursor (HWM por id_pedido_venda) PULA pedido que só vira elegível (sit 2/5/7)
    /// DEPOIS do cursor passar (orçamento finalizado fora de ordem de id). Aqui re-varremos a janela
    /// [hwm-BackfillWindow, hwm] e re-POSTamos; o dedup do ingest (por documento_erp) recria só o que
    /// falta. NÃO mexe no HWM e NÃO para no primeiro erro (uma falha não trava o resto do backfill).
    /// </summary>
    private async Task TickBackfillAsync(short[] situacoesVenda, CancellationToken ct)
    {
        int hwm = state.GetHwm();
        int floor = Math.Max(0, hwm - cfg.BackfillWindow);
        var janela = await repo.PedidosNoIntervaloAsync(floor, hwm, situacoesVenda, ct);
        if (janela.Count == 0) return;

        int recriados = 0;
        foreach (var h in janela)
        {
            if (ct.IsCancellationRequested) break;
            try
            {
                var cli = await repo.ClienteAsync(h.IdEntidadeCliente, ct);
                var itens = await repo.ItensAsync(h.IdPedidoVenda, ct);
                if (itens.Count == 0) continue;
                var payload = PayloadBuilder.Build(h, cli, itens);
                string pdf = Path.Combine(cfg.ResolvedTempDir, $"PedidoVenda_{h.IdPedidoVenda}.pdf");
                var r = await client.EnviarAsync(payload, File.Exists(pdf) ? pdf : null, ct);
                if (r is IngestResult.Created)
                {
                    recriados++;
                    log.LogInformation("Backfill: pedido {Cod} repescado.", h.Codigo);
                    if (string.IsNullOrWhiteSpace(h.NfNumero))
                        state.AddNfPendente(h.IdPedidoVenda, h.Codigo, DateTime.UtcNow);
                }
                // Duplicate = já existe (ok); falha = ignora e segue (não trava o backfill).
            }
            catch (Exception ex) { log.LogWarning("Backfill: pedido {Cod} falhou: {Msg}", h.Codigo, ex.Message); }
        }
        if (recriados > 0) log.LogInformation("Backfill: {N} pedido(s) repescado(s) na janela ({F},{H}].", recriados, floor, hwm);
    }

    /// <summary>
    /// Re-sync de NF: pra cada pedido na lista "aguardando NF", checa se já faturou
    /// no Hiper; se sim, manda só a NF+pagamento pro Exped e tira da lista. TTL 7 dias.
    /// Best-effort — nunca quebra o sync principal.
    /// </summary>
    private async Task TickNfPendentesAsync(CancellationToken ct)
    {
        state.PruneNfPendentes(DateTime.UtcNow, 7);
        foreach (var p in state.GetNfPendentes())
        {
            if (ct.IsCancellationRequested) break;
            var nf = await repo.NfDoPedidoAsync(p.IdPedidoVenda, ct);
            if (nf is not { } n) continue; // ainda sem NF — tenta no próximo poll

            (string? Forma, string? Parcelas)? pg = null;
            try { pg = await repo.PagamentoDoPedidoAsync(p.IdPedidoVenda, ct); }
            catch (Exception ex) { log.LogWarning("Pagamento (re-sync) do pedido {Doc} indisponível: {Msg}", p.DocumentoErp, ex.Message); }

            var r = await client.EnviarNfAsync(p.DocumentoErp, n, pg, ct);
            if (r is NfSyncResult.Ok or NfSyncResult.NotFound)
            {
                state.RemoveNfPendente(p.IdPedidoVenda);
                log.LogInformation("NF re-sincronizada: pedido {Doc} ({R}).", p.DocumentoErp, r);
            }
        }
    }
}
