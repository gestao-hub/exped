using Microsoft.Extensions.Logging;
namespace ExpedAgent;

public sealed class Worker(AgentConfig cfg, HiperRepository repo, IngestClient client, StateStore state, RemoteConfigClient remote, ILogger<Worker> log)
    : BackgroundService
{
    // Ids já conferidos pelo backfill NESTA execução — evita re-POSTar a janela inteira toda rodada
    // (o dedup do servidor já protegia os dados; isto corta o trabalho/uploads repetidos).
    private readonly HashSet<int> _backfillSeen = new();
    // Contador de falhas por pedido (id → nº de tentativas que falharam) p/ pular após MaxFalhasPorPedido.
    private readonly Dictionary<int, int> _falhas = new();
    // Re-check periódico da janela do backfill: limpa o "já visto" a cada ~5min pra re-enviar a
    // janela → o ingest faz UPSERT dos pedidos editados DEPOIS da 1ª captura (itens/cliente que
    // entraram ao longo dos minutos). Substitui a re-sincronização que dependia de reinício do
    // processo (que o autoflush do log agora elimina). (v1.4.3)
    private DateTime _lastBackfillReset = DateTime.UtcNow;

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
            // Re-check periódico (~5min): limpa o "já visto" → o backfill re-envia a janela →
            // ingest faz UPSERT dos pedidos editados depois da captura. Também serve de heartbeat
            // no log (com o autoflush, o arquivo atualiza e o watchdog não reinicia à toa).
            if (DateTime.UtcNow - _lastBackfillReset > TimeSpan.FromMinutes(5))
            {
                _backfillSeen.Clear();
                _lastBackfillReset = DateTime.UtcNow;
                log.LogInformation("Backfill: re-check periódico da janela (HWM {H}).", state.GetHwm());
            }
            // Backfill periodico: repesca pedido finalizado fora de ordem de id que o cursor pulou.
            if (cfg.BackfillEveryTicks > 0 && tick % cfg.BackfillEveryTicks == 0)
            {
                try { await TickBackfillAsync(situacoesVenda, ct); }
                catch (Exception ex) { log.LogError(ex, "Erro no backfill"); }
            }
            // Re-sync de NF: throttle (a cada NfEveryTicks). É best-effort e agora em LOTE (1 query),
            // então não precisa rodar todo ciclo — mantém o ciclo de pedido novo (TickAsync) leve.
            if (cfg.NfEveryTicks > 0 && tick % cfg.NfEveryTicks == 0)
            {
                try { await TickNfPendentesAsync(ct); }
                catch (Exception ex) { log.LogError(ex, "Erro no re-sync de NF"); }
            }
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
            // "Só cai completo": espera o pedido ESTABILIZAR (sem item novo há EstabilizacaoSegundos)
            // antes de sincronizar — não captura pela metade nem deixa avançar pro financeiro
            // incompleto. Cap em MaxEsperaEstabilizacaoMin desde a criação (não trava pra sempre).
            if (h.UltItemCadastro is { } ultItem
                && (DateTime.Now - ultItem).TotalSeconds < cfg.EstabilizacaoSegundos
                && (DateTime.Now - h.DataHoraGeracao).TotalMinutes < cfg.MaxEsperaEstabilizacaoMin)
            {
                log.LogInformation("Pedido {Cod}: aguardando estabilizar (item novo há <{S}s).", h.Codigo, cfg.EstabilizacaoSegundos);
                break; // preserva ordem; re-tenta no próximo poll
            }
            string pdf = Path.Combine(cfg.ResolvedTempDir, $"PedidoVenda_{h.IdPedidoVenda}.pdf");
            bool pdfExiste = File.Exists(pdf);
            bool dentroCarencia = (DateTime.Now - h.DataHoraGeracao).TotalMinutes < cfg.PdfGraceMinutes;

            // Espera o PDF (impressão) enquanto na carência; não avança o HWM.
            if (!pdfExiste && dentroCarencia)
            {
                log.LogInformation("Pedido {Cod}: aguardando PDF (carência).", h.Codigo);
                break; // preserva ordem; tenta de novo no próximo poll
            }

            try
            {
                var cli = await repo.ClienteAsync(h.IdEntidadeCliente, ct);
                var itens = await repo.ItensAsync(h.IdPedidoVenda, ct);
                if (itens.Count == 0)
                {
                    log.LogWarning("Pedido {Cod} sem itens — pulando.", h.Codigo);
                    maxOk = h.IdPedidoVenda; _falhas.Remove(h.IdPedidoVenda); continue;
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
                    maxOk = h.IdPedidoVenda; _falhas.Remove(h.IdPedidoVenda);
                    // Ingerido sem NF → observa pra re-sincronizar quando faturar (2→5).
                    if (string.IsNullOrWhiteSpace(h.NfNumero))
                        state.AddNfPendente(h.IdPedidoVenda, h.Codigo, DateTime.UtcNow);
                    continue;
                }
                // Falha de ingestão (não-Created/Duplicate) → trata como falha abaixo (retenta/pula).
                throw new InvalidOperationException($"ingest retornou {r}");
            }
            catch (Exception ex)
            {
                // ROBUSTEZ: NUNCA travar a fila pra sempre num pedido ruim. Retenta algumas vezes
                // (falha transitória, ex.: cache) e, se persistir, PULA o pedido (dado quebrado) e segue.
                int n = (_falhas.TryGetValue(h.IdPedidoVenda, out var c) ? c : 0) + 1;
                _falhas[h.IdPedidoVenda] = n;
                if (n >= cfg.MaxFalhasPorPedido)
                {
                    log.LogError(ex, "Pedido {Cod} falhou {N}x — PULANDO pra não travar a fila.", h.Codigo, n);
                    maxOk = h.IdPedidoVenda; _falhas.Remove(h.IdPedidoVenda); continue;
                }
                log.LogWarning("Pedido {Cod} falhou ({N}/{Max}): {Msg} — tenta no próximo poll.", h.Codigo, n, cfg.MaxFalhasPorPedido, ex.Message);
                break; // preserva ordem; retenta no próximo poll
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
            if (_backfillSeen.Contains(h.IdPedidoVenda)) continue; // já conferido neste run — não re-POSTa
            // "Só cai completo": não repesca pedido que ainda está mudando (não marca seen → re-checa depois)
            if (h.UltItemCadastro is { } ultB
                && (DateTime.Now - ultB).TotalSeconds < cfg.EstabilizacaoSegundos
                && (DateTime.Now - h.DataHoraGeracao).TotalMinutes < cfg.MaxEsperaEstabilizacaoMin)
                continue;
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
                // Created OU Duplicate => já está no hub: marca pra não reprocessar nos próximos ciclos.
                if (r is IngestResult.Created or IngestResult.Duplicate)
                    _backfillSeen.Add(h.IdPedidoVenda);
                // falha (outro resultado/exceção): não marca, tenta de novo no próximo ciclo.
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
        state.PruneNfPendentes(DateTime.UtcNow, cfg.NfTtlDias);
        var pendentes = state.GetNfPendentes();
        if (pendentes.Count == 0) return;

        // 1 query em LOTE p/ a NF de TODOS os pendentes (antes: 1 query/conexão por item, todo ciclo
        // → o ciclo inflava p/ minutos com a lista grande e atrasava o pedido novo).
        var nfs = await repo.NfDosPedidosAsync(pendentes.Select(p => p.IdPedidoVenda).ToList(), ct);
        if (nfs.Count == 0) return; // ninguém faturou ainda

        foreach (var p in pendentes)
        {
            if (ct.IsCancellationRequested) break;
            if (!nfs.TryGetValue(p.IdPedidoVenda, out var n)) continue; // ainda sem NF — próximo ciclo

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
