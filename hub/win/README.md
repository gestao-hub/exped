# Exped Hub — Runbook Windows (instalador + serviço)

Este diretório empacota o **hub local do Exped** para Windows: a pilha Supabase
nativa (sem Docker) — **PostgreSQL + PostgREST + GoTrue** — mais o **app Next**
(build standalone), orquestrados pelo `hub/maestro.mjs` e rodando como **serviço
Windows auto-start** (`ExpedHub`). O alvo é uma máquina Windows na LAN do cliente,
servindo o app pra outros PCs em `http://<ip>:3000`.

> **Você (operador) faz duas coisas:** (1) **pré-build no Linux/CI** — gera o app
> standalone e monta a pasta `payload\`; (2) **no Windows** — compila o instalador
> com Inno Setup e roda o `ExpedHubSetup.exe`. Os passos que **só rodam no Windows**
> estão marcados com **[WIN]**.

---

## Onboarding por Código de Instalação (instalador unificado `exped-setup.iss`)

Há **dois instaladores** neste diretório:

| Instalador | O que entrega | Configuração da nuvem |
|---|---|---|
| `exped-hub.iss` → `ExpedHubSetup.exe` | **Só o hub** (serviço `ExpedHub`). | Manual (editar `config.json`). |
| `exped-setup.iss` → `ExpedSetup.exe` | **Hub + agente** num único `.exe`, com **wizard do código**. | **Automática por código** (recomendado). |

### Fluxo recomendado (por código)

1. **[Operador, no painel]** Abra a plataforma, selecione a empresa do cliente e clique
   em **"Gerar código de instalação"**. O painel mostra um código no formato
   `EXPED-XXXX-XXXX` (uso único, expira em **24h**). Copie e envie ao cliente.
2. **[Cliente, no Windows]** Abra `ExpedSetup.exe` com **duplo clique** e aceite o
   UAC. **Não use "Executar como administrador"**: em suporte com credenciais
   administrativas de outra pessoa, o Setup precisa preservar o token do usuário
   que iniciou o instalador. No wizard, cole o código e clique em Avançar.
3. Ainda em `PrepareToInstall`, antes de parar o Hub, copiar payload, baixar binários
   ou resgatar o código, um helper autocontido executado como usuário original prova
   que seu SID é o mesmo do Explorer da sessão e valida a transição contra os
   metadados persistidos. Setup iniciado já elevado ou sem token original é recusado.
   Depois desse preflight, o instalador tira snapshot do config, para o Hub com
   restauração em caso de falha, copia o staging e roda **`provision.ps1`** com
   `-DeferAgent`. O helper original-user repete a defesa antes de qualquer efeito no
   perfil. Só então ele instala em
   `%LOCALAPPDATA%\ExpedAgent` e cria o `.vbs` desse usuário. Um recibo nonce-bound entrega ao passo elevado somente
   o SID e o caminho exato do `appsettings.json`; então o serviço e a URL ACL são
   configurados, e o agente é iniciado novamente como o usuário original.

   Uma reinstalação que tente trocar `agent.userSid` ou `agent.settingsPath` é
   recusada com instrução para desinstalar/migrar explicitamente. No legado que tem
   o caminho exato mas ainda não tem `userSid`, o owner SID do arquivo precisa
   coincidir com o usuário original; a validação é repetida no passo elevado.

   O resgate chama `POST /api/provision/redeem` (que **gera o token de dispositivo
   só no resgate**) e mantém os **2 configs** coerentes:
   - `C:\Exped\config.json` → injeta `cloud.apiBase` + `cloud.deviceToken`
     (preservando `jwtSecret`/portas já gerados);
   - `%LOCALAPPDATA%\ExpedAgent\appsettings.json` → `Agent.ApiBaseUrl =
     http://127.0.0.1:3000` (o agente fala com o **hub local**) + `Agent.DeviceToken`;
   - `C:\Exped\config.json` → `agent.settingsPath` + `agent.userSid` exatos,
     além do estado da URL ACL, para reruns elevados nunca escolherem outro perfil.

   **Não é mais preciso editar JSON à mão** — a tela do código substitui esse passo.

