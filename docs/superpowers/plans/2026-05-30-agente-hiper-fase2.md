# Agente Hiper (Fase 2) — Implementation Plan

> **For agentic workers:** este plano é executado numa **máquina Windows com .NET 8 SDK** (o agente lê SQL Server local e roda como Serviço do Windows). O código C# não é compilável no ambiente atual (Linux/sem .NET) — cada tarefa traz o arquivo completo + comandos `dotnet`/`sc.exe` pra rodar no Windows. Use checkbox (`- [ ]`).

**Goal:** Um agente que roda na máquina do cliente, detecta pedidos novos no Hiper (SQL Server local), monta o payload e faz POST autenticado no `/api/ingest/pedido` (validado na Fase 1), fechando o ciclo Hiper → plataforma.

**Architecture:** Worker Service .NET 8 (Serviço do Windows), publicado como **.exe self-contained único**. A cada intervalo, consulta `pedido_venda` (novos, situação-gatilho, id > high-water-mark); para cada um, monta cliente/itens/total a partir do schema mapeado, anexa o PDF `%TEMP%\PedidoVenda_{id}.pdf` se existir (regra de carência pra esperar a impressão), e faz POST multipart com Bearer = token do dispositivo. Dedup é no servidor (por `documento_erp`). Estado (HWM) persistido em `%ProgramData%`.

**Tech Stack:** .NET 8 (LTS), `Microsoft.Extensions.Hosting.WindowsServices`, `Microsoft.Data.SqlClient`, `HttpClient`, `System.Text.Json`. Empacotamento: `dotnet publish` single-file win-x64 + `sc.exe` (instalador Inno Setup como tarefa final opcional).

---

## Contexto — schema do Hiper (já mapeado, ver memória `hiper-schema-local`)

- Conexão: `Server=.\HIPER;Database=Hiper;Trusted_Connection=True;TrustServerCertificate=True;` (Windows Auth).
- `pedido_venda`: `id_pedido_venda` (PK int), `codigo` (ex "L602"), `situacao` (smallint; **5=aberto** observado p/ pedidos novos — CONFIRMAR por instalação), `data_hora_geracao`, `id_entidade_cliente`, `id_usuario_vendedor`, `valor_frete`, `data_previsao_entrega_inicial`/`_final`, `observacao`, `excluido`.
- Cliente: `entidade` (`nome`, `logradouro`, `numero_endereco`, `complemento`, `bairro`, `cep`, `fone_primario_ddd`, `fone_primario_numero`, `id_cidade`) + `pessoa_fisica.cpf` / `pessoa_juridica.cnpj` (por `id_entidade`) + `cidade` (`nome`, `uf`, por `id_cidade`).
- Itens: `item_pedido_venda` (`sequencia_item`, `id_produto`, `valor_unitario`, `valor_unitario_com_desconto`, `excluido`, `cancelado`) + `grade_pedido_venda.quantidade` (JOIN por `id_pedido_venda`+`sequencia_item`) + `produto` (`codigo`, `nome`).
- **valor_total** = Σ(`grade.quantidade` × `item.valor_unitario_com_desconto`). PDF: `%TEMP%\PedidoVenda_{id_pedido_venda}.pdf`.
- Endpoint alvo (Fase 1): `POST {ApiBaseUrl}/api/ingest/pedido`, header `Authorization: Bearer <devicetoken>`, multipart com `dados` (JSON) + `file` (PDF opcional). Schema do `dados` = `lib/validators/ingest.ts` (sem empresa/pagamento — resolvidos no servidor). Respostas: 201 criado, 200 `{duplicate}`, 401 token, 422 validação.

## File Structure (projeto em `agent/` do repo)

