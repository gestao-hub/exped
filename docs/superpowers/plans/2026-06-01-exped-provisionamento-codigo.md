# Provisionamento por Código de Instalação — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Onboarding híbrido em 1 código: o operador gera um código no painel; o cliente roda 1 instalador, digita o código, e tudo se autoconfigura (token de dispositivo, URL da nuvem, config do agente).

**Architecture:** Código curto/uso-único/24h (só o hash no banco) resgatado num endpoint público que **gera o token só no resgate**; config do agente passa a viver na `empresas` (sincroniza pro hub local, lida pelo agente via endpoint local); instalador único escreve os 2 configs sozinho.

**Tech Stack:** Next.js 16 (App Router, route handlers `nodejs`), Supabase Postgres (migrations + RPC SECURITY DEFINER), TypeScript, zod, vitest, .NET 8 (agente), PowerShell + Inno Setup (instalador).

**Spec:** `docs/superpowers/specs/2026-06-01-exped-provisionamento-codigo-design.md`

**Constraints (CLAUDE.md):** migrations seguem o protocolo (inventariar → diff → dry-run BEGIN/ROLLBACK → aplicar; ≤100 linhas; uma coisa por migration; validação entre etapas). Preferir Serena pra navegação/edição TS. Endpoints públicos `verify_jwt off` com validação interna. Erro genérico + requestId (sem vazar motivo). Nunca expor schema auth. Hiper só-leitura.

**Aplicação de migrations:** via Management API (já usada nesta sessão) ou MCP. Commit do `.sql` em `supabase/migrations/` só **depois** de validar. Migrations também são aplicadas no hub local pelo `hub/bootstrap.mjs` no próximo start (não precisa ação manual no Windows além de `git pull` + restart do serviço).

---

## File Structure

**Fase 1 — Banco**
- Create: `supabase/migrations/20260601000010_provisioning_codes.sql` — tabela + RLS.
- Create: `supabase/migrations/20260601000011_empresa_agente_config.sql` — colunas `agente_*` na `empresas`.
- Create: `supabase/migrations/20260601000012_redeem_rpc.sql` — RPC `redeem_provisioning_code` + rate-limit.
- Create: `lib/provisioning/code.ts` — geração/hash/normalização do código.
- Test: `lib/provisioning/__tests__/code.test.ts`.

**Fase 2 — API**
- Create: `app/api/provision/redeem/route.ts` — endpoint público de resgate.
- Create: `app/api/agent/config/route.ts` — config do agente (lido do hub local).
- Create: `lib/provisioning/__tests__/redeem-route.test.ts`, `lib/provisioning/__tests__/agent-config-route.test.ts`.

**Fase 3 — Painel**
- Create: `lib/provisioning/actions.ts` — `criarCodigoInstalacaoAction`.
- Modify: `lib/empresa/actions.ts` (ou novo `lib/empresa/agente-config-actions.ts`) — `salvarAgenteConfigAction`.
- Modify: `app/(app)/plataforma/plataforma-client.tsx` — botão "Gerar código" + form de config do agente.
- Modify: `app/(app)/plataforma/page.tsx` — carregar colunas `agente_*`.

**Fase 4 — Instalador único (Windows)**
- Create: `hub/win/provision.ps1` — resgata o código e escreve os 2 configs.
- Create: `hub/win/exped-setup.iss` — instalador unificado (hub + agente) com wizard do código.
- Modify: `hub/win/README.md` — runbook do fluxo por código.

**Fase 5 — Agente .NET**
- Create: `agent/ExpedAgent/RemoteConfigClient.cs` — busca `/api/agent/config` (cache + fallback).
- Modify: `agent/ExpedAgent/Worker.cs` — aplica config remota a cada ciclo.
- Modify: `agent/ExpedAgent/Program.cs` — registrar `RemoteConfigClient`.

---

## FASE 1 — Banco + geração do código

### Task 1.1: Migration — tabela `provisioning_codes`

**Files:**
- Create: `supabase/migrations/20260601000010_provisioning_codes.sql`

- [ ] **Step 1: Inventariar (protocolo CLAUDE.md)**

Rode (Management API/MCP) e confirme que a tabela NÃO existe e que `empresas`/`dispositivos` existem:
```sql
select table_name from information_schema.tables
where table_schema='public' and table_name in ('provisioning_codes','empresas','dispositivos');
```
Esperado: retorna `empresas` e `dispositivos`, **não** `provisioning_codes`.

- [ ] **Step 2: Escrever a migration**

```sql
-- 20260601000010_provisioning_codes.sql — códigos de instalação (uso único, 24h)
create table if not exists public.provisioning_codes (
  id                   uuid primary key default gen_random_uuid(),
  empresa_id           uuid not null references public.empresas(id) on delete cascade,
  code_hash            text not null unique,              -- sha256 do código (nunca o cru)
  expires_at           timestamptz not null,
  used_at              timestamptz,
  used_dispositivo_id  uuid references public.dispositivos(id) on delete set null,
  created_by           uuid references auth.users(id) on delete set null,
  created_at           timestamptz not null default now()
);
create index if not exists provisioning_codes_empresa_idx on public.provisioning_codes(empresa_id);

alter table public.provisioning_codes enable row level security;
-- Leitura/escrita só platform admin (o resgate usa service_role e ignora RLS).
drop policy if exists provisioning_codes_platform on public.provisioning_codes;
create policy provisioning_codes_platform on public.provisioning_codes for all to authenticated
  using (public.is_platform_admin()) with check (public.is_platform_admin());
```