### Modo manual (fallback de suporte)

No mesmo wizard há um checkbox **"Modo manual (suporte)"**. Marcado, ele esconde o
campo do código e revela **Token de dispositivo** + **URL da nuvem**. Use quando a
máquina do cliente **não tem internet pra resgatar** o código, ou pra recuperar uma
instalação. O Setup grava URL+token num arquivo temporário com ACL somente para
SYSTEM/Administradores, passa apenas o caminho por `-CredentialsFile` e o apaga em
`finally`; o token não entra na linha de comando nem no log. Em modo silencioso use
`/credentialsfile=<arquivo>` com URL na linha 1 e token na linha 2; o arquivo de
entrada também deve ser efêmero. O CLI direto de `provision.ps1 -DeviceToken` segue
compatível apenas para suporte legado.

Em uma máquina já instalada, o comando usado pelo suporte continua válido sem
`-AgentDir`:

```powershell
powershell -ExecutionPolicy Bypass -File C:\Exped\hub\win\provision.ps1 `
  -Code EXPED-XXXX-XXXX -CloudApi https://app-exped.vercel.app
```

Ele resolve exclusivamente `agent.settingsPath` persistido e o `agent.userSid`; em
config legado sem SID, deriva e persiste o owner SID exato do arquivo após validar a
conta/perfil. Ausência de caminho ou owner incoerente falha **antes de consumir o
código**. As duas escritas são transacionais: se a segunda falhar, Hub e agente voltam
aos bytes anteriores; nunca atualiza só o Hub.

### Pré-requisito extra do `exped-setup.iss`: publish do agente

Além do `payload\` do hub (Fase 1.3 abaixo), o instalador unificado empacota o
**publish self-contained do agente**. Gere-o **antes de compilar** (a partir de
`agent\installer\`):

```bash
dotnet publish ..\ExpedAgent -c Release -o publish   # cria agent\installer\publish\
```

O `exped-setup.iss` referencia `..\..\agent\installer\publish\*` e
`..\..\agent\installer\start.cmd` por caminho **relativo a `hub\win\`**. Sem esse
publish a compilação do `ExpedSetup.exe` falha (Source inexistente). Compile com:

```bat
"C:\Program Files (x86)\Inno Setup 6\ISCC.exe" hub\win\exped-setup.iss
```

---

## Convenção de pastas no Windows

Tudo vive sob `C:\Exped\`:

```
C:\Exped\
  app\                      app Next standalone (server.js + node_modules + .next\static + public)
  hub\                      maestro.mjs, supervisor.mjs, health.mjs, storage-local.mjs,
                            bootstrap.mjs, config.mjs, updater.mjs, win\ (scripts deste dir)
  scripts\local-stack\      *.sql, gateway.mjs, postgrest.conf, make-keys.sh
    bin\                    postgrest.exe, auth.exe, migrations\   <- onde o maestro LE (ver Aviso)
  bin\                      node.exe, node\, nssm.exe, pgsql\ (PostgreSQL)
  data\                     cluster Postgres + storage (DADOS DO CLIENTE — preservado em uninstall)
  logs\                     logs do serviço + do maestro + por-peça
  releases\                 releases baixadas pelo auto-update
  config.json               config do hub (jwtSecret gerado no install)