- `agent/ExpedAgent/ExpedAgent.csproj` — projeto Worker Service.
- `agent/ExpedAgent/appsettings.json` — config (URL, token, conexão, intervalo, situação-gatilho, carência do PDF).
- `agent/ExpedAgent/Config.cs` — POCO de configuração.
- `agent/ExpedAgent/Models.cs` — DTOs (PedidoHeader, Cliente, Item, payload de ingestão).
- `agent/ExpedAgent/HiperRepository.cs` — consultas ao SQL Server.
- `agent/ExpedAgent/PayloadBuilder.cs` — monta o JSON do `dados`.
- `agent/ExpedAgent/IngestClient.cs` — POST multipart pro endpoint.
- `agent/ExpedAgent/StateStore.cs` — high-water mark em `%ProgramData%`.
- `agent/ExpedAgent/Worker.cs` — loop principal (BackgroundService).
- `agent/ExpedAgent/Program.cs` — host + Windows Service.
- `agent/.gitignore` — ignora `bin/`, `obj/`.
- `agent/README.md` — build, config, instalação como serviço, teste.

## Decisões de design (travadas)

- **Gatilho:** poll periódico de `pedido_venda` por `situacao = SituacaoGatilho` (default 5) e `id_pedido_venda > HWM`.
- **PDF + carência:** ao detectar um pedido novo, se o PDF ainda não existe em `%TEMP%`, **espera** (não avança o HWM) até o PDF aparecer OU o pedido ficar mais velho que `PdfGraceMinutes` (default 3) — então sincroniza sem PDF (pagamento fica vazio; vendedor preenche na revisão). Cobre o caso "DB nasce antes da impressão".
- **HWM:** maior `id_pedido_venda` já sincronizado, em `%ProgramData%\ExpedAgent\state.json`. Dedup definitivo é no servidor (por `documento_erp`).
- **Auth:** Bearer = token do dispositivo (provisionado na nuvem; ver Tarefa 11).
- **Sem credencial de banco:** Windows Auth (Trusted_Connection) — o serviço roda sob conta com acesso de leitura ao `Hiper`.

---

## Task 1: Scaffold do projeto

**Files:** `agent/ExpedAgent/ExpedAgent.csproj`, `agent/.gitignore`

- [ ] **Step 1: Criar o projeto** (na máquina Windows, na raiz do repo)
```bat
dotnet new worker -n ExpedAgent -o agent\ExpedAgent
cd agent\ExpedAgent
dotnet add package Microsoft.Data.SqlClient
dotnet add package Microsoft.Extensions.Hosting.WindowsServices
```

- [ ] **Step 2: Ajustar o `.csproj`** (substituir conteúdo)
```xml
<Project Sdk="Microsoft.NET.Sdk.Worker">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <OutputType>exe</OutputType>
    <RuntimeIdentifier>win-x64</RuntimeIdentifier>
    <PublishSingleFile>true</PublishSingleFile>
    <SelfContained>true</SelfContained>
    <AssemblyName>ExpedAgent</AssemblyName>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.Data.SqlClient" Version="5.2.2" />
    <PackageReference Include="Microsoft.Extensions.Hosting" Version="8.0.1" />
    <PackageReference Include="Microsoft.Extensions.Hosting.WindowsServices" Version="8.0.1" />
  </ItemGroup>
</Project>
```

- [ ] **Step 3: `agent/.gitignore`**
```
bin/
obj/
*.user
```

- [ ] **Step 4: Compila vazio** `dotnet build` → Expected: Build succeeded.
- [ ] **Step 5: Commit** `git add agent/ && git commit -m "chore(agent): scaffold do Worker Service .NET 8"`

---

## Task 2: Configuração

**Files:** `agent/ExpedAgent/appsettings.json`, `Config.cs`

