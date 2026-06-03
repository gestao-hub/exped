# Resolução de URL do Supabase em runtime (hub local + nuvem) — Design

> Data: 2026-06-03 · Projeto: Exped · Corrige o bug que faz o app do hub local falar com a NUVEM em vez de consigo mesmo.

## 1. Problema

O `next.config.ts` tem um bloco `env` que **assa (baked-in)** `NEXT_PUBLIC_SUPABASE_URL`/`ANON_KEY` no
build, **no server E no client**:
```js
env: { NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", ... }
```
O CI buildou o instalador com a URL da **nuvem** (`louaguxcohfeicxxqggw.supabase.co`) → ela ficou assada
no bundle. Resultado no servidor da Franzoni (confirmado: a URL aparece em `C:\Exped\app\.next\server\chunks\*`):
- Todos os clientes Supabase server-side ([`server.ts`](../../../lib/supabase/server.ts),
  [`admin.ts`](../../../lib/supabase/admin.ts), [`middleware.ts`](../../../lib/supabase/middleware.ts)) leem
  `NEXT_PUBLIC_SUPABASE_URL` (assado = nuvem).
- O fallback `window.__SUPABASE_*` do [`client.ts`](../../../lib/supabase/client.ts) fica inútil (o
  `process.env` assado vence o `||`).
- **O app do hub local fala com a nuvem.** O agente bate no hub local → `createAdminClient` aponta pra
  **nuvem** com a chave **local** → nuvem rejeita → **401** (o agente não consegue ingerir). E o benefício
  **offline** do hub fica anulado.

## 2. Objetivo

O app do hub local resolve URL/chaves do Supabase em **runtime** (gateway local), enquanto a **nuvem
(Vercel) continua funcionando sem mudança**. Conserta o 401 do agente e restaura o offline.

## 3. Decisões firmadas (Abordagem A)

- Clientes **server-side** leem uma env **não-pública** `SUPABASE_URL` (que o Next **nunca assa** — é
  sempre runtime), com fallback pra `NEXT_PUBLIC_SUPABASE_URL` (compat Vercel).
- Client (browser) prioriza `window.__SUPABASE_*` (injetado do runtime pelo layout) sobre `process.env`.
- Remover o bloco `env` do `next.config.ts` (não assar mais a URL).
- Maestro seta `SUPABASE_URL`/`SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_ROLE_KEY` = gateway/keys locais.
- CI (installer + release) **não passa** `NEXT_PUBLIC_*` no build.
- Vercel: zero mudança (fallback cobre).

## 4. Arquitetura

### 4.1 Novo: `lib/supabase/env.ts` (resolvedor server-side, puro/testável)
```ts
export function supabaseUrl(): string {
  return process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
}
export function supabaseAnonKey(): string {
  return process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
}
export function supabaseServiceKey(): string {
  return process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
}
```
`SUPABASE_URL`/`SUPABASE_ANON_KEY` são **não-públicas** → nunca assadas → sempre runtime. O fallback pra
`NEXT_PUBLIC_*` mantém a Vercel (que já tem essas envs) funcionando.

### 4.2 Consumidores (trocam `process.env.NEXT_PUBLIC_*` pelo resolvedor)
- **`lib/supabase/server.ts`**: `createClient` (SSR) usa `supabaseUrl()`/`supabaseAnonKey()`;
  `createServiceRoleClient` usa `supabaseUrl()`/`supabaseServiceKey()`.
- **`lib/supabase/admin.ts`**: `createAdminClient` usa `supabaseUrl()`/`supabaseServiceKey()`. *(conserta o 401)*
- **`lib/supabase/middleware.ts`**: usa `supabaseUrl()`/`supabaseAnonKey()`.
- **`app/layout.tsx`**: o `supabaseConfig` injetado em `window.__SUPABASE_*` usa `supabaseUrl()`/`supabaseAnonKey()`.

### 4.3 `lib/supabase/client.ts` (browser)
Inverte a prioridade — `window.__SUPABASE_*` primeiro, `process.env.NEXT_PUBLIC_*` como fallback:
```ts
const url = (typeof window !== 'undefined' && window.__SUPABASE_URL__) || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
```
Assim o valor injetado em runtime sempre vence; nunca pega um valor assado.

### 4.4 `next.config.ts`
Remover o bloco `env: { NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY }`. (Mantém o resto: `output: 'standalone'`.)

### 4.5 `hub/maestro.mjs` — `appSupervisor`
No `env` do supervisor do app, adicionar:
```js
SUPABASE_URL: gatewayUrl,
SUPABASE_ANON_KEY: keys.anon,
SUPABASE_SERVICE_ROLE_KEY: keys.service,
```
(Pode manter os `NEXT_PUBLIC_*` existentes — viram redundantes, mas inofensivos; ou removê-los. Decisão: manter, pra não mexer em mais nada.)

### 4.6 CI — `.github/workflows/{build-installer,release-hub}.yml`
Remover o bloco `env:` com `NEXT_PUBLIC_SUPABASE_URL`/`ANON_KEY` do passo `npm run build`. O build não
precisa deles (server lê runtime; client via window). Sem eles, **nada da nuvem é assado**.

## 5. Fluxo de dados (depois)

- **Hub local:** maestro seta `SUPABASE_URL=gateway` (+keys). Server clients → gateway; layout injeta
  `window.__SUPABASE_*=gateway`; client → window → gateway. **Tudo local.** Agente → app local →
  `createAdminClient` → gateway → DB local → acha o dispositivo → **200**. Offline volta.
- **Nuvem (Vercel):** `SUPABASE_URL` ausente → fallback `NEXT_PUBLIC_SUPABASE_URL` (cloud). Server → cloud;
  layout injeta cloud; client → window(cloud). **Tudo nuvem.** Sem mudança de env na Vercel.

## 6. Validação (ANTES de reinstalar)

- **Anti-baking (a prova-chave):** buildar local **sem** `NEXT_PUBLIC_*` no ambiente e fazer
  `grep -r "louaguxcohfeicxxqggw" .next/` → **não pode achar nada**. Confirma que a URL da nuvem não é
  mais assada. (Eu rodo isso no Linux antes de rebuildar o instalador.)
- **Unit (vitest):** `lib/supabase/env.ts` — precedência (`SUPABASE_URL` > `NEXT_PUBLIC_SUPABASE_URL` > '';
  idem anon; service só de `SUPABASE_SERVICE_ROLE_KEY`).
- Suíte existente + `typecheck` verdes.
- **E2E (na reinstalação):** o agente sai de 401 → 200; pedidos novos fluem; offline funciona.

## 7. Erros / riscos

- **Risco de quebrar a Vercel:** mitigado pelo fallback `?? NEXT_PUBLIC_*`. A Vercel não precisa de env nova;
  o service_role já está lá. (Conferir que a Vercel realmente tem `NEXT_PUBLIC_SUPABASE_URL`/`ANON_KEY`
  setadas — tem, o deploy atual funciona.)
- **`createServiceRoleClient` vs `createAdminClient`:** dois clientes service-role distintos; ambos são
  corrigidos. (Consolidar fica fora de escopo.)
- **Edge runtime do middleware:** lê `process.env` normalmente; `SUPABASE_URL` runtime funciona.

## 8. Fora de escopo

- Consolidar os dois clientes service-role num só.
- Mudar o naming `NEXT_PUBLIC_*` (mantido pra Vercel).
- Re-tag/rebuild do instalador (é a fase seguinte, após a validação anti-baking passar).
