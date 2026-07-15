using System.Net.Http.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace ExpedAgent;

public sealed record AgentRuntimeConfig(string SituacoesVenda, bool SyncOs, string SituacoesOs, int PollSegundos);

/// Busca a config do agente no hub local (/api/agent/config). Mantém o último valor
/// bom em memória; em falha, devolve o cache (ou os defaults do appsettings).
public sealed class RemoteConfigClient(
    HttpClient http,
    IOptionsMonitor<AgentConfig> liveCfg,
    ILogger<RemoteConfigClient> log)
{
    private AgentRuntimeConfig? _cache;

    public async Task<AgentRuntimeConfig> GetAsync(CancellationToken ct)
    {
        var cfg = liveCfg.CurrentValue;
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, $"{cfg.ApiBaseUrl}/api/agent/config");
            req.Headers.Authorization = new("Bearer", cfg.DeviceToken);
            using var res = await http.SendAsync(req, ct);
            res.EnsureSuccessStatusCode();
            var dto = await res.Content.ReadFromJsonAsync<ConfigDto>(cancellationToken: ct)
                      ?? throw new InvalidOperationException("config vazia");
            _cache = new(dto.situacoesVenda ?? cfg.SituacoesGatilho, dto.syncOs,
                         dto.situacoesOs ?? "", dto.pollSegundos > 0 ? dto.pollSegundos : cfg.PollIntervalSeconds);
            return _cache;
        }
        catch (Exception e)
        {
            log.LogWarning("Falha ao ler /api/agent/config ({Msg}); usando cache/defaults.", e.Message);
            return _cache ?? new(cfg.SituacoesGatilho, cfg.SyncOs, cfg.SituacoesOsGatilho, cfg.PollIntervalSeconds);
        }
    }

    private sealed record ConfigDto(string? situacoesVenda, bool syncOs, string? situacoesOs, int pollSegundos);
}