- [ ] **Step 1: `appsettings.json`**
```json
{
  "Agent": {
    "ApiBaseUrl": "https://franzoni.vercel.app",
    "DeviceToken": "COLE_O_TOKEN_DO_DISPOSITIVO_AQUI",
    "SqlConnectionString": "Server=.\\HIPER;Database=Hiper;Trusted_Connection=True;TrustServerCertificate=True;",
    "PollIntervalSeconds": 30,
    "SituacaoGatilho": 5,
    "PdfGraceMinutes": 3,
    "TempDir": ""
  },
  "Logging": { "LogLevel": { "Default": "Information" } }
}
```
> `TempDir` vazio = usa `Path.GetTempPath()`. Em serviço rodando como LocalSystem, o %TEMP% pode diferir do usuário — ver Tarefa 9 (apontar pro TEMP do usuário do PDV se necessário).

- [ ] **Step 2: `Config.cs`**
```csharp
namespace ExpedAgent;

public sealed class AgentConfig
{
    public string ApiBaseUrl { get; set; } = "";
    public string DeviceToken { get; set; } = "";
    public string SqlConnectionString { get; set; } = "";
    public int PollIntervalSeconds { get; set; } = 30;
    public short SituacaoGatilho { get; set; } = 5;
    public int PdfGraceMinutes { get; set; } = 3;
    public string TempDir { get; set; } = "";
    public string ResolvedTempDir => string.IsNullOrWhiteSpace(TempDir) ? Path.GetTempPath() : TempDir;
}
```

- [ ] **Step 3: Commit** `git commit -am "feat(agent): config (URL, token, conexão, intervalo)"`

---

## Task 3: DTOs

**Files:** `agent/ExpedAgent/Models.cs`

- [ ] **Step 1: `Models.cs`**
```csharp
using System.Text.Json.Serialization;
namespace ExpedAgent;

public sealed class PedidoHeader
{
    public int IdPedidoVenda { get; set; }
    public string Codigo { get; set; } = "";
    public DateTime DataHoraGeracao { get; set; }
    public int IdEntidadeCliente { get; set; }
    public int IdUsuarioVendedor { get; set; }
    public DateTime? DataEntrega { get; set; }
    public string? Observacao { get; set; }
}

public sealed class ClienteRow
{
    public string Nome { get; set; } = "";
    public string? CpfCnpj { get; set; }
    public string? Logradouro { get; set; }
    public string? Numero { get; set; }
    public string? Complemento { get; set; }
    public string? Bairro { get; set; }
    public string? Cep { get; set; }
    public string? Cidade { get; set; }
    public string? Uf { get; set; }
    public string? FoneDdd { get; set; }
    public string? FoneNumero { get; set; }
}

public sealed class ItemRow
{
    public string Codigo { get; set; } = "";
    public string Descricao { get; set; } = "";
    public decimal Quantidade { get; set; }
    public decimal ValorUnitario { get; set; }
    public decimal ValorUnitarioComDesconto { get; set; }
}

// ---- payload pro endpoint (snake_case, igual ingestPedidoSchema) ----
public sealed class IngestItem
{
    [JsonPropertyName("codigo")] public string Codigo { get; set; } = "";
    [JsonPropertyName("descricao")] public string Descricao { get; set; } = "";
    [JsonPropertyName("quantidade")] public decimal Quantidade { get; set; }
    [JsonPropertyName("unidade")] public string Unidade { get; set; } = "UN";
    [JsonPropertyName("preco_unitario")] public decimal PrecoUnitario { get; set; }
    [JsonPropertyName("desconto")] public decimal Desconto { get; set; }
    [JsonPropertyName("total")] public decimal Total { get; set; }
    [JsonPropertyName("referencia")] public string? Referencia { get; set; }
}
public sealed class IngestPonto
{
    [JsonPropertyName("tipo")] public string Tipo { get; set; } = "loja";
    [JsonPropertyName("empresa_nome")] public string EmpresaNome { get; set; } = "";
    [JsonPropertyName("endereco")] public string? Endereco { get; set; }
    [JsonPropertyName("itens")] public List<IngestItem> Itens { get; set; } = new();
}
public sealed class IngestPayload
{
    [JsonPropertyName("documento_erp")] public string? DocumentoErp { get; set; }
    [JsonPropertyName("data_emissao")] public string? DataEmissao { get; set; }
    [JsonPropertyName("data_entrega")] public string? DataEntrega { get; set; }
    [JsonPropertyName("hiper_usuario_id")] public int HiperUsuarioId { get; set; }
    [JsonPropertyName("cliente_codigo")] public string? ClienteCodigo { get; set; }
    [JsonPropertyName("cliente_nome")] public string ClienteNome { get; set; } = "";
    [JsonPropertyName("cliente_cnpj_cpf")] public string? ClienteCnpjCpf { get; set; }
    [JsonPropertyName("cliente_endereco")] public string? ClienteEndereco { get; set; }
    [JsonPropertyName("cliente_bairro")] public string? ClienteBairro { get; set; }
    [JsonPropertyName("cliente_cidade")] public string? ClienteCidade { get; set; }
    [JsonPropertyName("cliente_uf")] public string? ClienteUf { get; set; }
    [JsonPropertyName("cliente_cep")] public string? ClienteCep { get; set; }
    [JsonPropertyName("cliente_telefone")] public string? ClienteTelefone { get; set; }
    [JsonPropertyName("valor_total")] public decimal ValorTotal { get; set; }
    [JsonPropertyName("observacoes")] public string? Observacoes { get; set; }
    [JsonPropertyName("pontos_retirada")] public List<IngestPonto> PontosRetirada { get; set; } = new();
}
```

