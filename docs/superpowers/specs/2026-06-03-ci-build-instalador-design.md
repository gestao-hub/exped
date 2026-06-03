# CI que builda o ExpedSetup.exe — Design

> Data: 2026-06-03 · Projeto: Exped · Objetivo: produzir o instalador unificado (hub + agente) automaticamente, sem máquina de build local.

## 1. Problema

O `ExpedSetup.exe` (instalador unificado, `hub/win/exped-setup.iss`) é montado **à mão** hoje, exigindo
Node + .NET SDK + Go + Inno Setup numa máquina Windows. Nenhuma máquina do operador tem isso à mão (o
servidor da Franzoni nem Node tem). Toda mudança no app ou no agente exige refazer esse malabarismo —
não escala.

## 2. Objetivo

Um workflow de CI (GitHub Actions) que builda o `ExpedSetup.exe` inteiro e o disponibiliza pra download.
Você dá um `git tag vX.Y.Z` (ou clica "Run workflow") → baixa o instalador pronto. Reprodutível, sem
ferramenta local.

## 3. Decisões firmadas

- **Job único em `windows-latest`** (não split Linux+Windows). O `ISCC` só roda no Windows; o runner já
  tem Node/.NET e instala Go + Inno via `choco`. Sem passar artefatos entre jobs. (Split fica pra depois
  se o build ficar lento.)
- **Trigger:** tag `v*` **+** `workflow_dispatch` (botão manual). Entrega: **artefato** da execução (upload-artifact).
- **Sem assinatura de código** (SmartScreen alerta — aceito por enquanto; precisa de certificado pago).
- **Versão** vem de `package.json`/tag, carimbada no `.iss` e no `config.json` do payload.
- **Montagem do payload** vira um script Node reaproveitável (`scripts/montar-payload.mjs`), não bash manual.

## 4. O que o instalador precisa (inputs do `exped-setup.iss`)

Confirmado em `hub/win/exped-setup.iss` (`[Files]`), tudo relativo a `hub/win/`:
- `payload/app/*` — app Next standalone (server.js + node_modules + `.next/static` + `public`)
- `payload/hub/*` — `hub/*.mjs`
- `payload/scripts/local-stack/*` — SQL, `gateway.mjs`, `postgrest.conf`, `make-keys.sh`, `gotrue.env`
- `payload/supabase/migrations/*` — migrations do app
- `payload/bin/auth.exe` + `payload/bin/migrations/*` — GoTrue cross-compilado + migrations do auth
- `payload/scripts/local-stack/bin/{auth.exe,migrations}` — **mesma** cópia (é onde o maestro lê)
- `payload/config.json` — de `config.example.json` (com `version`/`manifestUrl` carimbados)
- `agent/installer/publish/*` — `dotnet publish` do agente (self-contained win-x64)
- `agent/installer/start.cmd`, `hub/win/{download-binaries,install-service,uninstall-service,provision}.ps1` — já no repo
- `payload/bin/nssm.exe` — **opcional** (`skipifsourcedoesntexist`); baixado no install se ausente.

**NÃO entram no build** (baixados no install via `download-binaries.ps1`): PostgreSQL, PostgREST, Node, NSSM.

## 5. Arquitetura — workflow `.github/workflows/build-installer.yml`

Um job, `runs-on: windows-latest`, `on: { push: { tags: ['v*'] }, workflow_dispatch: {} }`.

Passos:
1. `actions/checkout`.
2. `actions/setup-node@v4` (24) → `npm ci` → `npm run typecheck` → `npm run test` (gating) → `npm run build`.
3. `actions/setup-dotnet@v4` (8.0) → `dotnet publish agent/ExpedAgent -c Release -o agent/installer/publish`.
4. **auth.exe** (com cache): `actions/setup-go@v5`; `actions/cache@v4` chaveado por
   `hashFiles('hub/win/gotrue-windows.patch') + versão (v2.189.0)`; se cache miss: clona `supabase/auth`,
   `git checkout v2.189.0`, `git apply --ignore-whitespace hub/win/gotrue-windows.patch`,
   `go build -ldflags "-X .../Version=v2.189.0" -o auth.exe .`; guarda `auth.exe` + a pasta `migrations/` do gotrue no cache.
