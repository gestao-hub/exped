# Hub local do Exped (Windows / offline)

Pilha Supabase **nativa** (Jeito A, sem Docker) + app Next standalone, orquestrada
por um processo único: o **maestro**.

## Peças

| Módulo | Papel |
|---|---|
| `config.mjs` | defaults + merge de overrides/env (`loadConfig`) |
| `supervisor.mjs` | `class Supervisor`: inicia/vigia/reinicia (backoff, `maxRestarts`) um filho |
| `health.mjs` | `waitForHttp` / `waitForTcp` (polling com deadline) |
| `bootstrap.mjs` | `bootstrap(cfg)` idempotente: cria DB, roles/ext, GoTrue migrate, helpers, migrations do app |
| `storage-local.mjs` | `startStorage`: substituto do Supabase Storage (bucket `pedidos-pdfs`) |
| `updater.mjs` | `isNewer` + `checkAndUpdate`: auto-update com validação sha256 e **rollback** |
| `maestro.mjs` | `startMaestro(cfg)`: orquestra tudo, expõe `/status`, roda o updater periódico |

## Maestro

Ordem de subida (cada passo com health gate):

1. **Postgres** (`pg_ctl start`) → `waitForTcp(:pg)`
2. **bootstrap(cfg)** (idempotente)
3. **PostgREST** / **GoTrue serve** / **storage-local** / **gateway** → `waitForHttp`/`waitForTcp`
4. **App Next standalone** (`.next/standalone/server.js`, `PORT=cfg.ports.app`, envs
   `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:<gateway>` + chaves anon/service geradas
   da `jwtSecret`) → `waitForHttp(/login)`
5. **Timer** periódico `checkAndUpdate` (só se `cfg.manifestUrl`)
6. **/status** (porta `cfg.ports.status` ou `app+1`): JSON com estado de cada peça

`SIGTERM`/`SIGINT`/`stop()` derrubam tudo na **ordem inversa**.

Rodar standalone: `node hub/maestro.mjs` (usa `loadConfig()` / envs `EXPED_*`).

### Opções de `startMaestro(cfg, opts)`
- `opts.reusePg = true`: assume um Postgres já de pé (não dá `start` nem `stop` nele) — usado no smoke.
- `opts.startApp = false`: sobe a infra sem o app Next.
- `opts.logger`: injeta logger (default: console + `<logDir>/maestro.log`).

## Auto-update (`updater.mjs`)

`checkAndUpdate(cfg, { getCurrentVersion, restart, health, logger }, deps?)`:

1. sem `cfg.manifestUrl` → `{updated:false, reason:'sem manifest'}`
2. GET manifesto `{ versao, url, sha256 }`
3. `!isNewer(versao, atual)` → `{updated:false}`
4. baixa `url` → `releases/<versao>.zip`, valida **sha256** (`node:crypto`); mismatch → `{updated:false, reason:'sha mismatch'}`
5. extrai → `releases/<versao>/`, aponta o ponteiro `current` (`cfg.paths.releasesPtr`
   ou `C:\Exped\current`) pra `<versao>`, `restart()`
6. `health()`; ok → `{updated:true, versao}`. Lançou → reverte o ponteiro pro anterior,
   `restart()` de novo → `{updated:false, rolledBack:true}`

I/O (fetch/download/sha/extract/ponteiro) é injetável via `deps` — a lógica (incl.
rollback) é testada sem rede em `hub/test/updater.test.mjs`.

## Smoke test do maestro (2026-05-31, Linux)

Rodado reaproveitando o **Postgres do spike** (`:54329`, `reusePg:true`) com portas e DB
**alternativos** (app 3010, status 3011, gateway 54340, postgrest 54341, gotrue 9991,
storage 5412, DB `exped_maestro_smoke`) para **não tocar** no stack do spike.

**Provado** (com `--app`):
- Postgres reaproveitado + `bootstrap` criou `exped_maestro_smoke` do zero (empresas, `auth.users`)
- PostgREST :54341 → 200, GoTrue :9991 `/health` → 200, storage :5412 up,
  gateway :54340 `/auth/v1/health` → 200
- **App Next standalone** :3010 subiu e `/login` respondeu **200**
- `/status` :3011 reportou as 4 peças (`running:true`, `restarts:0`) + storage
- `stop()` derrubou tudo na ordem inversa; **stack do spike intacto** (3000/54320/...),
  DB de smoke dropado, sem processos órfãos

Sem concerns ambientais: o app standalone subiu normalmente neste ambiente.
