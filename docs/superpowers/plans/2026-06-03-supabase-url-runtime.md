# Resolução de URL do Supabase em runtime — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer o app do hub local resolver a URL/chaves do Supabase em runtime (gateway local) em vez de usar a URL da nuvem assada no build, mantendo a Vercel funcionando.

**Architecture:** Um resolvedor server-side (`lib/supabase/env.ts`) lê `SUPABASE_URL` (env não-pública, nunca assada) com fallback pra `NEXT_PUBLIC_*` (Vercel). Todos os clientes server-side + o layout passam a usar o resolvedor; o client (browser) prioriza `window.__SUPABASE_*`. Remove-se o bloco `env` do next.config (que forçava o baking) e o maestro seta `SUPABASE_URL=gateway`. O CI do instalador/release não passa mais `NEXT_PUBLIC_*` no build.

**Tech Stack:** Next.js 16 (App Router), @supabase/ssr, Vitest, hub Node (`.mjs`), GitHub Actions.

**Spec:** [docs/superpowers/specs/2026-06-03-supabase-url-runtime-design.md](../specs/2026-06-03-supabase-url-runtime-design.md)

---

## File Structure

| Arquivo | Responsabilidade |
|---|---|
| `lib/supabase/env.ts` | Resolvedor runtime: `supabaseUrl()`/`supabaseAnonKey()`/`supabaseServiceKey()`. |
| `lib/supabase/__tests__/env.test.ts` | Testes de precedência do resolvedor. |
| `lib/supabase/server.ts` | `createClient`/`createServiceRoleClient` usam o resolvedor. |
| `lib/supabase/admin.ts` | `createAdminClient` usa o resolvedor (conserta o 401). |
| `lib/supabase/middleware.ts` | `updateSession` usa o resolvedor. |
| `app/layout.tsx` | `supabaseConfig` (injeção window) usa o resolvedor. |
| `lib/supabase/client.ts` | Prioriza `window.__SUPABASE_*` sobre `process.env`. |
| `next.config.ts` | Remove o bloco `env` que assava `NEXT_PUBLIC_*`. |
| `hub/maestro.mjs` | `appSupervisor` seta `SUPABASE_URL`/`SUPABASE_ANON_KEY` (+ service já existe). |
| `.github/workflows/build-installer.yml`, `release-hub.yml` | Build sem `NEXT_PUBLIC_*` (sem assar a nuvem). |

---

## Task 1: Resolvedor `lib/supabase/env.ts`

**Files:**
- Create: `lib/supabase/env.ts`
- Test: `lib/supabase/__tests__/env.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/supabase/__tests__/env.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { supabaseUrl, supabaseAnonKey, supabaseServiceKey } from '../env';

const KEYS = [
  'SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
];
function clear() { for (const k of KEYS) delete process.env[k]; }
afterEach(clear);

describe('supabase env resolver', () => {
  it('supabaseUrl: SUPABASE_URL tem precedência sobre NEXT_PUBLIC', () => {
    clear();
    process.env.SUPABASE_URL = 'http://local';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://cloud';
    expect(supabaseUrl()).toBe('http://local');
  });
  it('supabaseUrl: fallback p/ NEXT_PUBLIC quando SUPABASE_URL ausente', () => {
    clear();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://cloud';
    expect(supabaseUrl()).toBe('http://cloud');
  });
  it('supabaseUrl: vazio quando nenhum setado', () => {
    clear();
    expect(supabaseUrl()).toBe('');
  });
  it('supabaseAnonKey: mesma precedência', () => {
    clear();
    process.env.SUPABASE_ANON_KEY = 'a';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'b';
    expect(supabaseAnonKey()).toBe('a');
  });
  it('supabaseServiceKey: só de SUPABASE_SERVICE_ROLE_KEY', () => {
    clear();
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';
    expect(supabaseServiceKey()).toBe('svc');
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(supabaseServiceKey()).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- lib/supabase/__tests__/env.test.ts`
Expected: FAIL — "Cannot find module '../env'".