- [ ] **Step 3: Dry-run**

```sql
BEGIN;
-- cole o conteúdo da migration aqui
ROLLBACK;
```
Esperado: sem erro. Se erro → corrige e repete.

- [ ] **Step 4: Aplicar** via `apply_migration` (name `provisioning_codes`). Validação:
```sql
select column_name from information_schema.columns
where table_schema='public' and table_name='provisioning_codes' order by ordinal_position;
```
Esperado: as 7 colunas acima.

- [ ] **Step 5: Commit do .sql** (só após aplicar com sucesso)
```bash
git add supabase/migrations/20260601000010_provisioning_codes.sql
git commit -m "feat(db): tabela provisioning_codes (codigos de instalacao uso unico)"
```

---

### Task 1.2: Migration — colunas `agente_*` na `empresas`

**Files:**
- Create: `supabase/migrations/20260601000011_empresa_agente_config.sql`

- [ ] **Step 1: Inventariar**
```sql
select column_name from information_schema.columns
where table_schema='public' and table_name='empresas' and column_name like 'agente_%';
```
Esperado: vazio (ainda não existem).

- [ ] **Step 2: Escrever a migration**

```sql
-- 20260601000011_empresa_agente_config.sql — config do agente por empresa (sincroniza pro hub)
alter table public.empresas
  add column if not exists agente_situacoes_venda text    not null default '2,5,7',
  add column if not exists agente_sync_os         boolean not null default false,
  add column if not exists agente_situacoes_os    text    not null default '',
  add column if not exists agente_poll_segundos   integer not null default 30;
```

- [ ] **Step 3: Dry-run** (`BEGIN; … ROLLBACK;`) — esperado sem erro.

- [ ] **Step 4: Aplicar** (`apply_migration` name `empresa_agente_config`). Validação:
```sql
select agente_situacoes_venda, agente_sync_os, agente_situacoes_os, agente_poll_segundos
from public.empresas limit 1;
```
Esperado: valores default (`2,5,7`, false, ``, 30).

> **Nota sync:** `empresas` é tabela `down` (ver `lib/sync/tables.ts`) e o pull usa `select('*')`, então as colunas novas **descem automaticamente** pro hub. Nenhuma allowlist a mudar.

- [ ] **Step 5: Commit**
```bash
git add supabase/migrations/20260601000011_empresa_agente_config.sql
git commit -m "feat(db): colunas agente_* na empresas (config do agente sincronizada)"
```

---

### Task 1.3: Migration — RPC de resgate + rate-limit

**Files:**
- Create: `supabase/migrations/20260601000012_redeem_rpc.sql`

- [ ] **Step 1: Escrever a migration**

```sql
-- 20260601000012_redeem_rpc.sql — resgate atômico + throttle por IP
create table if not exists public.provision_redeem_attempts (
  id  bigserial primary key,
  ip  text not null,
  at  timestamptz not null default now()
);
create index if not exists provision_attempts_ip_at on public.provision_redeem_attempts(ip, at);

-- registra 1 tentativa e devolve quantas houve desse IP nos últimos 10 min
create or replace function public.provision_note_attempt(p_ip text)
returns integer language plpgsql security definer set search_path = public as $$
declare c integer;
begin
  insert into public.provision_redeem_attempts(ip) values (coalesce(p_ip,'unknown'));
  select count(*) into c from public.provision_redeem_attempts
   where ip = coalesce(p_ip,'unknown') and at > now() - interval '10 minutes';
  return c;
end $$;

-- resgate: valida o código (for update), cria o dispositivo, marca usado. Token vem do Node (só o hash).
create or replace function public.redeem_provisioning_code(
  p_code_hash text, p_token_hash text, p_dispositivo_nome text
) returns table(empresa_id uuid, empresa_nome text)
language plpgsql security definer set search_path = public as $$
declare v_code public.provisioning_codes; v_disp uuid; v_nome text;
begin
  select * into v_code from public.provisioning_codes where code_hash = p_code_hash for update;
  if not found then raise exception 'codigo inexistente' using errcode='P0001'; end if;
  if v_code.used_at is not null then raise exception 'codigo ja usado' using errcode='P0002'; end if;
  if v_code.expires_at < now() then raise exception 'codigo expirado' using errcode='P0003'; end if;
  insert into public.dispositivos(empresa_id, nome, token_hash, ativo)
    values (v_code.empresa_id, p_dispositivo_nome, p_token_hash, true) returning id into v_disp;
  update public.provisioning_codes set used_at = now(), used_dispositivo_id = v_disp where id = v_code.id;
  select nome into v_nome from public.empresas where id = v_code.empresa_id;
  return query select v_code.empresa_id, v_nome;
end $$;

revoke all on function public.redeem_provisioning_code(text,text,text) from public, anon, authenticated;
revoke all on function public.provision_note_attempt(text) from public, anon, authenticated;
grant execute on function public.redeem_provisioning_code(text,text,text) to service_role;
grant execute on function public.provision_note_attempt(text) to service_role;
```
(≈45 linhas — dentro do limite.)

- [ ] **Step 2: Dry-run** (`BEGIN; … ROLLBACK;`). Esperado sem erro.