- [ ] **Step 2: Commit** `git commit -am "feat(agent): DTOs do Hiper e do payload de ingestão"`

---

## Task 4: Repositório SQL

**Files:** `agent/ExpedAgent/HiperRepository.cs`

> ⚠️ Nomes de coluna do cliente (`numero_endereco`, `fone_primario_*`, `entidade.codigo`) vieram do mapeamento; **confirmar 1x** no SQL Server real e ajustar se preciso (o agente loga o erro de coluna se divergir).

- [ ] **Step 1: `HiperRepository.cs`**
```csharp
using Microsoft.Data.SqlClient;
namespace ExpedAgent;

public sealed class HiperRepository(string connectionString)
{
    private readonly string _cs = connectionString;

    public async Task<List<PedidoHeader>> NovosPedidosAsync(int hwm, short situacao, CancellationToken ct)
    {
        const string sql = @"
SELECT pv.id_pedido_venda, pv.codigo, pv.data_hora_geracao, pv.id_entidade_cliente,
       pv.id_usuario_vendedor, pv.data_previsao_entrega_final, pv.data_previsao_entrega_inicial, pv.observacao
FROM pedido_venda pv WITH (NOLOCK)
WHERE pv.excluido = 0 AND pv.situacao = @sit AND pv.id_pedido_venda > @hwm
ORDER BY pv.id_pedido_venda;";
        var list = new List<PedidoHeader>();
        await using var cn = new SqlConnection(_cs);
        await cn.OpenAsync(ct);
        await using var cmd = new SqlCommand(sql, cn);
        cmd.Parameters.AddWithValue("@sit", situacao);
        cmd.Parameters.AddWithValue("@hwm", hwm);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        while (await r.ReadAsync(ct))
        {
            list.Add(new PedidoHeader
            {
                IdPedidoVenda = r.GetInt32(0),
                Codigo = r.GetString(1),
                DataHoraGeracao = r.GetDateTime(2),
                IdEntidadeCliente = r.GetInt32(3),
                IdUsuarioVendedor = r.GetInt32(4),
                DataEntrega = r.IsDBNull(5) ? (r.IsDBNull(6) ? null : r.GetDateTime(6)) : r.GetDateTime(5),
                Observacao = r.IsDBNull(7) ? null : r.GetString(7),
            });
        }
        return list;
    }

    public async Task<ClienteRow?> ClienteAsync(int idEntidade, CancellationToken ct)
    {
        const string sql = @"
SELECT e.nome,
       COALESCE(pf.cpf, pj.cnpj) AS cpf_cnpj,
       e.logradouro, e.numero_endereco, e.complemento, e.bairro, e.cep,
       c.nome AS cidade, c.uf, e.fone_primario_ddd, e.fone_primario_numero
FROM entidade e WITH (NOLOCK)
LEFT JOIN pessoa_fisica pf WITH (NOLOCK) ON pf.id_entidade = e.id_entidade
LEFT JOIN pessoa_juridica pj WITH (NOLOCK) ON pj.id_entidade = e.id_entidade
LEFT JOIN cidade c WITH (NOLOCK) ON c.id_cidade = e.id_cidade
WHERE e.id_entidade = @id;";
        await using var cn = new SqlConnection(_cs);
        await cn.OpenAsync(ct);
        await using var cmd = new SqlCommand(sql, cn);
        cmd.Parameters.AddWithValue("@id", idEntidade);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        if (!await r.ReadAsync(ct)) return null;
        string? S(int i) => r.IsDBNull(i) ? null : Convert.ToString(r.GetValue(i));
        return new ClienteRow
        {
            Nome = r.GetString(0), CpfCnpj = S(1), Logradouro = S(2), Numero = S(3),
            Complemento = S(4), Bairro = S(5), Cep = S(6), Cidade = S(7), Uf = S(8),
            FoneDdd = S(9), FoneNumero = S(10),
        };
    }

    public async Task<List<ItemRow>> ItensAsync(int idPedido, CancellationToken ct)
    {
        const string sql = @"
SELECT p.codigo, p.nome, g.quantidade, ipv.valor_unitario, ipv.valor_unitario_com_desconto
FROM item_pedido_venda ipv WITH (NOLOCK)
JOIN grade_pedido_venda g WITH (NOLOCK)
  ON g.id_pedido_venda = ipv.id_pedido_venda AND g.sequencia_item = ipv.sequencia_item
JOIN produto p WITH (NOLOCK) ON p.id_produto = ipv.id_produto
WHERE ipv.id_pedido_venda = @id AND ipv.excluido = 0 AND ipv.cancelado = 0
ORDER BY ipv.sequencia_item;";
        var list = new List<ItemRow>();
        await using var cn = new SqlConnection(_cs);
        await cn.OpenAsync(ct);
        await using var cmd = new SqlCommand(sql, cn);
        cmd.Parameters.AddWithValue("@id", idPedido);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        while (await r.ReadAsync(ct))
        {
            list.Add(new ItemRow
            {
                Codigo = Convert.ToString(r.GetValue(0)) ?? "",
                Descricao = r.GetString(1),
                Quantidade = r.GetDecimal(2),
                ValorUnitario = r.GetDecimal(3),
                ValorUnitarioComDesconto = r.GetDecimal(4),
            });
        }
        return list;
    }
}
```

