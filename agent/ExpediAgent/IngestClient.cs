using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using Microsoft.Extensions.Logging;
namespace ExpediAgent;

public enum IngestResult { Created, Duplicate, Unauthorized, Invalid, Error }

public sealed class IngestClient(HttpClient http, AgentConfig cfg, ILogger<IngestClient> log)
{
    public async Task<IngestResult> EnviarAsync(IngestPayload payload, string? pdfPath, CancellationToken ct)
    {
        var json = JsonSerializer.Serialize(payload);
        using var form = new MultipartFormDataContent();
        form.Add(new StringContent(json), "dados");
        if (pdfPath is not null && File.Exists(pdfPath))
        {
            var bytes = await File.ReadAllBytesAsync(pdfPath, ct);
            var pdf = new ByteArrayContent(bytes);
            pdf.Headers.ContentType = new MediaTypeHeaderValue("application/pdf");
            form.Add(pdf, "file", Path.GetFileName(pdfPath));
        }
        using var req = new HttpRequestMessage(HttpMethod.Post, $"{cfg.ApiBaseUrl}/api/ingest/pedido") { Content = form };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", cfg.DeviceToken);
        try
        {
            using var res = await http.SendAsync(req, ct);
            var body = await res.Content.ReadAsStringAsync(ct);
            return res.StatusCode switch
            {
                HttpStatusCode.Created => IngestResult.Created,
                HttpStatusCode.OK => IngestResult.Duplicate, // corpo: {duplicate:true}
                HttpStatusCode.Unauthorized => Log(IngestResult.Unauthorized, $"401 token: {body}"),
                HttpStatusCode.UnprocessableEntity => Log(IngestResult.Invalid, $"422: {body}"),
                _ => Log(IngestResult.Error, $"{(int)res.StatusCode}: {body}"),
            };
        }
        catch (Exception ex) { return Log(IngestResult.Error, ex.Message); }
    }

    /// <summary>Pinga o heartbeat (best-effort) pro painel da frota saber que está vivo.</summary>
    public async Task HeartbeatAsync(CancellationToken ct)
    {
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, $"{cfg.ApiBaseUrl}/api/agent/heartbeat");
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", cfg.DeviceToken);
            using var res = await http.SendAsync(req, ct);
            if (!res.IsSuccessStatusCode) log.LogDebug("Heartbeat {Code}", (int)res.StatusCode);
        }
        catch (Exception ex) { log.LogDebug("Heartbeat falhou: {Msg}", ex.Message); }
    }

    /// <summary>Consulta a versão publicada (pra avisar de atualização). Null se indisponível.</summary>
    public async Task<string?> LatestVersionAsync(CancellationToken ct)
    {
        try
        {
            using var res = await http.GetAsync($"{cfg.ApiBaseUrl}/api/agent/version", ct);
            if (!res.IsSuccessStatusCode) return null;
            using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync(ct));
            return doc.RootElement.TryGetProperty("latest", out var v) ? v.GetString() : null;
        }
        catch { return null; }
    }

    private IngestResult Log(IngestResult r, string msg) { log.LogWarning("Ingest {Result}: {Msg}", r, msg); return r; }
}