- [ ] **Step 3: Implement `lib/supabase/env.ts`**

```ts
// Resolve URL/chaves do Supabase em RUNTIME (server-side). `SUPABASE_URL`/`SUPABASE_ANON_KEY`
// são envs NÃO-públicas — o Next nunca as assa (baked) no bundle, então são lidas de verdade em
// runtime (no hub local = gateway; na Vercel caem no fallback NEXT_PUBLIC_*).
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

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- lib/supabase/__tests__/env.test.ts`
Expected: PASS (5 testes).

- [ ] **Step 5: Commit**

```bash
git add lib/supabase/env.ts lib/supabase/__tests__/env.test.ts
git commit -m "feat(supabase): resolvedor de URL/chaves em runtime (env.ts)"
```

---

## Task 2: `server.ts` + `admin.ts` usam o resolvedor

**Files:**
- Modify: `lib/supabase/server.ts`, `lib/supabase/admin.ts`

- [ ] **Step 1: Modify `lib/supabase/server.ts`**

Adicionar o import (junto aos outros, no topo):
```ts
import { supabaseUrl, supabaseAnonKey, supabaseServiceKey } from './env';
```
Em `createClient`, trocar:
```ts
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
```
por:
```ts
    supabaseUrl(),
    supabaseAnonKey(),
```
Em `createServiceRoleClient`, trocar:
```ts
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
```
por:
```ts
    supabaseUrl(),
    supabaseServiceKey(),
```

- [ ] **Step 2: Modify `lib/supabase/admin.ts`**

Substituir o corpo de `createAdminClient` (a parte que lê env) — trocar:
```ts
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
```
por:
```ts
import { supabaseUrl, supabaseServiceKey } from './env';

export function createAdminClient() {
  const url = supabaseUrl();
  const key = supabaseServiceKey();
```
> O import vai no topo do arquivo (mova `import { supabaseUrl, supabaseServiceKey } from './env';` pra junto dos outros imports; não deixe import no meio da função). O resto (`if (!url || !key) throw ...; return createClient(...)`) fica igual.

- [ ] **Step 3: Verify**

Run: `npm run typecheck`
Expected: exit 0 (sem erros nesses arquivos).
Run: `npm run test -- lib/supabase/__tests__/env.test.ts` (PASS — garante o resolvedor intacto).

- [ ] **Step 4: Commit**

```bash
git add lib/supabase/server.ts lib/supabase/admin.ts
git commit -m "refactor(supabase): server.ts/admin.ts usam o resolvedor runtime"
```

---

## Task 3: `middleware.ts` + `app/layout.tsx` usam o resolvedor

**Files:**
- Modify: `lib/supabase/middleware.ts`, `app/layout.tsx`

- [ ] **Step 1: Modify `lib/supabase/middleware.ts`**

Adicionar o import no topo:
```ts
import { supabaseUrl, supabaseAnonKey } from './env';
```
Trocar:
```ts
  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
```
por:
```ts
  const supabase = createServerClient<Database>(
    supabaseUrl(),
    supabaseAnonKey(),
```

- [ ] **Step 2: Modify `app/layout.tsx`**

Adicionar o import (junto aos outros no topo):
```ts
import { supabaseUrl, supabaseAnonKey } from '@/lib/supabase/env';
```
Trocar o `supabaseConfig`:
```ts
const supabaseConfig = {
  url: process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
  anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
};
```
por:
```ts
const supabaseConfig = {
  url: supabaseUrl(),
  anonKey: supabaseAnonKey(),
};
```
> ATENÇÃO: o `supabaseConfig` está hoje no escopo de módulo (top-level). `supabaseUrl()` lê
> `process.env` em runtime — mas no top-level ele roda 1x na carga do módulo. Pra garantir leitura
> por-request, MOVA o `const supabaseConfig = {...}` pra DENTRO do `RootLayout()` (antes do `return`),
> assim é avaliado a cada render do layout. Faça essa movimentação.