- [ ] **Step 2: Build** `dotnet build` → Expected: succeeded.
- [ ] **Step 3: Commit** `git commit -am "feat(agent): consultas SQL (pedido, cliente, itens)"`

---

## Task 5: Builder do payload

**Files:** `agent/ExpedAgent/PayloadBuilder.cs`

- [ ] **Step 1: `PayloadBuilder.cs`**
```csharp
namespace ExpedAgent;

public static class PayloadBuilder
{
    public static IngestPayload Build(PedidoHeader h, ClienteRow? c, List<ItemRow> itens, string empresaNome = "Franzoni")
    {
        var pontoItens = itens.Select(it => new IngestItem
        {
            Codigo = it.Codigo,
            Descricao = it.Descricao,
            Quantidade = it.Quantidade,
            Unidade = "UN",
            PrecoUnitario = it.ValorUnitario,
            Desconto = Math.Max(0m, (it.ValorUnitario - it.ValorUnitarioComDesconto) * it.Quantidade),
            Total = it.Quantidade * it.ValorUnitarioComDesconto,
        }).ToList();

        var endereco = string.Join(" ", new[] { c?.Logradouro, c?.Numero, c?.Complemento }
            .Where(s => !string.IsNullOrWhiteSpace(s))).Trim();
        var fone = string.Join("", new[] { c?.FoneDdd, c?.FoneNumero }.Where(s => !string.IsNullOrWhiteSpace(s)));

        return new IngestPayload
        {
            DocumentoErp = h.Codigo,
            DataEmissao = h.DataHoraGeracao.ToString("yyyy-MM-dd"),
            DataEntrega = h.DataEntrega?.ToString("yyyy-MM-dd"),
            HiperUsuarioId = h.IdUsuarioVendedor,
            ClienteNome = c?.Nome ?? "Cliente",
            ClienteCnpjCpf = string.IsNullOrWhiteSpace(c?.CpfCnpj) ? null : c!.CpfCnpj,
            ClienteEndereco = string.IsNullOrWhiteSpace(endereco) ? null : endereco,
            ClienteBairro = c?.Bairro,
            ClienteCidade = c?.Cidade,
            ClienteUf = c?.Uf,
            ClienteCep = c?.Cep,
            ClienteTelefone = string.IsNullOrWhiteSpace(fone) ? null : fone,
            ValorTotal = pontoItens.Sum(i => i.Total),
            Observacoes = h.Observacao,
            PontosRetirada = new List<IngestPonto>
            {
                new() { Tipo = "loja", EmpresaNome = empresaNome, Itens = pontoItens }
            },
        };
    }
}
```

