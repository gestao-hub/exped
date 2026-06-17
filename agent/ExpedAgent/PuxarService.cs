using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;
namespace ExpedAgent;

/// <summary>
/// Gatilho local "Puxar": o app do hub chama http://127.0.0.1:{SyncNowPort}/sync-now?ids=ID1,ID2
/// e o agente sincroniza NA HORA só os pedidos recentes daqueles usuários do Hiper (o vendedor
/// que clicou). Bind SÓ em 127.0.0.1 — só o app no mesmo servidor alcança. Pula a estabilização
/// (o vendedor confirmou que terminou). Serializa com o ciclo automático via SyncGate.
/// </summary>
public sealed class PuxarService(
    AgentConfig cfg, HiperRepository repo, IngestClient client, StateStore state,
    RemoteConfigClient remote, SyncGate gate, ILogger<PuxarService> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        if (cfg.SyncNowPort <= 0) return;
        HttpListener listener;
        try
        {
            listener = new HttpListener();
            listener.Prefixes.Add($"http://127.0.0.1:{cfg.SyncNowPort}/");
            listener.Start();
            log.LogInformation("Gatilho 'Puxar' ouvindo em http://127.0.0.1:{Port}/sync-now", cfg.SyncNowPort);
        }
        catch (Exception ex)
        {
            log.LogWarning("Gatilho 'Puxar' não abriu na porta {Port}: {Msg}", cfg.SyncNowPort, ex.Message);
            return;
        }

        using (ct.Register(() => { try { listener.Stop(); } catch { /* encerrando */ } }))
        {
            while (!ct.IsCancellationRequested)
            {
                HttpListenerContext httpCtx;
                try { httpCtx = await listener.GetContextAsync(); }
                catch { break; } // listener parado (cancelamento)
                _ = HandleAsync(httpCtx, ct);
            }
        }
    }

    private async Task HandleAsync(HttpListenerContext httpCtx, CancellationToken ct)
    {
        int synced = 0;
        string msg = "ok";
        try
        {
            var idsRaw = httpCtx.Request.QueryString["ids"] ?? "";
            var ids = idsRaw.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                            .Select(s => int.TryParse(s, out var n) ? n : -1)
                            .Where(n => n > 0).Distinct().ToArray();
            if (ids.Length == 0) msg = "sem ids";
            else
            {
                var rc = await remote.GetAsync(ct);
                synced = await SincronizarAsync(ids, AgentConfig.ParseSituacoes(rc.SituacoesVenda), ct);
            }
        }
        catch (Exception ex) { msg = ex.Message; log.LogWarning("Puxar falhou: {Msg}", ex.Message); }

        try
        {
            var buf = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { synced, msg }));
            httpCtx.Response.ContentType = "application/json";
            httpCtx.Response.StatusCode = 200;
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
