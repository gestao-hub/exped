using ExpedAgent;

// O log vai pro agent.log via redirect do start.cmd, que é block-buffered → o arquivo ficava
// "parado" e o watchdog (mtime > 15min) reiniciava o agente à toa. AutoFlush no stdout grava
// cada linha na hora. (v1.4.3)
Console.SetOut(new StreamWriter(Console.OpenStandardOutput()) { AutoFlush = true });

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddWindowsService(o => o.ServiceName = "ExpedAgent");

var cfg = builder.Configuration.GetSection("Agent").Get<AgentConfig>() ?? new AgentConfig();
builder.Services.AddSingleton(cfg);
builder.Services.AddSingleton(new HiperRepository(cfg.SqlConnectionString));
builder.Services.AddSingleton(new StateStore());
builder.Services.AddHttpClient<IngestClient>();
builder.Services.AddHttpClient<RemoteConfigClient>();
builder.Services.AddHostedService<Worker>();

var host = builder.Build();
host.Run();