- [ ] **Step 2: Commit** `git commit -am "feat(agent): builder do payload de ingestão"`

---

## Task 6: Cliente HTTP (POST multipart)

**Files:** `agent/ExpedAgent/IngestClient.cs`

- [ ] **Step 1: `IngestClient.cs`**
```csharp
using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
namespace ExpedAgent;

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
                HttpStatusCode.OK => IngestResult.Duplicate, // {duplicate:true}
                HttpStatusCode.Unauthorized => Log(IngestResult.Unauthorized, $"401 token: {body}"),
                HttpStatusCode.UnprocessableEntity => Log(IngestResult.Invalid, $"422: {body}"),
                _ => Log(IngestResult.Error, $"{(int)res.StatusCode}: {body}"),
            };
        }
        catch (Exception ex) { return Log(IngestResult.Error, ex.Message); }
    }

    private IngestResult Log(IngestResult r, string msg) { log.LogWarning("Ingest {Result}: {Msg}", r, msg); return r; }
}
```

- [ ] **Step 2: Commit** `git commit -am "feat(agent): cliente HTTP de ingestão (multipart + bearer)"`

---

## Task 7: Estado (high-water mark)

**Files:** `agent/ExpedAgent/StateStore.cs`

- [ ] **Step 1: `StateStore.cs`**
```csharp
using System.Text.Json;
namespace ExpedAgent;

public sealed class StateStore
{
    private readonly string _path;
    public StateStore()
    {
        var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "ExpedAgent");
        Directory.CreateDirectory(dir);
        _path = Path.Combine(dir, "state.json");
    }
    private sealed class State { public int Hwm { get; set; } }

    public int GetHwm()
    {
        try { return File.Exists(_path) ? (JsonSerializer.Deserialize<State>(File.ReadAllText(_path))?.Hwm ?? 0) : 0; }
        catch { return 0; }
    }
    public void SetHwm(int hwm) => File.WriteAllText(_path, JsonSerializer.Serialize(new State { Hwm = hwm }));
}
```

- [ ] **Step 2: Commit** `git commit -am "feat(agent): persistência do high-water mark"`

---

## Task 8: Worker (loop principal)

**Files:** `agent/ExpedAgent/Worker.cs`, `Program.cs`

