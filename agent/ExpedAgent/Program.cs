using ExpedAgent;
using System.Text;
using System.Text.Json;

// O log vai pro agent.log via redirect do start.cmd, que é block-buffered → o arquivo ficava
// "parado" e o watchdog (mtime > 15min) reiniciava o agente à toa. AutoFlush no stdout grava
// cada linha na hora. (v1.4.3)
Console.SetOut(new StreamWriter(Console.OpenStandardOutput()) { AutoFlush = true });

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddWindowsService(o => o.ServiceName = "ExpedAgent");

// O agente pode ser iniciado por Startup ou como servico. Leia sempre o JSON ao
// lado do executavel e mantenha env/linha de comando com precedencia.
builder.Configuration
    .SetBasePath(AppContext.BaseDirectory)
    .AddJsonFile("appsettings.json", optional: false, reloadOnChange: true)
    .AddEnvironmentVariables();
if (args.Length > 0) builder.Configuration.AddCommandLine(args);

var agentSection = builder.Configuration.GetSection("Agent");
var cfg = agentSection.Get<AgentConfig>() ?? new AgentConfig();
builder.Services.Configure<AgentConfig>(agentSection);
builder.Services.AddSingleton(cfg);
builder.Services.AddSingleton(new HiperRepository(cfg.SqlConnectionString));
builder.Services.AddSingleton(new StateStore());
builder.Services.AddSingleton<SyncGate>();
builder.Services.AddSingleton<SyncNowTelemetry>();
builder.Services.AddHttpClient<IngestClient>();
builder.Services.AddHttpClient<RemoteConfigClient>();
builder.Services.AddHostedService<Worker>();
builder.Services.AddHostedService<PuxarService>();
builder.Services.AddHostedService<AgentReadinessService>();

var host = builder.Build();
host.Run();

public sealed class AgentReadinessService(
    HiperRepository repository,
    SyncNowTelemetry syncNowTelemetry,
    ILogger<AgentReadinessService> log) : BackgroundService
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
    };

    private static string HealthPath
    {
        get
        {
            var programData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
            if (string.IsNullOrWhiteSpace(programData)) programData = @"C:\ProgramData";
            return Path.Combine(programData, "ExpedAgent", "health.json");
        }
    }

    private static async Task WriteAtomicallyAsync(
        string target,
        AgentReadinessSnapshot snapshot,
        CancellationToken ct)
    {
        var directory = Path.GetDirectoryName(target)
            ?? throw new InvalidOperationException("Diretorio de readiness invalido.");
        Directory.CreateDirectory(directory);
        var temp = target + "." + Environment.ProcessId + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            var json = JsonSerializer.Serialize(snapshot, JsonOptions);
            await File.WriteAllTextAsync(temp, json, new UTF8Encoding(false), ct);
            File.Move(temp, target, true);
        }
        finally
        {
            if (File.Exists(temp)) File.Delete(temp);
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            var hiper = await repository.ProbeReadinessAsync(stoppingToken);
            var snapshot = AgentReadinessSnapshot.Create(
                Environment.ProcessId,
                AgentInfo.Version,
                hiper,
                syncNowTelemetry.Last);
            try
            {
                await WriteAtomicallyAsync(HealthPath, snapshot, stoppingToken);
                log.LogInformation(
                    "Readiness Agent: running=true; Hiper connected={Connected} queryOk={QueryOk} schemaCompatible={SchemaCompatible} target={Target}.",
                    hiper.Connected,
                    hiper.QueryOk,
                    hiper.SchemaCompatible,
                    hiper.TargetSchema);
            }
            catch (Exception ex) when (!stoppingToken.IsCancellationRequested)
            {
                log.LogWarning(ex, "Nao foi possivel publicar readiness em {Path}.", HealthPath);
            }

            try
            {
                await Task.Delay(TimeSpan.FromSeconds(30), stoppingToken);
            }
            catch (TaskCanceledException)
            {
                break;
            }
        }
    }
}
