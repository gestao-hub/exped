# ExpediAgent — agente local (Hiper → Expedi)

Serviço Windows (.NET 8) que detecta pedidos novos no Hiper (SQL Server local),
monta o payload e faz POST autenticado no `/api/ingest/pedido` da plataforma Expedi.

## Pré-requisitos (máquina do cliente)
- Windows + .NET 8 SDK (para build) — em produção o `.exe` é self-contained (não precisa runtime).
- Acesso de leitura ao SQL Server do Hiper (instância `.\HIPER`, banco `Hiper`) — Windows Auth.
- Um **token de dispositivo** provisionado na nuvem (ver "Provisionamento").

## Configurar
Edite `ExpediAgent/appsettings.json`:
- `ApiBaseUrl`: URL da plataforma (ex.: `https://franzoni.vercel.app`).
- `DeviceToken`: token do dispositivo (provisionado na nuvem).
- `SqlConnectionString`: conexão com o Hiper (default já aponta `.\HIPER`).
- `SituacoesGatilho`: lista CSV de `pedido_venda.situacao` que disparam o sync (default `2,5,7` = faturado/aberto/finalizado; **NÃO** inclui `6`=cancelado). Confirmar os valores na instalação.
- `PollIntervalSeconds` (30), `PdfGraceMinutes` (3), `TempDir` (vazio = `%TEMP%`).

## Rodar em console (teste)
```bat
cd agent\ExpediAgent
dotnet run
```
Crie um pedido no Hiper (com itens e PDF impresso); em ~poll+carência o log mostra
`Pedido Lxxx sincronizado (Created, com PDF)`. Confira na plataforma: o pedido aparece
como **rascunho** pro vendedor revisar ("Revisar e enviar").

## Publicar + instalar como Serviço do Windows
```bat
dotnet publish agent\ExpediAgent -c Release -r win-x64 -p:PublishSingleFile=true --self-contained true -o C:\ExpediAgent
:: copie o appsettings.json (com o token) pra C:\ExpediAgent ao lado do .exe
sc create ExpediAgent binPath= "C:\ExpediAgent\ExpediAgent.exe" start= auto
sc description ExpediAgent "Sincroniza pedidos do Hiper com a plataforma Expedi"
sc start ExpediAgent
```
> Como serviço (LocalSystem), o `%TEMP%` é `C:\Windows\Temp` — diferente do usuário do PDV.
> Se o PDF não for encontrado: rode o serviço sob a conta do usuário do PDV, ou aponte
> `Agent:TempDir` pro temp correto, ou configure o Hiper pra salvar o PDF numa pasta fixa.

## Instalação na máquina do cliente (Windows)

**Pré-requisitos:** Windows + **.NET 8 SDK** (`winget install Microsoft.DotNet.SDK.8`) **apenas para publicar**.
O publish é **self-contained** — a máquina final **não precisa** ter o runtime instalado.

**1) Publicar** (gera o `.exe` + dependências numa pasta do usuário):
```bat
dotnet publish -c Release -o "%LOCALAPPDATA%\ExpediAgent"
```

**2) Configurar** o `appsettings.json` **da pasta publicada** (`%LOCALAPPDATA%\ExpediAgent`)
com os valores **reais**: `ApiBaseUrl`, `DeviceToken` e `SqlConnectionString`.
⚠️ **NUNCA commitar esses valores** — o `DeviceToken` é segredo e fica só na máquina do cliente.

**3) Conta de execução (importante):** o `SqlConnectionString` usa `Trusted_Connection=True`
(autenticação do Windows). Logo, o agente **precisa rodar sob a conta de um usuário que tenha
acesso ao SQL do Hiper**. A conta de serviço padrão (`NT AUTHORITY\SYSTEM`) normalmente **NÃO**
tem esse acesso.

**⚠️ GOTCHA — ConsoleLifetime:** o host usa `ConsoleLifetime`, então o `.exe` **precisa de um
console**. Se for iniciado "oculto" sem console (ex.: `powershell -WindowStyle Hidden` chamando
o exe direto), ele **encerra na hora**. Solução validada — iniciar via um `start.cmd` que aloca
console e redireciona o log:
```bat
@echo off
cd /d "%~dp0"
"%~dp0ExpediAgent.exe" >> "%~dp0agent.log" 2>&1
```

### Opção A — Auto-start no logon SEM admin (recomendado sem direitos de Administrador)
Quando não há direitos de Administrador nem conta de serviço com acesso ao SQL, crie um `.vbs`
na pasta **Startup** do usuário
(`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\ExpediAgent.vbs`) que roda o
`start.cmd` 100% oculto:
```vbs
Set sh = CreateObject("WScript.Shell")
sh.Run "cmd /c ""<caminho>\ExpediAgent\start.cmd""", 0, False
```
(troque `<caminho>` pelo caminho real, ex.: `%LOCALAPPDATA%\ExpediAgent`). Roda sob a conta do
usuário logado — que tem o acesso Windows Auth ao SQL.

### Opção B — Serviço do Windows (com Administrador)
O projeto já chama `AddWindowsService`. Instale como serviço (ver seção acima, `sc create`),
porém rodando sob uma **conta COM acesso ao SQL** (não `LocalSystem`):
```bat
sc config ExpediAgent obj= ".\UsuarioDoPDV" password= "<senha>"
```
**OU** conceda à conta do serviço um **login de leitura** no SQL Server do Hiper. Sem uma dessas,
o `Trusted_Connection` falha na conexão.

## Instalador automático (Inno Setup) + heartbeat/versão
Em `agent/installer/` há `ExpediAgent.iss` (Inno Setup) + `start.cmd` que empacotam a publish
num **setup SEM admin**: instala em `%LOCALAPPDATA%\ExpediAgent` e configura o auto-start no
logon (via `.vbs` na Startup). No Windows, com Inno Setup 6+:
```bat
dotnet publish agent\ExpediAgent -c Release -o agent\installer\publish
:: abra agent\installer\ExpediAgent.iss no Inno Setup e compile -> gera ExpediAgentSetup.exe
:: ASSINE o ExpediAgentSetup.exe com o certificado de assinatura (signtool) antes de distribuir
```
O agente também faz **heartbeat** (fica "online" no painel da plataforma) e **checa a versão**
publicada em `/api/agent/version`, avisando no log se estiver desatualizado.

## Provisionamento (nuvem, operador)
No Supabase (SQL Editor), gere um token aleatório (ex.: `openssl rand -hex 24` com prefixo
`hpr_`), guarde o cru pro `appsettings.json` e insira só o SHA-256:
```sql
insert into public.dispositivos (empresa_id, nome, token_hash, ativo)
values ('<EMPRESA_UUID>', '<NOME_DA_LOJA>', '<SHA256_DO_TOKEN>', true);

insert into public.hiper_vendedor_map (empresa_id, hiper_usuario_id, hiper_usuario_nome, vendedor_id)
values ('<EMPRESA_UUID>', 1, 'Michel', '<UUID_DO_VENDEDOR>')
on conflict (empresa_id, hiper_usuario_id) do update set vendedor_id = excluded.vendedor_id;
```

## Detalhes de design
- **Carência de PDF:** se o pedido nasce no banco antes de ser impresso, o agente espera o
  PDF aparecer (até `PdfGraceMinutes`) antes de sincronizar — assim o pagamento (que só
  existe no PDF) é capturado. Passou da carência, sincroniza sem PDF (vendedor preenche).
- **Idempotência:** high-water mark local (`%ProgramData%\ExpediAgent\state.json`) +
  dedup no servidor (por `documento_erp`). Nunca duplica.