- [ ] **Step 1: `Worker.cs`**
```csharp
namespace ExpedAgent;

public sealed class Worker(AgentConfig cfg, HiperRepository repo, IngestClient client, StateStore state, ILogger<Worker> log)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        log.LogInformation("Agente Hiper iniciado. Poll a cada {S}s, situação-gatilho {Sit}.", cfg.PollIntervalSeconds, cfg.SituacaoGatilho);
        while (!ct.IsCancellationRequested)
        {
            try { await TickAsync(ct); }
            catch (Exception ex) { log.LogError(ex, "Erro no ciclo de sync"); }
            await Task.Delay(TimeSpan.FromSeconds(cfg.PollIntervalSeconds), ct);
        }
    }

    private async Task TickAsync(CancellationToken ct)
    {
        int hwm = state.GetHwm();
        var novos = await repo.NovosPedidosAsync(hwm, cfg.SituacaoGatilho, ct);
        if (novos.Count == 0) return;

        int maxOk = hwm;
        foreach (var h in novos)
        {
            string pdf = Path.Combine(cfg.ResolvedTempDir, $"PedidoVenda_{h.IdPedidoVenda}.pdf");
            bool pdfExiste = File.Exists(pdf);
            bool dentroCarencia = (DateTime.Now - h.DataHoraGeracao).TotalMinutes < cfg.PdfGraceMinutes;

            // Espera o PDF (impressão) enquanto estiver na carência; não avança o HWM.
            if (!pdfExiste && dentroCarencia)
            {
                log.LogInformation("Pedido {Cod}: aguardando PDF (carência).", h.Codigo);
                break; // mantém ordem; tenta de novo no próximo poll
            }

            var cli = await repo.ClienteAsync(h.IdEntidadeCliente, ct);
            var itens = await repo.ItensAsync(h.IdPedidoVenda, ct);
            if (itens.Count == 0) { log.LogWarning("Pedido {Cod} sem itens — pulando.", h.Codigo); maxOk = h.IdPedidoVenda; continue; }

            var payload = PayloadBuilder.Build(h, cli, itens);
            var r = await client.EnviarAsync(payload, pdfExiste ? pdf : null, ct);

            if (r is IngestResult.Created or IngestResult.Duplicate)
            {
                log.LogInformation("Pedido {Cod} sincronizado ({R}{Pdf}).", h.Codigo, r, pdfExiste ? ", com PDF" : ", sem PDF");
                maxOk = h.IdPedidoVenda;
            }
            else
            {
                log.LogWarning("Pedido {Cod} falhou ({R}); parando o lote (tenta no próximo poll).", h.Codigo, r);
                break; // não avança além de uma falha pra preservar ordem
            }
        }
        if (maxOk > hwm) state.SetHwm(maxOk);
    }
}
```

- [ ] **Step 2: `Program.cs`**
```csharp
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
```

- [ ] **Step 3: Build** `dotnet build` → Expected: succeeded.
- [ ] **Step 4: Commit** `git commit -am "feat(agent): worker de sync com carência de PDF e HWM"`

---

## Task 9: Rodar e testar (Windows, console)

- [ ] **Step 1: Provisionar dispositivo + vendedor na nuvem** (ver Tarefa 11) e colar o token em `appsettings.json` (`DeviceToken`). Conferir `SituacaoGatilho` real no Hiper.
- [ ] **Step 2: Rodar em console** (não como serviço ainda)
```bat
cd agent\ExpedAgent
dotnet run
```
- [ ] **Step 3: No Hiper, criar um pedido de venda real** (com itens, cliente, e imprimir o PDF). Em até `PollInterval`+`carência`, o log deve mostrar `Pedido Lxxx sincronizado (Created, com PDF)`.
- [ ] **Step 4: Conferir na plataforma** (logado como o vendedor mapeado): o pedido aparece como **rascunho** com botão "Revisar e enviar". Abrir, conferir cliente/itens/total/observação e a forma de pagamento (do PDF).
- [ ] **Step 5: `%TEMP%` do serviço** — quando virar serviço (LocalSystem), o `%TEMP%` é `C:\Windows\Temp`, diferente do usuário do PDV. Se o PDF não for achado: rodar o serviço sob a **conta do usuário do PDV**, ou setar `Agent:TempDir` pro temp correto, ou (melhor) configurar o Hiper/PDV pra salvar o PDF numa pasta fixa e apontar `TempDir` pra ela.