- [ ] **Step 3: Aplicar** (`apply_migration` name `redeem_rpc`).

- [ ] **Step 4: Teste de fumaça do RPC** (no banco): cria uma empresa fake já existe (Franzoni). Insira um código de teste e resgate:
```sql
-- prepara um código de teste
insert into public.provisioning_codes(empresa_id, code_hash, expires_at)
values ('00000000-0000-0000-0000-0000000f0001', 'deadbeef_teste', now()+interval '1 hour');
-- resgata
select * from public.redeem_provisioning_code('deadbeef_teste','hash_token_teste','Hub teste');
-- 2ª vez deve falhar (já usado)
select * from public.redeem_provisioning_code('deadbeef_teste','x','y');  -- espera ERRO P0002
-- limpa
delete from public.dispositivos where token_hash='hash_token_teste';
delete from public.provisioning_codes where code_hash='deadbeef_teste';
```
Esperado: 1ª chamada retorna `(empresa_id, "Franzoni Casa & Construção")`; 2ª lança erro `codigo ja usado`.

- [ ] **Step 5: Commit**
```bash
git add supabase/migrations/20260601000012_redeem_rpc.sql
git commit -m "feat(db): RPC redeem_provisioning_code (atomico) + throttle por IP"
```

---

### Task 1.4: `lib/provisioning/code.ts` — geração do código (TDD)

**Files:**
- Create: `lib/provisioning/code.ts`
- Test: `lib/provisioning/__tests__/code.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// lib/provisioning/__tests__/code.test.ts
import { describe, it, expect } from 'vitest';
import { gerarCodigoInstalacao, hashCodigo, normalizeCodigo } from '../code';

describe('código de instalação', () => {
  it('gera no formato EXPED-XXXX-XXXX sem caracteres ambíguos', () => {
    const { raw } = gerarCodigoInstalacao();
    expect(raw).toMatch(/^EXPED-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(raw).not.toMatch(/[01OIL]/); // sem ambíguos
  });

  it('normaliza case e hífens antes de hashear', () => {
    expect(normalizeCodigo('exped-7k4p-2qxm')).toBe('EXPED7K4P2QXM');
    expect(hashCodigo('exped-7k4p-2qxm')).toBe(hashCodigo('EXPED 7K4P 2QXM'));
  });

  it('hash é sha256 hex determinístico e o raw casa com seu hash', () => {
    const { raw, hash } = gerarCodigoInstalacao();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCodigo(raw)).toBe(hash);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run lib/provisioning/__tests__/code.test.ts`
Expected: FAIL (`Cannot find module '../code'`).

- [ ] **Step 3: Implementar**

```ts
// lib/provisioning/code.ts
import { randomBytes, createHash } from 'node:crypto';

/** Alfabeto sem caracteres ambíguos (sem 0,O,1,I,L). 31 símbolos. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Remove tudo que não é A-Z/0-9 e sobe pra maiúsculo (p/ digitação tolerante). */
export function normalizeCodigo(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** SHA-256 (hex) do código normalizado — o que guardamos no banco. */
export function hashCodigo(raw: string): string {
  return createHash('sha256').update(normalizeCodigo(raw)).digest('hex');
}

/** n caracteres aleatórios do ALPHABET com rejection sampling (sem viés de módulo). */
function randomChars(n: number): string {
  const out: string[] = [];
  const limit = 256 - (256 % ALPHABET.length); // 248 = 31*8
  while (out.length < n) {
    for (const b of randomBytes(n * 2)) {
      if (b < limit) {
        out.push(ALPHABET[b % ALPHABET.length]);
        if (out.length === n) break;
      }
    }
  }
  return out.join('');
}

/** Gera o código cru `EXPED-XXXX-XXXX` + seu hash. O cru é exibido 1x ao operador. */
export function gerarCodigoInstalacao(): { raw: string; hash: string } {
  const raw = `EXPED-${randomChars(4)}-${randomChars(4)}`;
  return { raw, hash: hashCodigo(raw) };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run lib/provisioning/__tests__/code.test.ts`
Expected: PASS (3 testes).

- [ ] **Step 5: Commit**
```bash
git add lib/provisioning/code.ts lib/provisioning/__tests__/code.test.ts
git commit -m "feat(provisioning): geracao/hash do codigo de instalacao"
```

---

## FASE 2 — Endpoints

### Task 2.1: `/api/provision/redeem` (TDD)

