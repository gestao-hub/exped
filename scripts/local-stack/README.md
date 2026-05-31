# Pilha Supabase LOCAL nativa — "Jeito A" (sem Docker)

Exped rodando contra um Supabase **local nativo** (binários, sem Docker): Postgres +
PostgREST + GoTrue, unidos por um gateway de 1 URL. O app não muda — aponta o
`NEXT_PUBLIC_SUPABASE_URL` pro gateway e funciona.

## Como usar

```bash
# Sobe a pilha inteira (idempotente — no-op se já estiver de pé)
bash scripts/local-stack/up.sh

# Recria o schema do banco do app do zero (DROP + CREATE + migrations)
bash scripts/local-stack/up.sh --reset

# Derruba gateway + GoTrue + PostgREST (mantém o Postgres e os dados)
bash scripts/local-stack/down.sh

# Derruba tudo, incluindo o Postgres, e APAGA o data dir /tmp/exped-pg
bash scripts/local-stack/down.sh --wipe
```

### Gerar o `.env.local`

O `up.sh` imprime no fim o bloco pronto pra colar (URL do gateway + chaves anon e
service_role). As chaves também saem isoladas por:

```bash
bash scripts/local-stack/make-keys.sh        # ANON_KEY + SERVICE_ROLE_KEY
bash scripts/local-stack/make-keys.sh anon   # só a anon
```

`.env.local` mínimo:

```
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54320
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon do make-keys.sh>
SUPABASE_SERVICE_ROLE_KEY=<service do make-keys.sh>
```

### Portas

| Peça      | Porta | O quê                                             |
|-----------|-------|---------------------------------------------------|
| Postgres  | 54329 | Banco nativo, data dir `/tmp/exped-pg`            |
| PostgREST | 54331 | API REST (`/rest/v1` no gateway)                  |
| GoTrue    | 9999  | Auth (`/auth/v1` no gateway)                      |
| Gateway   | 54320 | **URL única** que o app usa (1 origem p/ tudo)    |

Logs: `/tmp/exped-postgres.log`, `/tmp/postgrest.log`, `/tmp/gotrue.log`, `/tmp/gateway.log`.

JWT secret fixa do spike: `exped-local-super-secret-jwt-with-at-least-32-chars`
(sobrescrevível por `GOTRUE_JWT_SECRET`). Portas/host/db também aceitam env
(`PGPORT`, `PGHOST`, `PGUSER`, `PGDB`, `REST_PORT`, `AUTH_PORT`, `GATEWAY_PORT`).

### Ordem de bootstrap do banco (em `apply-schema.sh`)

1. recria o DB `exped`
2. `00-roles-ext.sql` — extensões + roles + `supabase_auth_admin` + schema `auth` vazio
3. GoTrue `auth migrate` — cria `auth.users` e demais tabelas do auth
4. `00-prelude-helpers.sql` — helpers `auth.uid()/role()/jwt()` + grants + storage shim + realtime
5. `supabase/migrations/*.sql` — schema do app + RLS

Após recriar o DB, o cache do PostgREST é recarregado com `kill -USR1 <pid>` (o
`up.sh --reset` faz isso automaticamente).

---

## Resultado do spike (Jeito A)

- [x] **App é 100% endpoint-driven** (sem hardcode — só troca a URL/chaves no `.env.local`)
- [x] **Migrations aplicam limpas** em Postgres nativo, com um prelúdio de ~6 itens:
  1. extensões (`pgcrypto`, `uuid-ossp`, etc.)
  2. roles base (`anon`, `authenticated`, `service_role`, `authenticator`)
  3. role `supabase_auth_admin` + schema `auth` vazio (pré-GoTrue)
  4. tabelas do `auth` criadas pelo GoTrue `auth migrate`
  5. helpers `auth.uid()` / `auth.role()` / `auth.jwt()` + grants
  6. shim de `storage` + canal de `realtime`
- [x] **RLS funciona local** (anon nega / JWT autenticado vê)
- [x] **GoTrue nativo**: signup/login + JWT aceito pelo PostgREST + trigger `handle_new_user`
- [x] **Gateway 1-URL** + e2e via supabase-js (login + leitura + escrita) + `next dev` servindo `/login` 200

### Peças nativas validadas (todas binário nativo, SEM Docker)

- **Postgres 16** (16.14)
- **PostgREST 14.12**
- **GoTrue 2.189**

### Smoke test

```bash
bash scripts/local-stack/up.sh
ANON="$(bash scripts/local-stack/make-keys.sh anon)"
curl -s -o /dev/null -w "%{http_code}\n" \
  "http://127.0.0.1:54320/rest/v1/empresas?select=id" \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON"
# -> 200  (corpo "[]" por RLS = sucesso)
```

---

## VEREDITO go/no-go: **GO** para o Jeito A

A pilha Supabase (Postgres + PostgREST + GoTrue + gateway) roda 100% nativa em Linux,
sem Docker, e o app Exped funciona contra ela **sem mudar uma linha de código** — só
apontando o `.env.local` pro gateway. Migrations, RLS, auth e o fluxo e2e via
supabase-js passaram. O risco de runtime local está derrubado; segue para o
empacotamento Windows.

---

## Pendências / limitações conhecidas (próximo sub-projeto = empacotamento Windows)

- **Binários linux → win-x64**: trocar os três binários (Postgres, PostgREST, GoTrue)
  pelas builds Windows x64.
- **Storage**: hoje é stub que responde `501` no gateway (`/storage/v1/*`). Decidir o
  shim de storage (filesystem local, MinIO, ou storage-api nativo).
- **Login via cookie no browser (SSR)** não foi exercido neste spike (só fluxo
  supabase-js client). Testar no piloto.
- **Supervisão dos processos**: hoje sobem em background via `nohup`. No Windows vira
  serviço / auto-start (NSSM, serviço Windows ou Task Scheduler).
- **Instalador único**: empacotar os três binários + scripts num instalador só, com
  versões pinadas (Postgres 16.x, PostgREST 14.12, GoTrue 2.189).