```

> ### ⚠️ Aviso importante — onde o maestro procura os binários
> O `hub/maestro.mjs` (camada Node, provada no Linux) referencia os binários por
> caminhos **fixos relativos a `scripts\local-stack\bin\`**:
> `scripts\local-stack\bin\postgrest`, `scripts\local-stack\bin\auth` e
> `scripts\local-stack\bin\migrations`. **Não** lê de `C:\Exped\bin\`.
> Por isso o payload coloca `auth.exe` + `migrations\` em
> `scripts\local-stack\bin\`, e o `download-binaries.ps1` deixa o `postgrest.exe` lá.
> O maestro resolve `.exe` sozinho (helper `exe()`), então **não** é preciso cópia sem
> extensão. Veja **Notas de portabilidade** no fim (os antigos bloqueios já foram corrigidos).

---

## Versões dos binários

| Componente | Versão | Origem | Validação (2026-05-31, Linux) |
|---|---|---|---|
| PostgreSQL | 16.9-1 | zip oficial EDB win-x64 | HTTP 200 |
| PostgREST | v14.12 | release GitHub (`windows-x86-64`) | HTTP 200 |
| GoTrue (`auth.exe`) | v2.189.0 (`4fa66ba…`) | cross-compilado de `supabase/auth` | binário PE (`file`) |
| Node.js | v20.18.0 LTS | zip oficial `nodejs.org` win-x64 | HTTP 200 |
| NSSM | 2.24 | `nssm.cc` | HTTP 206 (ver troubleshooting) |

URLs (todas em `download-binaries.ps1`):

- PostgreSQL: `https://get.enterprisedb.com/postgresql/postgresql-16.9-1-windows-x64-binaries.zip`
- PostgREST: `https://github.com/PostgREST/postgrest/releases/download/v14.12/postgrest-v14.12-windows-x86-64.zip`
- Node: `https://nodejs.org/dist/v20.18.0/node-v20.18.0-win-x64.zip`
  (SHA-256 `f5cea43414cc33024bbe5867f208d1c9c915d6a38e92abeee07ed9e563662297`, conferido no install)
- NSSM: `https://nssm.cc/release/nssm-2.24.zip`

---

## Fase 1 — Pré-build (no Linux/CI)

### 1.1 Build do app (standalone)

```bash
npm ci
npm run build          # next.config tem output:'standalone' -> gera .next/standalone/server.js
```

### 1.2 Reproduzir o `auth.exe` (GoTrue win-x64)

O upstream `supabase/auth` não compila pra Windows sem patch (usa `SO_REUSEPORT`
via `golang.org/x/sys/unix`). Aplicamos `hub/win/gotrue-windows.patch` sobre o tag
`v2.189.0` e cross-compilamos:

```bash
git clone https://github.com/supabase/auth /tmp/auth
cd /tmp/auth && git checkout v2.189.0          # use o commit fixado no workflow
# --ignore-whitespace: o patch falha por diferenca de line-endings (CRLF) quando
# aplicado no Windows; este flag torna o apply tolerante a isso. O .gitattributes
# do repo ja forca LF no .patch, mas mantenha o flag por seguranca.
git apply --ignore-whitespace /caminho/para/franzoni/hub/win/gotrue-windows.patch
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build \
  -ldflags "-X github.com/supabase/auth/internal/utilities.Version=v2.189.0" \
  -o auth.exe .
file auth.exe          # -> PE32+ executable ... for MS Windows   (prova do cross-compile)
```

### 1.3 Montar a pasta `payload\` (em `hub\win\payload\`)

O instalador empacota a partir de `hub\win\payload\`. Monte assim (a partir da
raiz do repo); use `cp`/`rsync` no Linux:

```bash
cd hub/win
rm -rf payload && mkdir -p payload