- [ ] **Step 3: Verify**

Run: `npm run typecheck` (exit 0).

- [ ] **Step 4: Commit**

```bash
git add lib/supabase/middleware.ts app/layout.tsx
git commit -m "refactor(supabase): middleware + layout usam o resolvedor (config por-request)"
```

---

## Task 4: `client.ts` prioriza `window`

**Files:**
- Modify: `lib/supabase/client.ts`

- [ ] **Step 1: Inverter a prioridade (window primeiro)**

Trocar o corpo de `createClient`:
```ts
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    (typeof window !== 'undefined' ? (window as Window & { __SUPABASE_URL__?: string }).__SUPABASE_URL__ : '') ||
    '';
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    (typeof window !== 'undefined' ? (window as Window & { __SUPABASE_ANON_KEY__?: string }).__SUPABASE_ANON_KEY__ : '') ||
    '';
```
por:
```ts
  // window.__SUPABASE_* é injetado pelo layout a partir do runtime do servidor (gateway local /
  // nuvem na Vercel). Prioriza ele sobre process.env pra nunca usar um valor assado no build.
  const url =
    (typeof window !== 'undefined' ? (window as Window & { __SUPABASE_URL__?: string }).__SUPABASE_URL__ : '') ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    '';
  const key =
    (typeof window !== 'undefined' ? (window as Window & { __SUPABASE_ANON_KEY__?: string }).__SUPABASE_ANON_KEY__ : '') ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    '';
```

- [ ] **Step 2: Verify + commit**

Run: `npm run typecheck` (exit 0).
```bash
git add lib/supabase/client.ts
git commit -m "fix(supabase): client.ts prioriza window.__SUPABASE_* (runtime) sobre env assada"
```

---

## Task 5: `next.config.ts` (remove `env`) + `hub/maestro.mjs` (seta `SUPABASE_*`)

**Files:**
- Modify: `next.config.ts`, `hub/maestro.mjs`

- [ ] **Step 1: Remover o bloco `env` do `next.config.ts`**

Trocar todo o conteúdo de `next.config.ts` por:
```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
};

export default nextConfig;
```
(Remove o bloco `env: { NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY }` que forçava o baking.)

- [ ] **Step 2: `hub/maestro.mjs` — `appSupervisor` seta as envs runtime**

Localizar (no `appSupervisor`, dentro do objeto `env`):
```js
      NEXT_PUBLIC_SUPABASE_URL: gatewayUrl,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: keys.anon,
      SUPABASE_SERVICE_ROLE_KEY: keys.service,
```
Trocar por (adiciona as não-públicas; mantém as NEXT_PUBLIC por compat):
```js
      SUPABASE_URL: gatewayUrl,
      SUPABASE_ANON_KEY: keys.anon,
      SUPABASE_SERVICE_ROLE_KEY: keys.service,
      NEXT_PUBLIC_SUPABASE_URL: gatewayUrl,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: keys.anon,
```

- [ ] **Step 3: Verify + commit**

Run: `npm run typecheck` (exit 0). Run: `npm run test -- hub/test/maestro.test.mjs` (deve continuar passando).
```bash
git add next.config.ts hub/maestro.mjs
git commit -m "fix(build): remove baking do NEXT_PUBLIC no next.config; maestro seta SUPABASE_URL runtime"
```

---

## Task 6: CI — build sem `NEXT_PUBLIC_*`

**Files:**
- Modify: `.github/workflows/build-installer.yml`, `.github/workflows/release-hub.yml`

- [ ] **Step 1: `build-installer.yml`**