---

## Task 10: Empacotar + instalar como Serviço do Windows

- [ ] **Step 1: Publicar single-file**
```bat
dotnet publish agent\ExpedAgent -c Release -r win-x64 ^
  -p:PublishSingleFile=true --self-contained true ^
  -o C:\ExpedAgent
```
Copie o `appsettings.json` (com o token) pra `C:\ExpedAgent` ao lado do `.exe`.

- [ ] **Step 2: Criar o serviço** (Admin)
```bat
sc create ExpedAgent binPath= "C:\ExpedAgent\ExpedAgent.exe" start= auto
sc description ExpedAgent "Sincroniza pedidos do Hiper com a plataforma Franzoni"
sc start ExpedAgent
```
- [ ] **Step 3: Verificar** `sc query ExpedAgent` → RUNNING. Logs no Visualizador de Eventos (Application) ou redirecionar pra arquivo (Tarefa futura).
- [ ] **Step 4: Commit** `git add agent/README.md && git commit -m "docs(agent): build, instalação como serviço e teste"`

---

## Task 11: Provisionamento na nuvem (SQL — operador)

> Até existir o painel (Fase 3), provisiona-se por SQL. Roda no Supabase (SQL Editor) ou via Management API. **NÃO exibir o token cru depois de gerado.**

- [ ] **Step 1: Gerar token + inserir hash** (gere um token aleatório, ex.: `openssl rand -hex 24` com prefixo `hpr_`; guarde o cru pro `appsettings.json`; insira só o SHA-256):
```sql
-- substitua <SHA256_DO_TOKEN> e <NOME_DA_LOJA>
insert into public.dispositivos (empresa_id, nome, token_hash, ativo)
values ('00000000-0000-0000-0000-0000000f0001', '<NOME_DA_LOJA>', '<SHA256_DO_TOKEN>', true);
```
- [ ] **Step 2: Mapear o vendedor real** (Hiper id → profile Franzoni do Michel):
```sql
insert into public.hiper_vendedor_map (empresa_id, hiper_usuario_id, hiper_usuario_nome, vendedor_id)
values ('00000000-0000-0000-0000-0000000f0001', 1, 'Michel', '<UUID_DO_MICHEL>')
on conflict (empresa_id, hiper_usuario_id) do update set vendedor_id = excluded.vendedor_id;
```

---

## Self-Review (cobertura)

- Detecta pedido novo no Hiper (poll situação-gatilho + HWM): Tasks 4, 8. ✓
- Monta cliente/itens/total do schema mapeado: Tasks 4, 5. ✓
- Anexa PDF (com carência pra impressão): Task 8. ✓
- POST autenticado por token de dispositivo: Task 6. ✓
- Roda como Serviço do Windows, .exe único: Tasks 1, 8, 10. ✓
- Provisionamento (token + vendedor): Task 11. ✓

**Pendências futuras (Fase 2b / 3, não-bloqueantes):**
- Auto-update do agente; heartbeat dedicado (hoje `last_seen_at` atualiza a cada POST de pedido); instalador Inno Setup assinado; logs em arquivo; FileSystemWatcher como gatilho real-time (alternativa ao poll).
- Confirmar nomes de coluna do cliente (`numero_endereco`, `fone_primario_*`, código do cliente) no SQL Server real.
- Confirmar o valor de `situacao` que representa "pronto pra logística" por instalação.