# (a) App Next standalone -> payload/app
#     O standalone NÃO inclui .next/static nem public — copie-os por cima.
cp -r ../../.next/standalone/*           payload/app/
mkdir -p payload/app/.next
cp -r ../../.next/static                 payload/app/.next/static
cp -r ../../public                       payload/app/public        # se existir

# (b) Hub Node -> payload/hub  (sem o próprio win/, que o .iss já copia separado)
mkdir -p payload/hub
cp ../../hub/*.mjs                        payload/hub/

# (c) Local-stack: SQL + gateway + scripts -> payload/scripts/local-stack
mkdir -p payload/scripts/local-stack/bin
cp ../../scripts/local-stack/*.sql       payload/scripts/local-stack/
cp ../../scripts/local-stack/gateway.mjs payload/scripts/local-stack/
cp ../../scripts/local-stack/postgrest.conf payload/scripts/local-stack/
cp ../../scripts/local-stack/make-keys.sh    payload/scripts/local-stack/
# gotrue.env é OBRIGATÓRIO: hub/bootstrap.mjs lê scripts/local-stack/gotrue.env
# para rodar o `auth migrate` (cria auth.users). Sem ele o bootstrap falha.
cp ../../scripts/local-stack/gotrue.env  payload/scripts/local-stack/

# (c.2) Migrations do APP -> payload/supabase/migrations
#     hub/config.mjs migrationsDir = supabase/migrations (relativo a C:\Exped).
#     O bootstrap aplica esses *.sql no 1º start; SEM eles o schema do app não sobe.
mkdir -p payload/supabase/migrations
cp ../../supabase/migrations/*.sql       payload/supabase/migrations/

# (d) GoTrue: auth.exe + migrations  -> payload/scripts/local-stack/bin
#     (é AQUI que o maestro procura — ver Aviso acima)
cp /tmp/auth/auth.exe                    payload/scripts/local-stack/bin/auth.exe
cp -r /tmp/auth/migrations               payload/scripts/local-stack/bin/migrations
# O .iss também aceita auth.exe em payload/bin/ — mantenha as duas cópias se
# preferir, mas a que o maestro USA é a de scripts/local-stack/bin.

# (e) config.json default (jwtSecret é trocado no install)
cp config.example.json                   payload/config.json
```

> **Nota sobre o `auth.exe` no payload do `.iss`:** o `exped-hub.iss` copia
> `payload\bin\auth.exe` e `payload\bin\migrations\` para `C:\Exped\bin\`. Como o
> maestro lê de `scripts\local-stack\bin\`, garanta que o `auth.exe`+`migrations\`
> estejam **também** em `payload\scripts\local-stack\bin\` (passo **d**). Os SQL,
> `gateway.mjs`, `postgrest.conf` e `make-keys.sh` entram via `payload\scripts\`.

---

## Fase 1.5 — Smoke direto, SEM instalador (recomendado fazer primeiro)  **[WIN]**

Antes de empacotar, prove que o stack inteiro sobe no Windows rodando o maestro à mão.
Pré-requisitos (tudo na máquina Windows, dentro do repo clonado):
- `npm ci && npm run build` (gera `.next/standalone`).
- Binários baixados: `powershell -ExecutionPolicy Bypass -File hub\win\download-binaries.ps1`
  (Postgres em `C:\Exped\bin\pgsql`, `postgrest.exe`+`node`+`nssm` baixados).
- `auth.exe` (GoTrue) + `migrations\` gerados (Fase 1.2) e copiados pra `scripts\local-stack\bin\`.
  Também copie/garanta `postgrest.exe` em `scripts\local-stack\bin\` (é onde o maestro lê).
- **Node disponível** (use `C:\Exped\bin\node\node.exe` ou um Node instalado).

Rodar (PowerShell, no repo):
```powershell
# segredo obrigatório (>=32 chars). Gere um aleatório:
$env:EXPED_JWT_SECRET = -join ((48..57)+(97..102) | Get-Random -Count 48 | % {[char]$_})
# onde estão initdb.exe/pg_ctl.exe/psql.exe:
$env:EXPED_PG_BIN = "C:\Exped\bin\pgsql\bin"
# (confira em hub/config.mjs / hub/maestro.mjs se há outras envs EXPED_* de path no seu layout)
node hub\maestro.mjs
```
Validar (outro terminal):
```powershell
curl http://127.0.0.1:3001/status     # lista as peças com running:true
curl http://127.0.0.1:3000/login      # 200 (app no ar)
```
Se subir tudo, o Jeito A está provado no Windows e seguimos pro instalador. Se travar,
me mande o `maestro.log` / a saída do terminal — eu corrijo. **Dica pro Claude do Windows:**
leia `hub/config.mjs` (envs `EXPED_*`) e `hub/maestro.mjs` (ordem de boot + caminhos) pra
ajustar paths do seu layout antes de rodar.

---

## Fase 2 — Compilar o instalador  **[WIN]**

1. Instale o **Inno Setup 6** (https://jrsoftware.org/isdl.php).
2. Copie a pasta `hub\win\` (com `payload\` montado) pra máquina Windows.
3. Compile:

   ```bat
   "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" hub\win\exped-hub.iss
   ```

   Gera `hub\win\Output\ExpedHubSetup.exe`.

> **Variante offline (sem download no install):** copie Postgres/PostgREST/Node/NSSM
> pra `payload\bin\`, descomente o bloco "OFFLINE OPCIONAL" do `[Files]` no `.iss`
> e remova a chamada conferida de `download-binaries.ps1` em `CurStepChanged`.

---

## Fase 3 — Instalar  **[WIN]**

1. Para Hub + Agent, abra `ExpedSetup.exe` com **duplo clique** e aceite o UAC.
   Não use "Executar como administrador": o instalador precisa preservar e provar
   o usuário interativo que possui a `Trusted_Connection` do Hiper. Use
   `ExpedHubSetup.exe` elevado somente no pacote **hub-only**, no qual o Agent fica
   explicitamente desativado. O SmartScreen vai alertar porque o instalador ainda
   não é assinado; veja troubleshooting.
2. O install: copia tudo pra `C:\Exped`, gera o `jwtSecret` real no `config.json`,
   roda `download-binaries.ps1` (baixa Postgres/PostgREST/Node/NSSM), depois
   `install-service.ps1` (registra+inicia o serviço `ExpedHub` e abre o firewall
   pras portas 3000 e 54320).
3. Confirme:

   ```bat
   sc query ExpedHub
   ```
   Deve mostrar `STATE : 4 RUNNING`.

   Logs em `C:\Exped\logs\` (`service-out.log`, `service-err.log`, `maestro.log`,
   e `postgres.log`/`postgrest.log`/`gotrue.log`/`gateway.log`/`app.log`).

   `/status` interno: `http://127.0.0.1:3001/status` (porta = app+1). No pacote
   unificado, depois do login operacional, ele deve comprovar separadamente Hub,
   Agent, endpoint `Sincronizar`, consulta read-only e contrato de schema Exped Agent v1,
   além do sync cloud sem erro. No pacote hub-only, `agent.startupMode=disabled` é
   o estado esperado.

---

## Fase 4 — Validar (checklist)  **[WIN] + outro PC da LAN**

1. **Acesso pela LAN:** de OUTRO PC na rede, abra `https://<ip-do-servidor>/login`
   (ou a porta HTTPS fallback registrada no log). Descubra o IP com `ipconfig`.
2. **Login:** entre com um usuário válido.
3. **Leitura:** veja o mapa / lista de OS carregar.
4. **PDF:** abra um PDF de uma OS (exercita o storage-local via gateway).
5. **Escrita:** faça uma alteração que grave no banco (ex.: atualizar uma OS) e
   confirme que persiste após refresh.
6. **Reboot controlado:** mantenha qualquer tarefa diária das 03:00 **pausada**.
   Instale primeiro os hooks do canário em PowerShell elevado:
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File C:\Exped\hub\win\windows-canary.ps1 -Mode InstallHooks
   ```
   Reinicie manualmente. Antes do login, o receipt `PreLogin` deve comprovar que o
   Hub e o sync cloud voltaram, enquanto o Agent permanece corretamente
   `running:false`. Isso não é falha: a `Trusted_Connection` não possui token do
   usuário antes do login.
7. **Pós-login + Hiper 197:** entre na conta operacional. O hook `PostLogin` deve
   comprovar heartbeat fresco do Agent, conexão, consulta read-only real e schema
   compatível com o contrato de schema do Exped Agent. Depois valide o botão na tela correta:
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File C:\Exped\hub\win\windows-canary.ps1 -Mode SyncButton
   ```
   O receipt só é aceito quando `agent.lastSyncNowAt` avança, o Agent publica
   `lastSyncNowOk=true` e há um ciclo cloud posterior. O heartbeat periódico não
   satisfaz essa prova sozinho.
8. **Rollback:** use somente um manifesto HTTPS de canário criado pelo fluxo de
   release aprovado; manifesto HTTP/fake não é aceito. O teste é destrutivo e exige
   confirmação explícita:
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File C:\Exped\hub\win\windows-canary.ps1 -Mode Rollback -RollbackManifestUrl "https://..." -ConfirmRollback
   ```
9. **Decisão das 03:00:** confira os receipts com `-Mode Report`. Reative a tarefa
   diária somente depois de `PreLogin`, `PostLogin`, `SyncButton` e rollback passarem
   no Windows físico. O canário registra a atualização Hiper 195→197 como contexto,
   não como causa sem evidência. Ao concluir, remova apenas os hooks com
   `-Mode Cleanup`; os receipts ficam preservados.

---

## Desinstalar  **[WIN]**

Pelo "Adicionar/Remover programas" → "Exped Hub". `CurUninstallStepChanged` chama
`uninstall-service.ps1` e confere o exit code antes de permitir que o Inno apague
arquivos. Como o Inno não oferece `runasoriginaluser` durante
uninstall, o script elevado cria uma tarefa one-shot com o token interativo do
`agent.userSid` exato; ela roda `agent-user-install.ps1 -Uninstall`, para somente
o processo do executável exato e remove o `.vbs` de Startup + diretório do agente
naquele perfil. Depois o passo elevado remove serviço, firewall e a URL ACL apenas
se o SDDL atual ainda for exatamente o rastreado.

O SID original precisa estar com uma sessão Explorer ativa. Se outro usuário tentar
desinstalar enquanto ele está desconectado, o cleanup do perfil recusa adivinhar,
retorna `2` **antes** de remover serviço, URL ACL ou firewall, e o Inno preserva os
arquivos. Entre no usuário indicado e rode a desinstalação novamente. O pacote
hub-only sempre chama `-ManageAgent false`; somente o unificado usa `true`, portanto
um pacote nunca instala/remove o agente pertencente ao outro.
**`C:\Exped\data` é PRESERVADO** (banco + storage). Pra zerar tudo, rode
manualmente como admin:

```powershell
powershell -ExecutionPolicy Bypass -File C:\Exped\hub\win\uninstall-service.ps1 `
  -ManageAgent true -RemoveData $true
```

---

## Scripts deste diretório

| Arquivo | O que faz |
|---|---|
| `download-binaries.ps1` | Baixa PostgreSQL + PostgREST + Node + NSSM pra `C:\Exped\bin`. |
| `install-service.ps1` | Registra `ExpedHub`, abre firewall e inicia. Só propaga porta/URL ACL/receipt com `-ManageAgent true`; o default `false` isola o hub-only. |
| `uninstall-service.ps1` | Remove serviço/firewall; com `-ManageAgent true`, exige antes o cleanup completo no SID original e remove URL ACL exata. |
| `agent-user-install.ps1` | Preflight, install/start/uninstall e rollback/finalize transacionais somente no perfil/SID interativo comprovado. |
| `agent-settings.ps1` | Contrato PowerShell de porta, owner SID e escrita JSON atômica. |
| `agent-sync-contract.mjs` | Contrato puro/testável das transições default/custom/`0` da URL ACL e da identidade/caminho dos recibos. |
| `installer-orchestrator.ps1` | Helper autocontido de preflight, snapshot/restore, rollback de URL ACL, ACL do segredo e estado do serviço antes de `[Files]`. |
| `exped-hub.iss` | Script Inno Setup 6 — empacota `payload\` + scripts e orquestra install/uninstall conferidos em `[Code]`. (Só o hub.) |
| `exped-setup.iss` | Script Inno Setup 6 **unificado** (hub + agente) com wizard do **código de instalação** (e modo manual de suporte). Gera `ExpedSetup.exe`. |
| `provision.ps1` | Resgata o código (`POST /api/provision/redeem`) ou aplica Token+URL por arquivo protegido e escreve transacionalmente `config.json` + `appsettings.json`. Chamado pela orquestração `[Code]` do `exped-setup.iss`. |
| `config.example.json` | Modelo do `config.json` (portas, paths Windows, jwtSecret placeholder, manifestUrl). |
| `gotrue-windows.patch` | Patch de portabilidade Windows do `supabase/auth` (reproduz o `auth.exe`). |

---

## Troubleshooting

- **Antivírus / SmartScreen barrando os `.exe`** — `auth.exe`, `postgrest.exe`,
  `nssm.exe` e o próprio `ExpedHubSetup.exe` **não são assinados**, então o
  SmartScreen ("Windows protegeu o seu PC") e alguns antivírus podem bloquear.
  Use "Mais informações → Executar assim mesmo", ou adicione uma exceção pra
  `C:\Exped`. **Solução definitiva:** assinatura de código (Authenticode) com um
  certificado de code-signing (`signtool sign /fd SHA256 /tr <timestamp> ...`) no
  instalador e nos `.exe` — recomendado antes de distribuir pra clientes.

- **NSSM 503 ao baixar** — `nssm.cc` responde **503 a HEAD** (anti-bot) mas serve o
  **GET** normalmente (validado: `curl -r 0-0` → HTTP 206). O `Invoke-WebRequest`
  usa GET, então funciona. Se mesmo assim cair, use um mirror (ex.: o pacote do
  Chocolatey `nssm`) ou pré-bundle o `nssm.exe` no `payload\bin\`.

- **Porta ocupada** — se 3000 ou 54320 já estiverem em uso, o maestro falha ao
  subir o app/gateway. Cheque `netstat -ano | findstr ":3000"` e ajuste as portas
  no `config.json` (o `install-service.ps1` reflete no firewall e nas env do
  serviço; reinstale o serviço rodando o script de novo).

- **Porta do botão Sincronizar** — ajuste `agent.syncNowPort` no `config.json`
  (`5005` por padrão, outra porta para customizar, `0` para desativar) e rode
  `install-service.ps1 -ManageAgent true` de novo. O script atualiza o Hub e troca atomicamente
  `Agent.SyncNowPort` no agente indicado por `agent.settingsPath`; o processo do
  agente recarrega e reabre o listener sem ser reiniciado pela conta elevada. A
  URL ACL é adicionada/movida/removida com SDDL do `agent.userSid`; um SDDL diferente
  na mesma porta é conflito, nunca considerado saudável nem removido como se fosse
  do Exped. Se uma troca de SID na mesma porta falhar depois do delete, o instalador
  restaura e verifica o SDDL anterior. No primeiro rerun de uma instalação sem os
  campos de tracking, a porta anterior é lida do `appsettings.json` exato para que
  custom/`0` também movam ou removam a reserva antiga. Instalação legada com
  `settingsPath` exato mas sem `userSid` migra pelo
  owner SID do ACL do arquivo. Se isso não representar o usuário pretendido, rode
  com `-AgentUserSid S-1-...`; não há descoberta por nome ou varredura de perfis.

- **Serviço não sobe** — `sc query ExpedHub` ≠ RUNNING: veja
  `C:\Exped\logs\service-err.log` e `maestro.log`. Causas comuns abaixo
  (Concerns Windows-only).

- **Hub sobe, mas Agent/Hiper não** — confira `agent.running`,
  `agent.syncNowReady`, `agent.hiper.connected`, `agent.hiper.queryOk` e
  `agent.hiper.schemaCompatible` em `/status`. Após reboot, `agent.running=false`
  antes do login é o comportamento verdadeiro do modo `interactive_logon`; não
  converta o Agent em serviço Windows, pois isso troca a identidade usada pela
  `Trusted_Connection`.

---

## Notas de portabilidade (Windows)

1. **Extensão `.exe` — RESOLVIDO.** O maestro usa o helper `exe()` (`hub/platform.mjs`)
   que anexa `.exe` automaticamente quando `process.platform === 'win32'` em TODOS os
   spawns de binário (`pg_ctl`, `postgrest`, `auth`). Nenhuma cópia sem extensão é necessária.
2. **Geração de chaves — RESOLVIDO.** O maestro gera as chaves anon/service_role via
   `node:crypto` (`hub/keys.mjs`, `makeKeys()`), sem `bash`/`python3`. Windows limpo basta.
   (O `make-keys.sh` antigo continua no repo mas o maestro NÃO o usa.)
3. **Segredo obrigatório.** O hub **não sobe** sem `EXPED_JWT_SECRET` (>=32 chars, ≠ placeholder).
   O `.iss` gera um aleatório no `config.json` e o `install-service.ps1` o injeta como
   `EXPED_JWT_SECRET`. **Para rodar o maestro à mão** (smoke direto, sem instalador),
   **defina você mesmo** essa env (ver Fase 0).
4. **Storage exige token.** O `storage-local` agora rejeita request sem JWT válido (401).
   O app envia o token (o gateway repassa os headers), então é transparente — só não tente
   abrir o PDF por URL crua sem o header de auth.
5. **`config.json` não é lido pelo maestro** — o `install-service.ps1` traduz `config.json`
   → env `EXPED_*` do serviço. Se editar o `config.json` depois, rode o `install-service.ps1`
   de novo pra propagar. Para `agent.syncNowPort`, esse mesmo fluxo também atualiza o
   `appsettings.json` instalado; o agente observa a mudança sem restart. O maestro
   deriva `AGENT_SYNC_URL` somente dessa porta canônica (inclusive `0`), ignorando
   valor herdado; a variável continua exclusiva do Hub local e não é injetada na Vercel.
6. **`initdb` automático no maestro — RESOLVIDO.** O maestro inicializa o cluster Postgres
   sozinho: antes do `pg_ctl start`, se `cfg.paths.pgData` ainda não é um cluster válido
   (sem o arquivo `PG_VERSION`), ele roda `initdb -D <pgData> -U <user> -E UTF8`. Idempotente
   (cluster já inicializado = pula). Cobre instalador (data dir vazio no 1º boot), smoke e
   Linux — não há mais passo manual de `initdb` no instalador.
7. **PATH do serviço.** O `install-service.ps1` injeta `PATH` no serviço com
   `C:\Exped\bin\pgsql\bin` e `C:\Exped\bin\node` ANTES do PATH herdado, pra que o maestro
   ache `psql`/`pg_ctl`/`initdb` (chamados no bootstrap) num ambiente de serviço minimo.
8. **Entrypoint do app resolvido.** O maestro testa `app\server.js` (layout do instalador) e
   depois `.next\standalone\server.js` (dev), usando o primeiro que existir — não precisa mais
   do junction que foi usado como workaround.

Os contratos cross-platform são validados no CI, inclusive PowerShell 5.1 e testes
do Agent em .NET. Ainda é obrigatória a validação física no Windows para Inno Setup,
ACL/firewall/NSSM, identidade `Trusted_Connection`, reboot pré/pós-login e rollback.
