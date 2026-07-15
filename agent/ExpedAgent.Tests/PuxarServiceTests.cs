using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;

namespace ExpedAgent.Tests;

public sealed class PuxarServiceTests
{
    [Fact]
    public async Task HandleAsync_ReturnsHttpFailureWithExplicitBody_WhenSyncFails()
    {
        var cfg = new AgentConfig
        {
            ApiBaseUrl = "http://config.test",
            SituacoesGatilho = "2",
        };
        var options = new StaticOptionsMonitor<AgentConfig>(cfg);
        var telemetry = new SyncNowTelemetry();
        var configHttp = new HttpClient(new StubHandler(new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(
                """{"situacoesVenda":"invalida","syncOs":false,"situacoesOs":"","pollSegundos":30}""",
                Encoding.UTF8,
                "application/json"),
        }));
        var service = new PuxarService(
            cfg,
            options,
            new HiperRepository(""),
            new IngestClient(new HttpClient(), options, NullLogger<IngestClient>.Instance),
            (StateStore)RuntimeHelpers.GetUninitializedObject(typeof(StateStore)),
            new RemoteConfigClient(configHttp, options, NullLogger<RemoteConfigClient>.Instance),
            new SyncGate(),
            telemetry,
            NullLogger<PuxarService>.Instance);

        var response = await InvokeHandleAsync(service, "ids=42");

        Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
        using var body = JsonDocument.Parse(response.Body);
        Assert.False(body.RootElement.GetProperty("success").GetBoolean());
        Assert.Equal(
            "Falha interna ao sincronizar pedidos.",
            body.RootElement.GetProperty("error").GetString());
        Assert.NotNull(telemetry.Last);
        Assert.False(telemetry.Last!.Ok);
        Assert.Equal(0, telemetry.Last.Synced);
    }

    private static async Task<CapturedResponse> InvokeHandleAsync(PuxarService service, string query)
    {
        var port = ReservePort();
        using var listener = new HttpListener();
        listener.Prefixes.Add($"http://127.0.0.1:{port}/");
        listener.Start();

        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
        var responseTask = client.GetAsync($"http://127.0.0.1:{port}/sync-now?{query}");
        var context = await listener.GetContextAsync().WaitAsync(TimeSpan.FromSeconds(10));

        var handle = typeof(PuxarService).GetMethod("HandleAsync", BindingFlags.Instance | BindingFlags.NonPublic)
                     ?? throw new InvalidOperationException("HandleAsync não encontrado.");
        var handleTask = (Task?)handle.Invoke(service, [context, CancellationToken.None])
                         ?? throw new InvalidOperationException("HandleAsync não retornou uma Task.");
        await handleTask.WaitAsync(TimeSpan.FromSeconds(10));

        using var response = await responseTask;
        return new CapturedResponse(response.StatusCode, await response.Content.ReadAsStringAsync());
    }

    private static int ReservePort()
    {
        using var socket = new TcpListener(IPAddress.Loopback, 0);
        socket.Start();
        return ((IPEndPoint)socket.LocalEndpoint).Port;
    }

    private sealed record CapturedResponse(HttpStatusCode StatusCode, string Body);

    private sealed class StubHandler(HttpResponseMessage response) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken) => Task.FromResult(response);
    }

    private sealed class StaticOptionsMonitor<T>(T value) : IOptionsMonitor<T>
    {
        public T CurrentValue => value;
        public T Get(string? name) => value;
        public IDisposable OnChange(Action<T, string?> listener) => NoopDisposable.Instance;
    }

    private sealed class NoopDisposable : IDisposable
    {
        public static readonly NoopDisposable Instance = new();
        public void Dispose() { }
    }
}