**Files:**
- Create: `app/api/provision/redeem/route.ts`
- Test: `lib/provisioning/__tests__/redeem-route.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// lib/provisioning/__tests__/redeem-route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

let rpcImpl: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ rpc: (fn: string, args: Record<string, unknown>) => rpcImpl(fn, args) }),
}));

import { POST } from '../../../app/api/provision/redeem/route';

function req(body: unknown, ip = '1.2.3.4'): Request {
  return new Request('http://x/api/provision/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  rpcImpl = async (fn) => {
    if (fn === 'provision_note_attempt') return { data: 1, error: null };
    if (fn === 'redeem_provisioning_code')
      return { data: [{ empresa_id: 'E1', empresa_nome: 'Acme' }], error: null };
    return { data: null, error: null };
  };
});

describe('/api/provision/redeem', () => {
  it('resgata e devolve token + url + empresa', async () => {
    const res = await POST(req({ code: 'EXPED-7K4P-2QXM' }) as never);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.deviceToken).toMatch(/^hpr_/);
    expect(j.empresaId).toBe('E1');
    expect(j.empresaNome).toBe('Acme');
    expect(typeof j.cloudApiUrl).toBe('string');
  });

  it('código inválido → 400 genérico com requestId', async () => {
    rpcImpl = async (fn) =>
      fn === 'provision_note_attempt' ? { data: 1, error: null } : { data: null, error: { message: 'codigo inexistente' } };
    const res = await POST(req({ code: 'EXPED-XXXX-XXXX' }) as never);
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error).toBe('codigo invalido ou expirado');
    expect(j.requestId).toBeTruthy();
  });

  it('excesso de tentativas → 429', async () => {
    rpcImpl = async (fn) => (fn === 'provision_note_attempt' ? { data: 99, error: null } : { data: null, error: null });
    const res = await POST(req({ code: 'EXPED-7K4P-2QXM' }) as never);
    expect(res.status).toBe(429);
  });

  it('payload inválido → 422', async () => {
    const res = await POST(req({ nope: true }) as never);
    expect(res.status).toBe(422);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run lib/provisioning/__tests__/redeem-route.test.ts`
Expected: FAIL (módulo da rota não existe).

- [ ] **Step 3: Implementar a rota**

```ts
// app/api/provision/redeem/route.ts
import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/admin';
import { hashCodigo } from '@/lib/provisioning/code';
import { gerarTokenDispositivo } from '@/lib/crypto/token';

export const runtime = 'nodejs';

const CLOUD_API = process.env.EXPED_PUBLIC_CLOUD_API ?? 'https://app-exped.vercel.app';
const MAX_ATTEMPTS = 20; // por IP / 10 min
const schema = z.object({ code: z.string().min(4).max(40) });

/**
 * Resgate público do código de instalação. verify_jwt off; validação interna.
 * Gera o token de dispositivo AQUI (Node) e passa só o hash pro RPC, que cria o
 * dispositivo e marca o código como usado atomicamente. Erro sempre genérico + requestId.
 */
export async function POST(req: NextRequest) {
  const supabase = createAdminClient();
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';

  const { data: attempts } = await supabase.rpc('provision_note_attempt', { p_ip: ip });
  if (typeof attempts === 'number' && attempts > MAX_ATTEMPTS) {
    return NextResponse.json({ error: 'muitas tentativas, tente mais tarde' }, { status: 429 });
  }

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'payload inválido' }, { status: 422 });

  const codeHash = hashCodigo(parsed.data.code);
  const { raw: deviceToken, hash: tokenHash } = gerarTokenDispositivo();
  const nome = `Hub ${new Date().toISOString().slice(0, 10)}`;

  const { data, error } = await supabase.rpc('redeem_provisioning_code', {
    p_code_hash: codeHash, p_token_hash: tokenHash, p_dispositivo_nome: nome,
  });
  const row = Array.isArray(data) ? data[0] : data;
  if (error || !row) {
    const requestId = randomUUID().slice(0, 8);
    console.error(`[provision/redeem] req=${requestId}:`, (error as { message?: string })?.message ?? 'sem retorno');
    return NextResponse.json({ error: 'codigo invalido ou expirado', requestId }, { status: 400 });
  }

  return NextResponse.json({
    deviceToken,
    cloudApiUrl: CLOUD_API,
    empresaId: row.empresa_id,
    empresaNome: row.empresa_nome,
  });
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run lib/provisioning/__tests__/redeem-route.test.ts`
Expected: PASS (4 testes).

- [ ] **Step 5: Configurar `verify_jwt off`** — adicionar a rota à lista de rotas públicas. Verifique como as rotas públicas atuais (`/api/ingest/*`, `/api/sync/*`) são liberadas:
```bash
grep -rn "verify_jwt\|publicRoutes\|matcher\|/api/ingest\|/api/sync" middleware.ts next.config.* 2>/dev/null
```
Aplique o MESMO mecanismo pra `/api/provision/redeem`. (Se for o `middleware.ts` com lista de prefixos públicos, adicione `/api/provision`.)

- [ ] **Step 6: Commit**
```bash
git add app/api/provision/redeem/route.ts lib/provisioning/__tests__/redeem-route.test.ts middleware.ts
git commit -m "feat(api): /api/provision/redeem (publico, throttle, gera token no resgate)"
```

---

### Task 2.2: `/api/agent/config` (TDD)

