using System.Net;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
namespace ExpedAgent;

/// <summary>
/// Gatilho local "Puxar": o app do hub chama http://127.0.0.1:{SyncNowPort}/sync-now?ids=ID1,ID2
/// e o agente sincroniza NA HORA só os pedidos recentes daqueles usuários do Hiper (o vendedor
/// que clicou). Bind SÓ em 127.0.0.1 — só o app no mesmo servidor alcança. Pula a estabilização
/// (o vendedor confirmou que terminou). Serializa com o ciclo automático via SyncGate.
/// </summary>
public sealed class PuxarService(
    AgentConfig cfg, IOptionsMonitor<AgentConfig> liveCfg,
    HiperRepository repo, IngestClient client, StateStore state,
    RemoteConfigClient remote, SyncGate gate, SyncNowTelemetry telemetry,
    ILogger<PuxarService> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        var portChanges = Channel.CreateUnbounded<int>(new UnboundedChannelOptions
        {
            SingleReader = true,
            SingleWriter = false,
        });
        using var subscription = liveCfg.OnChange(next =>
        {
            if (!IsValidPort(next.SyncNowPort))
            {
                log.LogWarning("SyncNowPort invalida ignorada: {Port}. Use um inteiro entre 0 e 65535.", next.SyncNowPort);
                return;
            }
            portChanges.Writer.TryWrite(next.SyncNowPort);
        });

        var port = liveCfg.CurrentValue.SyncNowPort;
        if (!IsValidPort(port))
        {
            log.LogWarning("SyncNowPort inicial invalida: {Port}. Gatilho 'Puxar' desativado.", port);
            port = 0;
        }

        try
        {
            var retryFailures = 0;
            while (!ct.IsCancellationRequested)
            {
                if (port == 0)
                {
                    log.LogInformation("Gatilho 'Puxar' desativado (SyncNowPort=0).");
                    port = await ReadLatestPortAsync(portChanges.Reader, ct);
                    retryFailures = 0;
                    continue;
                }

                using var cycleCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                var listenerTask = ListenAsync(port, cycleCts.Token, ct);
                var changeTask = ReadLatestPortAsync(portChanges.Reader, cycleCts.Token);
                var completed = await Task.WhenAny(listenerTask, changeTask);

                if (completed == changeTask || changeTask.IsCompletedSuccessfully)
                {
                    var nextPort = await changeTask;
                    cycleCts.Cancel();
                    await listenerTask;
                    if (nextPort != port)
                    {
                        log.LogInformation("SyncNowPort alterada de {OldPort} para {NewPort}; reabrindo listener.", port, nextPort);
                    }
                    port = nextPort;
                    retryFailures = 0;
                    continue;
                }

                var listenerExit = await listenerTask;
                cycleCts.Cancel();
                await IgnoreCancellationAsync(changeTask);
                if (listenerExit == ListenerExit.Stopped || ct.IsCancellationRequested) break;

                retryFailures = Math.Min(retryFailures + 1, 5);
                var retryDelay = RetryDelay(retryFailures);
                log.LogWarning(
                    "Gatilho 'Puxar' tentara reabrir a porta {Port} em {DelayMs} ms (falha {Failure}).",
                    port, retryDelay.TotalMilliseconds, retryFailures);

                using var retryCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                var retryTask = Task.Delay(retryDelay, retryCts.Token);
                var retryChangeTask = ReadLatestPortAsync(portChanges.Reader, retryCts.Token);
                var retryCompleted = await Task.WhenAny(retryTask, retryChangeTask);
                if (retryCompleted == retryChangeTask || retryChangeTask.IsCompletedSuccessfully)
                {
                    port = await retryChangeTask;
                    retryFailures = 0;
                    retryCts.Cancel();
                    await IgnoreCancellationAsync(retryTask);
                }
                else
                {
                    await retryTask;
                    retryCts.Cancel();
                    await IgnoreCancellationAsync(retryChangeTask);
                }
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // Encerramento normal do host.
        }
        finally { portChanges.Writer.TryComplete(); }
    }

    private static bool IsValidPort(int port) => port is >= 0 and <= 65535;

    internal static TimeSpan RetryDelay(int failureCount)
    {
        var exponent = Math.Clamp(failureCount - 1, 0, 4);
        return TimeSpan.FromMilliseconds(Math.Min(4000, 250 * (1 << exponent)));
    }

    private static async Task<int> ReadLatestPortAsync(ChannelReader<int> changes, CancellationToken ct)
    {
        var port = await changes.ReadAsync(ct);
        while (changes.TryRead(out var latest)) port = latest;
        return port;
    }

    private static async Task IgnoreCancellationAsync(Task task)
    {
        try { await task; }
        catch (OperationCanceledException) { }
    }

    private async Task<ListenerExit> ListenAsync(int port, CancellationToken listenerCt, CancellationToken hostCt)
    {
        using var listener = new HttpListener();
        try
        {
            listener.Prefixes.Add($"http://127.0.0.1:{port}/");
            listener.Start();
            log.LogInformation("Gatilho 'Puxar' ouvindo em http://127.0.0.1:{Port}/sync-now", port);
        }
        catch (Exception ex) when (!listenerCt.IsCancellationRequested)
        {
            log.LogWarning("Gatilho 'Puxar' nao abriu na porta {Port}: {Msg}", port, ex.Message);
            return ListenerExit.Retry;
        }
        catch (Exception) when (listenerCt.IsCancellationRequested)
        {
            return ListenerExit.Stopped;
        }

        using (listenerCt.Register(() => { try { listener.Stop(); } catch { /* encerrando */ } }))
        {
            while (!listenerCt.IsCancellationRequested)
            {
                HttpListenerContext httpCtx;
                try { httpCtx = await listener.GetContextAsync(); }
                catch (Exception) when (listenerCt.IsCancellationRequested)
                {
                    return ListenerExit.Stopped;
                }
                catch (Exception ex)
                {
                    log.LogWarning("Gatilho 'Puxar' perdeu o listener na porta {Port}: {Msg}", port, ex.Message);
                    return ListenerExit.Retry;
                }
                // Uma troca de porta fecha apenas o accept antigo. Requests que ja
                // entraram continuam sob o token do host e nao perdem o sync em curso.
                _ = HandleAsync(httpCtx, hostCt);
            }
        }
        return ListenerExit.Stopped;
    }

    private enum ListenerExit { Stopped, Retry }

    private async Task HandleAsync(HttpListenerContext httpCtx, CancellationToken ct)
    {
        int synced = 0;
        int statusCode;
        object body;
        var accepted = false;
        try
        {
            var idsRaw = httpCtx.Request.QueryString["ids"] ?? "";
            var ids = idsRaw.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                            .Select(s => int.TryParse(s, out var n) ? n : -1)
                            .Where(n => n > 0).Distinct().ToArray();
            if (ids.Length == 0)
            {
                statusCode = (int)HttpStatusCode.BadRequest;
                body = new { success = false, synced, error = "Nenhum usuario do Hiper foi informado." };
            }
            else
            {
                accepted = true;
                var rc = await remote.GetAsync(ct);
                synced = await SincronizarAsync(ids, AgentConfig.ParseSituacoes(rc.SituacoesVenda), ct);
                statusCode = (int)HttpStatusCode.OK;
                body = new { success = true, synced };
            }
        }
        catch (Exception ex)
        {
            statusCode = (int)HttpStatusCode.InternalServerError;
            body = new { success = false, synced, error = "Falha interna ao sincronizar pedidos." };
            log.LogWarning("Puxar falhou: {Msg}", ex.Message);
        }

        if (accepted) telemetry.Record(statusCode == (int)HttpStatusCode.OK, synced);

        try
        {
            var buf = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(body));
            httpCtx.Response.ContentType = "application/json";
            httpCtx.Response.StatusCode = statusCode;
            await httpCtx.Response.OutputStream.WriteAsync(buf, ct);
            httpCtx.Response.Close();
        }
        catch { /* cliente desistiu */ }
    }

    private async Task<int> SincronizarAsync(int[] hiperIds, short[] situacoes, CancellationToken ct)
    {
        await gate.Lock.WaitAsync(ct);
        try
        {
            var pedidos = await repo.PedidosRecentesPorUsuarioAsync(hiperIds, situacoes, ct);
            int ok = 0;
            foreach (var h in pedidos)
            {
                if (ct.IsCancellationRequested) break;
                try
                {
                    var cli = await repo.ClienteAsync(h.IdEntidadeCliente, ct);
                    var itens = await repo.ItensAsync(h.IdPedidoVenda, ct);
                    if (itens.Count == 0) continue;
                    // enriquecimento best-effort (igual ao ciclo automático) — nunca quebra o envio
                    try { var nf = await repo.NfDoPedidoAsync(h.IdPedidoVenda, ct); if (nf is { } n) { h.NfNumero = n.Numero; h.NfChave = n.Chave; h.NfEmitidaEm = n.Emitida; h.NfValor = n.Valor; } } catch { }
                    try { var saldos = await repo.SaldosAsync(itens.Select(i => i.IdProduto).ToArray(), ct); foreach (var it in itens) if (saldos.TryGetValue(it.IdProduto, out var s)) it.SaldoEstoque = s; } catch { }
                    try { var pg = await repo.PagamentoDoPedidoAsync(h.IdPedidoVenda, ct); if (pg is { } p && !string.IsNullOrWhiteSpace(p.Forma)) { h.FormaPagamento = p.Forma; h.Parcelas = p.Parcelas; } } catch { }
                    var payload = PayloadBuilder.Build(h, cli, itens);
                    string pdf = Path.Combine(cfg.ResolvedTempDir, $"PedidoVenda_{h.IdPedidoVenda}.pdf");
                    var r = await client.EnviarAsync(payload, File.Exists(pdf) ? pdf : null, ct);
                    if (r is IngestResult.Created or IngestResult.Duplicate)
                    {
                        ok++;
                        if (string.IsNullOrWhiteSpace(h.NfNumero)) state.AddNfPendente(h.IdPedidoVenda, h.Codigo, DateTime.UtcNow);
                    }
                }
                catch (Exception ex) { log.LogWarning("Puxar: pedido {Cod} falhou: {Msg}", h.Codigo, ex.Message); }
            }
            log.LogInformation("Puxar: {N} pedido(s) sincronizado(s) (usuarios {U}).", ok, string.Join(",", hiperIds));
            return ok;
        }
        finally { gate.Lock.Release(); }
    }
}
