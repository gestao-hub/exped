using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
namespace ExpedAgent;

public enum IngestResult { Created, Duplicate, Unauthorized, Invalid, Error }
public enum NfSyncResult { Ok, NotFound, Error }

public sealed class IngestClient(
    HttpClient http,
    IOptionsMonitor<AgentConfig> liveCfg,
    ILogger<IngestClient> log)
{
    public async Task<IngestResult> EnviarAsync(IngestPayload payload, string? pdfPath, CancellationToken ct)
    {
        var cfg = liveCfg.CurrentValue;
        var json = JsonSerializer.Serialize(payload);
        HttpContent content;
        if (pdfPath is not null && File.Exists(pdfPath))
        {
            // Com PDF: multipart (campo "dados" + "file").
            var form = new MultipartFormDataContent();
            form.Add(new StringContent(json, Encoding.UTF8, "application/json"), "dados");
            var bytes = await File.ReadAllBytesAsync(pdfPath, ct);
            var pdf = new ByteArrayContent(bytes);
            pdf.Headers.ContentType = new MediaTypeHeaderValue("application/pdf");
            form.Add(pdf, "file", Path.GetFileName(pdfPath));
            content = form;
        }
        else
        {
            // Sem PDF: JSON direto (o corpo É o objeto de dados). Evita o multipart,
            // que o req.formData() do Next sob Node 20 rejeitava (boundary/stream do .NET).
            content = new StringContent(json, Encoding.UTF8, "application/json");
        }
        using var req = new HttpRequestMessage(HttpMethod.Post, $"{cfg.ApiBaseUrl}/api/ingest/pedido") { Content = content };
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
        var cfg = liveCfg.CurrentValue;
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
        var cfg = liveCfg.CurrentValue;
        try
        {
            using var res = await http.GetAsync($"{cfg.ApiBaseUrl}/api/agent/version", ct);
            if (!res.IsSuccessStatusCode) return null;
            using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync(ct));
            return doc.RootElement.TryGetProperty("latest", out var v) ? v.GetString() : null;
        }
        catch { return null; }
    }

    /// <summary>Envia uma Ordem de Serviço pro endpoint /api/ingest/os.</summary>
    public async Task<IngestResult> EnviarOsAsync(IngestOsPayload payload, CancellationToken ct)
    {
        var cfg = liveCfg.CurrentValue;
        var json = JsonSerializer.Serialize(payload);
        // OS nunca tem arquivo no ingest → JSON direto (evita multipart).
        using var req = new HttpRequestMessage(HttpMethod.Post, $"{cfg.ApiBaseUrl}/api/ingest/os")
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json"),
        };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", cfg.DeviceToken);
        try
        {
            using var res = await http.SendAsync(req, ct);
            var body = await res.Content.ReadAsStringAsync(ct);
            return res.StatusCode switch
            {
                HttpStatusCode.Created => IngestResult.Created,
                HttpStatusCode.OK => IngestResult.Duplicate,
                HttpStatusCode.Unauthorized => Log(IngestResult.Unauthorized, $"401 OS: {body}"),
                HttpStatusCode.UnprocessableEntity => Log(IngestResult.Invalid, $"422 OS: {body}"),
                _ => Log(IngestResult.Error, $"OS {(int)res.StatusCode}: {body}"),
            };
        }
        catch (Exception ex) { return Log(IngestResult.Error, ex.Message); }
    }

    private IngestResult Log(IngestResult r, string msg) { log.LogWarning("Ingest {Result}: {Msg}", r, msg); return r; }
    private NfSyncResult Log(NfSyncResult r, string msg) { log.LogWarning("Ingest NF {Result}: {Msg}", r, msg); return r; }

    /// <summary>
    /// Re-sync de NF/pagamento de um pedido já ingerido. POST JSON em /api/ingest/pedido/nf.
    /// 200 → Ok (preencheu ou nada a fazer); 404 → NotFound (pedido sumiu/cancelado);
    /// outros → Error (tenta no próximo poll).
    /// </summary>
    public async Task<NfSyncResult> EnviarNfAsync(
        string documentoErp,
        (string? Numero, string? Chave, DateTime? Emitida, decimal? Valor) nf,
        (string? Forma, string? Parcelas)? pg,
        CancellationToken ct)
    {
        var cfg = liveCfg.CurrentValue;
        var payload = new IngestNfPayload
        {
            DocumentoErp = documentoErp,
            NfNumero = nf.Numero,
            NfChave = nf.Chave,
            NfEmitidaEm = nf.Emitida?.ToString("yyyy-MM-dd HH:mm:ss"),
            NfValor = nf.Valor,
            FormaPagamento = pg?.Forma,
            Parcelas = pg?.Parcelas,
        };
        var json = JsonSerializer.Serialize(payload);
        using var req = new HttpRequestMessage(HttpMethod.Post, $"{cfg.ApiBaseUrl}/api/ingest/pedido/nf")
        {
            Content = new StringContent(json, System.Text.Encoding.UTF8, "application/json"),
        };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", cfg.DeviceToken);
        try
        {
            using var res = await http.SendAsync(req, ct);
            return res.StatusCode switch
            {
                HttpStatusCode.OK => NfSyncResult.Ok,
                HttpStatusCode.NotFound => NfSyncResult.NotFound,
                _ => Log(NfSyncResult.Error, $"{(int)res.StatusCode}"),
            };
        }
        catch (Exception ex) { return Log(NfSyncResult.Error, ex.Message); }
    }
}
