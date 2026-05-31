using ExpedAgent;

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddWindowsService(o => o.ServiceName = "ExpedAgent");

var cfg = builder.Configuration.GetSection("Agent").Get<AgentConfig>() ?? new AgentConfig();
builder.Services.AddSingleton(cfg);
builder.Services.AddSingleton(new HiperRepository(cfg.SqlConnectionString));
builder.Services.AddSingleton(new StateStore());
builder.Services.AddHttpClient<IngestClient>();
builder.Services.AddHostedService<Worker>();

var host = builder.Build();
host.Run();