**Files:**
- Create: `app/api/agent/config/route.ts`
- Test: `lib/provisioning/__tests__/agent-config-route.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// lib/provisioning/__tests__/agent-config-route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

let deviceRow: { id: string; empresa_id: string; ativo: boolean } | null = null;
let empresaRow: Record<string, unknown> | null = null;

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from(t: string) {
      return {
        select() { return this; },
        eq() { return this; },
        async maybeSingle() { return { data: deviceRow }; },           // dispositivos (resolveDevice)
        async single() { return { data: t === 'empresas' ? empresaRow : null }; },
        update() { return { eq: async () => ({ data: null }) }; },
      };
    },
  }),
}));

import { GET } from '../../../app/api/agent/config/route';

function req(token?: string): Request {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request('http://127.0.0.1:3000/api/agent/config', { headers });
}

beforeEach(() => {
  deviceRow = { id: 'D1', empresa_id: 'E1', ativo: true };
  empresaRow = { agente_situacoes_venda: '3,9', agente_sync_os: true, agente_situacoes_os: '10,20', agente_poll_segundos: 15 };
});

describe('/api/agent/config', () => {
  it('sem token → 401', async () => {
    const res = await GET(req() as never);
    expect(res.status).toBe(401);
  });

  it('com token → devolve a config da empresa', async () => {
    const res = await GET(req('hpr_abc') as never);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j).toEqual({ situacoesVenda: '3,9', syncOs: true, situacoesOs: '10,20', pollSegundos: 15 });
  });

  it('empresa sem colunas → defaults', async () => {
    empresaRow = {};
    const res = await GET(req('hpr_abc') as never);
    const j = await res.json();
    expect(j).toEqual({ situacoesVenda: '2,5,7', syncOs: false, situacoesOs: '', pollSegundos: 30 });
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run lib/provisioning/__tests__/agent-config-route.test.ts`
Expected: FAIL (módulo não existe).

- [ ] **Step 3: Implementar a rota**

```ts
// app/api/agent/config/route.ts
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { resolveDevice } from '@/lib/sync/auth';

export const runtime = 'nodejs';

/**
 * Config de comportamento do agente, por empresa. O agente chama o HUB LOCAL
 * (mesmo código do app); resolveDevice valida o token contra `dispositivos` local
 * (que desce via sync). Offline-safe. Erro genérico em 401.
 */
export async function GET(req: NextRequest) {
  const supabase = createAdminClient();
  const device = await resolveDevice(supabase, req.headers.get('authorization'));
  if (!device) return NextResponse.json({ error: 'Dispositivo inválido ou inativo' }, { status: 401 });

  const { data } = await supabase
    .from('empresas')
    .select('agente_situacoes_venda, agente_sync_os, agente_situacoes_os, agente_poll_segundos')
    .eq('id', device.empresaId)
    .single();

  return NextResponse.json({
    situacoesVenda: (data?.agente_situacoes_venda as string) ?? '2,5,7',
    syncOs: (data?.agente_sync_os as boolean) ?? false,
    situacoesOs: (data?.agente_situacoes_os as string) ?? '',
    pollSegundos: (data?.agente_poll_segundos as number) ?? 30,
  });
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run lib/provisioning/__tests__/agent-config-route.test.ts`
Expected: PASS (3 testes).

- [ ] **Step 5: `verify_jwt off`** pra `/api/agent/config` (mesmo mecanismo do Task 2.1 Step 5 — o prefixo `/api/agent` provavelmente já é público, dado `/api/agent/heartbeat`; confirme).

- [ ] **Step 6: Rodar a suíte inteira** (garantir 0 regressão)

Run: `npx vitest run`
Expected: PASS (130 antigos + os novos).

- [ ] **Step 7: Commit**
```bash
git add app/api/agent/config/route.ts lib/provisioning/__tests__/agent-config-route.test.ts
git commit -m "feat(api): /api/agent/config (config do agente lida do hub local)"
```

---

## FASE 3 — Painel

### Task 3.1: Server action `criarCodigoInstalacaoAction`

**Files:**
- Create: `lib/provisioning/actions.ts`

- [ ] **Step 1: Implementar** (segue o padrão de `lib/empresa/devices-actions.ts` — só platform admin)

```ts
// lib/provisioning/actions.ts
'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { gerarCodigoInstalacao } from '@/lib/provisioning/code';

async function isPlatformAdmin(): Promise<boolean> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;
  const { data } = await supabase.from('profiles').select('is_platform_admin').eq('id', user.id).single();
  return !!data?.is_platform_admin;
}

/** Gera um código de instalação (uso único, 24h) p/ a empresa. Devolve o cru 1x. */
export async function criarCodigoInstalacaoAction(
  empresaId: string,
): Promise<{ ok: true; codigo: string; expiraEm: string } | { error: string }> {
  if (!(await isPlatformAdmin())) return { error: 'Apenas o operador da plataforma' };
  if (!empresaId) return { error: 'Empresa obrigatória' };

  const { raw, hash } = gerarCodigoInstalacao();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase.from('provisioning_codes').insert({
    empresa_id: empresaId, code_hash: hash, expires_at: expiresAt, created_by: user?.id ?? null,
  });
  if (error) return { error: error.message };

  revalidatePath('/plataforma');
  return { ok: true, codigo: raw, expiraEm: expiresAt };
}
```

- [ ] **Step 2: Commit**
```bash
git add lib/provisioning/actions.ts
git commit -m "feat(painel): action criarCodigoInstalacaoAction (platform admin)"
```

---

### Task 3.2: Server action `salvarAgenteConfigAction`

**Files:**
- Create: `lib/empresa/agente-config-actions.ts`

- [ ] **Step 1: Implementar**