Localizar o passo de build:
```yaml
      - name: Build app (standalone)
        run: npm run build
        env:
          NEXT_PUBLIC_SUPABASE_URL: ${{ secrets.NEXT_PUBLIC_SUPABASE_URL }}
          NEXT_PUBLIC_SUPABASE_ANON_KEY: ${{ secrets.NEXT_PUBLIC_SUPABASE_ANON_KEY }}
```
Trocar por (placeholders NÃO-públicos só pra o build não falhar; não são assados, e o runtime do hub sobrescreve):
```yaml
      - name: Build app (standalone)
        run: npm run build
        env:
          SUPABASE_URL: http://127.0.0.1:54320
          SUPABASE_ANON_KEY: build-placeholder-anon
```

- [ ] **Step 2: `release-hub.yml`** — mesma troca

Localizar o mesmo bloco `Build app` em `release-hub.yml` e aplicar a MESMA substituição do Step 1.

- [ ] **Step 3: Validar YAML + commit**

Run: `node -e "['.github/workflows/build-installer.yml','.github/workflows/release-hub.yml'].forEach(f=>{const y=require('fs').readFileSync(f,'utf8'); if(y.includes('secrets.NEXT_PUBLIC_SUPABASE_URL')) throw new Error('ainda passa NEXT_PUBLIC: '+f); }); console.log('OK: build sem NEXT_PUBLIC')"`
```bash
git add .github/workflows/build-installer.yml .github/workflows/release-hub.yml
git commit -m "ci: build do app sem NEXT_PUBLIC_* (nao assa a URL da nuvem no bundle)"
```

---

## Task 7: Validação anti-baking (a prova-chave)

**Files:** nenhum (verificação).

- [ ] **Step 1: Build local exatamente como o CI fará (sem NEXT_PUBLIC)**

Run:
```bash
rm -rf .next
env -u NEXT_PUBLIC_SUPABASE_URL -u NEXT_PUBLIC_SUPABASE_ANON_KEY \
  SUPABASE_URL=http://127.0.0.1:54320 SUPABASE_ANON_KEY=build-placeholder-anon \
  npm run build
```
Expected: build conclui sem erro (exit 0).

- [ ] **Step 2: Provar que a URL da nuvem NÃO está assada**

Run:
```bash
grep -r "louaguxcohfeicxxqggw" .next/ | head; echo "EXIT=$?"
```
Expected: **nenhuma linha** (grep não acha) → `EXIT=1`. Isso PROVA que o bundle do hub local não tem
mais a URL da nuvem assada. (Se achar alguma linha, a correção está incompleta — reportar.)

- [ ] **Step 3: Gates completos**

Run: `npm run test` (0 failed). Run: `npm run typecheck` (exit 0). Run: `npm run lint` (sem novos erros nos arquivos tocados).

- [ ] **Step 4: (na reinstalação, manual — fora deste plano)**

Documentar pro go-live: re-tag → CI rebuilda instalador limpo → reinstalar na Franzoni → o agente sai de
401 → 200 (o `createAdminClient` agora bate no gateway local). Confirmar pedidos novos fluindo + offline.

---

## Self-Review (autor do plano)

- **Cobertura do spec:** resolvedor env.ts (T1) ✓; server/admin (T2) ✓; middleware/layout (T3) ✓;
  client window-first (T4) ✓; next.config remove env + maestro SUPABASE_URL (T5) ✓; CI sem NEXT_PUBLIC (T6) ✓;
  validação anti-baking + gates (T7) ✓; Vercel inalterada (fallback no resolvedor, sem task) ✓.
- **Placeholders:** nenhum — todo código escrito. (T2/T3/T4 são edições mostradas integralmente; a ressalva
  de mover `supabaseConfig` pra dentro do RootLayout é instrução explícita, não placeholder.)
- **Consistência:** `supabaseUrl()/supabaseAnonKey()/supabaseServiceKey()` definidos em T1 e usados igual em
  T2/T3 (e no layout); `SUPABASE_URL`/`SUPABASE_ANON_KEY` setados no maestro (T5) batem com o que o resolvedor
  lê (T1); o placeholder do CI (T6) usa as mesmas envs não-públicas; a validação (T7) builda do mesmo jeito que o CI.
