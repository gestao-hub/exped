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
cd /tmp/auth && git checkout v2.189.0          # commit 4fa66ba71d8c55b5c95cd5635766ed8bbae6d96a
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
> e comente o passo de `download-binaries.ps1` no `[Run]`.

---

## Fase 3 — Instalar  **[WIN]**

1. Rode `ExpedHubSetup.exe` **como Administrador** (clique direito → Executar como
   administrador). O SmartScreen vai alertar (instalador não assinado) → "Mais
   informações" → "Executar assim mesmo". Ver troubleshooting.
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

   `/status` interno: `http://127.0.0.1:3001/status` (porta = app+1) deve listar
   todas as peças com `running:true`.

---

## Fase 4 — Validar (checklist)  **[WIN] + outro PC da LAN**

1. **Acesso pela LAN:** de OUTRO PC na rede, abra `http://<ip-do-servidor>:3000/login`.
   (Descubra o IP com `ipconfig` no servidor.)
2. **Login:** entre com um usuário válido.
3. **Leitura:** veja o mapa / lista de OS carregar.
4. **PDF:** abra um PDF de uma OS (exercita o storage-local via gateway).
5. **Escrita:** faça uma alteração que grave no banco (ex.: atualizar uma OS) e
   confirme que persiste após refresh.
6. **Reboot:** reinicie a máquina servidor. Sem login manual, o serviço `ExpedHub`
   deve subir sozinho; repita os passos 1–3 e veja tudo no ar (`sc query ExpedHub`
   = RUNNING).
7. **Auto-update + rollback:** publique um **manifesto fake** apontando uma versão
   maior:
   ```json
   { "versao": "9.9.9", "url": "http://<host>/fake-release.zip", "sha256": "<hash do zip>" }
   ```
   Aponte `manifestUrl` no `config.json` pra ele e reinicie o serviço. O updater
   baixa, troca o ponteiro `current`, reinicia o app e roda o health-check em
   `/login`. Para ver o **rollback**: faça a release nova falhar o health (ex.: um
   `server.js` que sai com erro / porta errada) — o updater reverte o ponteiro pro
   release anterior, reinicia e o `/status`/logs registram `rolledBack:true`.
   Depois remova o `manifestUrl` (ou volte pra `null`) e reinicie.

---

## Desinstalar  **[WIN]**

Pelo "Adicionar/Remover programas" → "Exped Hub". O `[UninstallRun]` chama
`uninstall-service.ps1`, que para+remove o serviço e a regra de firewall.
**`C:\Exped\data` é PRESERVADO** (banco + storage). Pra zerar tudo, rode
manualmente como admin:

```powershell
powershell -ExecutionPolicy Bypass -File C:\Exped\hub\win\uninstall-service.ps1 -RemoveData $true
```

---

## Scripts deste diretório

| Arquivo | O que faz |
|---|---|
| `download-binaries.ps1` | Baixa PostgreSQL + PostgREST + Node + NSSM pra `C:\Exped\bin`. |
| `install-service.ps1` | Lê `config.json`, registra o serviço `ExpedHub` (NSSM) com as env `EXPED_*`, abre firewall, inicia. Idempotente. |
| `uninstall-service.ps1` | Para+remove o serviço e a regra de firewall. Preserva `data\` (a menos de `-RemoveData $true`). |
| `exped-hub.iss` | Script Inno Setup 6 — empacota `payload\` + scripts e orquestra `[Run]`/`[UninstallRun]`. |
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

- **Serviço não sobe** — `sc query ExpedHub` ≠ RUNNING: veja
  `C:\Exped\logs\service-err.log` e `maestro.log`. Causas comuns abaixo
  (Concerns Windows-only).

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
   de novo pra propagar.
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

Todos os bloqueios cross-platform conhecidos foram corrigidos (PRs #20/#21, 40 testes hub
verdes no Linux). O que resta é validação real no Windows (binários nativos + instalador).