```ts
// lib/empresa/agente-config-actions.ts
'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';

export type AgenteConfig = {
  agente_situacoes_venda: string;
  agente_sync_os: boolean;
  agente_situacoes_os: string;
  agente_poll_segundos: number;
};

async function isPlatformAdmin(): Promise<boolean> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;
  const { data } = await supabase.from('profiles').select('is_platform_admin').eq('id', user.id).single();
  return !!data?.is_platform_admin;
}

/** Salva a config do agente na empresa (só platform admin). Sincroniza pro hub. */
export async function salvarAgenteConfigAction(
  empresaId: string, cfg: AgenteConfig,
): Promise<{ ok: true } | { error: string }> {
  if (!(await isPlatformAdmin())) return { error: 'Apenas o operador da plataforma' };
  const poll = Number.isFinite(cfg.agente_poll_segundos) ? Math.max(5, Math.min(600, cfg.agente_poll_segundos)) : 30;
  const supabase = await createClient();
  const { error } = await supabase.from('empresas').update({
    agente_situacoes_venda: cfg.agente_situacoes_venda.trim() || '2,5,7',
    agente_sync_os: cfg.agente_sync_os,
    agente_situacoes_os: cfg.agente_situacoes_os.trim(),
    agente_poll_segundos: poll,
  }).eq('id', empresaId);
  if (error) return { error: error.message };
  revalidatePath('/plataforma');
  return { ok: true };
}
```

- [ ] **Step 2: Commit**
```bash
git add lib/empresa/agente-config-actions.ts
git commit -m "feat(painel): action salvarAgenteConfigAction (config do agente por empresa)"
```

---

### Task 3.3: UI — botão "Gerar código" + form de config do agente

**Files:**
- Modify: `app/(app)/plataforma/page.tsx` (carregar colunas `agente_*` no select de empresas)
- Modify: `app/(app)/plataforma/plataforma-client.tsx`

- [ ] **Step 1: page.tsx — incluir as colunas novas no fetch de empresas**

Localize o `.from('empresas').select(...)` em `app/(app)/plataforma/page.tsx` e acrescente
`agente_situacoes_venda, agente_sync_os, agente_situacoes_os, agente_poll_segundos` à lista de colunas.
Atualize o `type Empresa` em `plataforma-client.tsx` pra incluir esses 4 campos.

- [ ] **Step 2: plataforma-client.tsx — botão "Gerar código de instalação"**

No `DispositivosSection` (já existe, importa `criarDispositivoAction` e usa `onTokenGerado`),
adicione um botão ao lado do "Gerar token", chamando a nova action e reusando o dialog
`tokenRevelado` (ou um dialog irmão `codigoRevelado`). Código do handler:

```tsx
import { criarCodigoInstalacaoAction } from '@/lib/provisioning/actions';
// ...dentro do componente:
async function gerarCodigo() {
  const r = await criarCodigoInstalacaoAction(empresaId);
  if ('error' in r) { toast.error(r.error); return; }
  onCodigoGerado(r.codigo); // abre um dialog mostrando r.codigo + "vale 1 instalação, expira em 24h"
}
```
Botão:
```tsx
<Button variant="secondary" onClick={gerarCodigo}>Gerar código de instalação</Button>
```
O dialog do código reusa o layout do `tokenRevelado` (Input readOnly + copiar), com o título
"Código de instalação" e a legenda "Vale 1 instalação. Expira em 24h."

- [ ] **Step 3: plataforma-client.tsx — form de config do agente**

No `EmpresaCard` (onde já há o form de notificações), adicione um bloco "Configuração do agente":
```tsx
import { salvarAgenteConfigAction } from '@/lib/empresa/agente-config-actions';
// estados iniciais a partir de empresa.agente_*
// inputs:
//  - "Situações de venda (gatilho)"  -> agente_situacoes_venda (text, ex "2,5,7")
//  - switch "Sincronizar OS"          -> agente_sync_os
//  - "Situações de OS (gatilho)"      -> agente_situacoes_os (text; só habilita se sync_os)
//  - "Intervalo de leitura (s)"       -> agente_poll_segundos (number)
// botão "Salvar" -> salvarAgenteConfigAction(empresa.id, {...}); toast no resultado
```

- [ ] **Step 4: Typecheck + suíte**

Run: `npx tsc --noEmit && npx vitest run`
Expected: sem erros de tipo; testes verdes.

- [ ] **Step 5: Commit**
```bash
git add "app/(app)/plataforma/page.tsx" "app/(app)/plataforma/plataforma-client.tsx"
git commit -m "feat(painel): botao gerar codigo de instalacao + form de config do agente"
```

---

## FASE 4 — Instalador único (validação no Windows)

> Estas tasks rodam/validam na **máquina Windows** (o Claude do Windows executa; você relata).
> Não há TDD automatizado pra Inno Setup; a validação é o checklist do final.

### Task 4.1: `hub/win/provision.ps1`

**Files:**
- Create: `hub/win/provision.ps1`

- [ ] **Step 1: Implementar o script**

```powershell
# provision.ps1 — resgata o código de instalação e escreve os 2 configs.
# Uso: provision.ps1 -Code "EXPED-7K4P-2QXM" [-CloudApi "https://app-exped.vercel.app"]
param(
  [Parameter(Mandatory=$true)][string]$Code,
  [string]$CloudApi = "https://app-exped.vercel.app",
  [string]$Root = "C:\Exped"
)
$ErrorActionPreference = "Stop"

# 1) Resgatar
$body = @{ code = $Code } | ConvertTo-Json -Compress
try {
  $resp = Invoke-RestMethod -Method Post -Uri "$CloudApi/api/provision/redeem" `
            -ContentType "application/json" -Body $body -TimeoutSec 30
} catch {
  Write-Error "Falha ao resgatar o código. Verifique a internet e gere um novo código no painel. ($_)"
  exit 2
}
if (-not $resp.deviceToken) { Write-Error "Resgate sem token — código inválido ou expirado."; exit 3 }