5. **Montar payload:** `node scripts/montar-payload.mjs --auth <path/auth.exe> --auth-migrations <path/migrations>`
   (o script faz as cópias da Fase 1.3 do README).
6. **Carimbar versão:** derivar `VER` de `package.json` (ou da tag); o `ISCC` recebe `/DMyAppVersion=$VER`.
   ⚠️ Pré-requisito: o `exped-setup.iss` tem `#define MyAppVersion "1.0.0"` fixo — trocar por
   `#ifndef MyAppVersion` + `#define MyAppVersion "1.0.0"` + `#endif`, senão o `/D` do CI não sobrescreve.
   o `config.json` do payload tem `version: $VER` (base do auto-update) e `manifestUrl` do bucket
   (já default no `config.example.json`).
7. **Inno Setup:** `choco install innosetup -y`; `& "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" /DMyAppVersion=$VER hub\win\exped-setup.iss`.
8. `actions/upload-artifact@v4` com `hub/win/Output/ExpedSetup.exe` (nome `ExpedSetup-$VER.exe`).

## 6. Componente novo: `scripts/montar-payload.mjs`

Script Node (ESM) que monta `hub/win/payload/` a partir do repo já buildado. Substitui o passo-a-passo
bash do README (Fase 1.3). Recebe os caminhos do `auth.exe` + migrations do gotrue por argumento (`--auth`,
`--auth-migrations`). Faz, com `fs.cpSync`:
- `.next/standalone/*` → `payload/app/`; `.next/static` → `payload/app/.next/static`; `public` → `payload/app/public` (se existir)
- `hub/*.mjs` → `payload/hub/`
- `scripts/local-stack/{*.sql,gateway.mjs,postgrest.conf,make-keys.sh,gotrue.env}` → `payload/scripts/local-stack/`
- `supabase/migrations/*` → `payload/supabase/migrations/`
- `auth.exe` + `migrations/` → `payload/bin/` **e** `payload/scripts/local-stack/bin/` (o maestro lê desta segunda)
- `config.example.json` → `payload/config.json` (com `version` carimbado)

A **lista pura origem→destino** (sem I/O) é exportada e testada com Vitest. O I/O real (`cpSync`) é
validado pelo próprio CI: se faltar algum `Source`, o `ISCC` falha.

## 7. Encaixe com o auto-update (sub-projeto anterior)

A **mesma tag `v*`** dispara dois workflows: `release-hub.yml` (publica a release no bucket público) e
`build-installer.yml` (gera o `.exe`). Resultado: uma tag produz **a release de auto-update E o instalador**,
ambos na versão da tag. O instalador nasce com `config.version` = tag, então o hub recém-instalado já está
na versão mais recente do feed — sem re-download imediato.

## 8. Erros / robustez

- **Gating:** typecheck + testes antes de buildar; build falho não gera artefato.
- **Cache do auth.exe:** evita recompilar GoTrue toda vez (~minutos); chave inclui o patch, então muda quando o patch muda.
- **`ISCC` falha cedo** se faltar qualquer `Source` (payload incompleto) → pega erro de montagem no CI.
- **Sem segredos no build:** o instalador não embute service_role; o `NEXT_PUBLIC_*` (públicos) entram no
  build do app via secrets do CI (mesmos do `release-hub`). O agente e o hub leem segredos em runtime.

## 9. Testes

- `scripts/montar-payload.mjs`: Vitest na função pura `planoDeCopias()` (lista de {origem, destino, tipo})
  — confere que cobre app/hub/local-stack/migrations/auth/config, sem tocar disco.
- **Workflow:** validado rodando 1× via `workflow_dispatch` e baixando o artefato `ExpedSetup-X.Y.Z.exe`.

## 10. Fora de escopo (anotado)

- Assinatura de código (Authenticode) — precisa de certificado; SmartScreen continua alertando.
- Variante offline (Postgres/PostgREST/Node/NSSM bundlados) — install baixa em runtime.
- Split Linux+Windows pra acelerar — só se o build único ficar lento.
- Anexar o `.exe` a um GitHub Release — começamos com artefato; dá pra adicionar depois.