$token  = $resp.deviceToken
$cloud  = $resp.cloudApiUrl

# 2) Escrever config.json do hub (preserva jwtSecret/portas já gerados no install)
$cfgPath = Join-Path $Root "config.json"
$cfg = if (Test-Path $cfgPath) { Get-Content $cfgPath -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
$cfg | Add-Member -NotePropertyName cloud -NotePropertyValue ([pscustomobject]@{ apiBase=$cloud; deviceToken=$token }) -Force
($cfg | ConvertTo-Json -Depth 8) | Set-Content -Path $cfgPath -Encoding UTF8

# 3) Escrever appsettings.json do agente (aponta pro hub LOCAL)
$agentDir = Join-Path $env:LOCALAPPDATA "ExpedAgent"
$appPath  = Join-Path $agentDir "appsettings.json"
if (Test-Path $appPath) {
  $app = Get-Content $appPath -Raw | ConvertFrom-Json
  $app.Agent.ApiBaseUrl = "http://127.0.0.1:3000"
  $app.Agent.DeviceToken = $token
  ($app | ConvertTo-Json -Depth 8) | Set-Content -Path $appPath -Encoding UTF8
}
Write-Host "Provisionamento concluído para a empresa: $($resp.empresaNome)"
```

- [ ] **Step 2: Commit**
```bash
git add hub/win/provision.ps1
git commit -m "feat(hub/win): provision.ps1 (resgata codigo e escreve config.json+appsettings.json)"
```

### Task 4.2: Instalador unificado `hub/win/exped-setup.iss`

**Files:**
- Create: `hub/win/exped-setup.iss` (parte do `exped-hub.iss` + parte do `agent/installer/ExpedAgent.iss`)

- [ ] **Step 1: Montar o `.iss` unificado** combinando:
  - `[Files]` do hub (payload do `exped-hub.iss`) **+** o publish do agente (`agent/installer/publish\*` → `{localappdata}\ExpedAgent`).
  - Uma **página de wizard custom** (Pascal `CreateInputQueryPage`) pedindo o **Código de instalação**, com um checkbox "modo manual (suporte)" que, marcado, mostra campos Token + URL.
  - No `[Run]` (após `install-service.ps1`), chamar:
    `powershell -ExecutionPolicy Bypass -File {app}\hub\win\provision.ps1 -Code "{code do wizard}"`
    (ou, no modo manual, escrever os configs direto com o token/URL digitados).
  - Autostart do agente (o `.vbs` na Startup, igual ao `ExpedAgent.iss` atual).

Skeleton da página + run (referência):
```pascal
var CodePage: TInputQueryWizardPage;
procedure InitializeWizard;
begin
  CodePage := CreateInputQueryPage(wpWelcome,
    'Código de instalação', 'Cole o código gerado no painel',
    'Ex.: EXPED-7K4P-2QXM');
  CodePage.Add('Código:', False);
end;
function GetCode(Param: String): String;
begin Result := Trim(CodePage.Values[0]); end;
```
```
[Run]
Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\hub\win\provision.ps1"" -Code ""{code:GetCode}"""; Flags: runhidden waituntilterminated; StatusMsg: "Provisionando..."
```
(O `{code:...}` usa um scripted constant que retorna `GetCode`.)

- [ ] **Step 2: Atualizar `hub/win/README.md`** com o fluxo por código (substitui a edição manual de JSON pela tela do código).

- [ ] **Step 3: Commit**
```bash
git add hub/win/exped-setup.iss hub/win/README.md
git commit -m "feat(hub/win): instalador unico (hub+agente) com wizard do codigo de instalacao"
```

### Task 4.3: Validação no Windows (checklist)

- [ ] No painel, gerar um código pra uma empresa de teste.
- [ ] Compilar `exped-setup.iss` (Inno Setup) → `ExpedSetup.exe`.
- [ ] Rodar como admin → digitar o código → concluir.
- [ ] Conferir: `C:\Exped\config.json` tem `cloud.apiBase` + `cloud.deviceToken`; `appsettings.json` do agente tem o mesmo token e `ApiBaseUrl=http://127.0.0.1:3000`.
- [ ] `sc query ExpedHub` = RUNNING; `http://127.0.0.1:3001/status` ok.
- [ ] Reusar o MESMO código → o painel/endpoint recusa (já usado). Gerar outro código funciona.
- [ ] Relatar resultado + `maestro.log` se algo falhar.

---

## FASE 5 — Agente .NET lê config remota

### Task 5.1: `RemoteConfigClient.cs` (cache + fallback)

**Files:**
- Create: `agent/ExpedAgent/RemoteConfigClient.cs`

- [ ] **Step 1: Implementar**

```csharp
using System.Net.Http.Json;
using Microsoft.Extensions.Logging;

namespace ExpedAgent;

public sealed record AgentRuntimeConfig(string SituacoesVenda, bool SyncOs, string SituacoesOs, int PollSegundos);

/// Busca a config do agente no hub local (/api/agent/config). Mantém o último valor
/// bom em memória; em falha, devolve o cache (ou os defaults do appsettings).
public sealed class RemoteConfigClient(HttpClient http, AgentConfig cfg, ILogger<RemoteConfigClient> log)
{
    private AgentRuntimeConfig? _cache;

    public async Task<AgentRuntimeConfig> GetAsync(CancellationToken ct)
    {
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, $"{cfg.ApiBaseUrl}/api/agent/config");
            req.Headers.Authorization = new("Bearer", cfg.DeviceToken);
            using var res = await http.SendAsync(req, ct);
            res.EnsureSuccessStatusCode();
            var dto = await res.Content.ReadFromJsonAsync<ConfigDto>(cancellationToken: ct)
                      ?? throw new InvalidOperationException("config vazia");
            _cache = new(dto.situacoesVenda ?? cfg.SituacoesGatilho, dto.syncOs,
                         dto.situacoesOs ?? "", dto.pollSegundos > 0 ? dto.pollSegundos : cfg.PollIntervalSeconds);
            return _cache;
        }
        catch (Exception e)
        {
            log.LogWarning("Falha ao ler /api/agent/config ({Msg}); usando cache/defaults.", e.Message);
            return _cache ?? new(cfg.SituacoesGatilho, cfg.SyncOs, cfg.SituacoesOsGatilho, cfg.PollIntervalSeconds);
        }
    }

    private sealed record ConfigDto(string? situacoesVenda, bool syncOs, string? situacoesOs, int pollSegundos);
}
```

- [ ] **Step 2: Registrar em `Program.cs`** — adicionar `builder.Services.AddSingleton<RemoteConfigClient>();` (e garantir `AddHttpClient` já existente cobre o tipo, ou `builder.Services.AddHttpClient<RemoteConfigClient>();`).

- [ ] **Step 3: Commit**
```bash
git add agent/ExpedAgent/RemoteConfigClient.cs agent/ExpedAgent/Program.cs
git commit -m "feat(agente): RemoteConfigClient le /api/agent/config (cache + fallback)"
```

### Task 5.2: `Worker.cs` aplica a config remota a cada ciclo

**Files:**
- Modify: `agent/ExpedAgent/Worker.cs`

- [ ] **Step 1: Injetar `RemoteConfigClient`** no construtor do `Worker` e, no início de cada iteração do loop (antes de `NovosPedidosAsync`), buscar a config e usar `SituacoesVenda`/`SyncOs`/`SituacoesOs`/`PollSegundos` no lugar dos campos fixos de `cfg`. Converter `SituacoesVenda`/`SituacoesOs` (CSV) em `short[]` (mesma lógica de `AgentConfig.SituacoesArray`, extraída pra um helper `ParseSituacoes(string)`).

```csharp
// no topo do loop:
var rc = await remote.GetAsync(ct);
var situacoesVenda = AgentConfig.ParseSituacoes(rc.SituacoesVenda);
var pollSegundos   = rc.PollSegundos;
// usar situacoesVenda em repo.NovosPedidosAsync(...) e rc.SyncOs/rc.SituacoesOs no fluxo de OS;
// usar pollSegundos no Task.Delay.
```
Extraia `ParseSituacoes` como `public static short[] ParseSituacoes(string csv)` em `AgentConfig` e faça `SituacoesArray => ParseSituacoes(SituacoesGatilho)` reusar ela (DRY).

- [ ] **Step 2: Build do agente** (no Windows): `dotnet build agent/ExpedAgent -c Release` → sem erros.

- [ ] **Step 3: Commit**
```bash
git add agent/ExpedAgent/Worker.cs agent/ExpedAgent/Config.cs
git commit -m "feat(agente): aplica config remota (situacoes/poll/OS) a cada ciclo"
```

### Task 5.3: Validação ponta-a-ponta (Windows)

- [ ] Mudar no painel `agente_situacoes_venda` da empresa → confirmar que o agente, no próximo ciclo, loga as novas situações (sem reinstalar).
- [ ] Ligar `agente_sync_os=true` + situações de OS → confirmar ingestão de OS.
- [ ] Desligar a internet → o agente segue com o último valor conhecido (fallback), sem travar.

---

## Self-Review (cobertura da spec)

- §5.1 banco → Tasks 1.1, 1.2, 1.3 ✓
- §5.2 geração do código → Task 1.4 ✓
- §5.3 endpoint redeem → Task 2.1 ✓
- §5.4 /api/agent/config → Task 2.2 ✓ ; agente lê → Tasks 5.1/5.2 ✓
- §5.5 painel (código + form) → Tasks 3.1/3.2/3.3 ✓
- §5.6 instalador único → Tasks 4.1/4.2 ✓
- §6 fluxo/ordenação (401 até sync) → coberto pelo fallback de auth do agente (retry por ciclo) ✓
- §7 segurança (uso único, TTL, hash, throttle, token só no resgate) → Tasks 1.3/2.1 ✓
- §8 erros → 2.1 (genérico+requestId/429/422), 4.1 (sem-net), 5.1 (fallback) ✓
- §10 testes → 1.4, 2.1, 2.2 (vitest); 4.3/5.3 (Windows) ✓

**Ordem de execução:** Fase 1 → 2 → 3 (tudo testável aqui, vitest verde) → 4 → 5 (validação Windows).
As Fases 1–3 entregam software testável sozinho (endpoints + painel); 4–5 dependem delas.
