# Fundação Multi-Tenant — Implementation Plan (Fase 0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transformar o app single-tenant da Franzoni em multi-tenant (várias empresas isoladas no mesmo banco), preservando os dados atuais da Franzoni como a primeira empresa, com base para white-label e para a frota de agentes (tokens por dispositivo).

**Architecture:** Cada usuário pertence a uma `empresa` (via `profiles.empresa_id`). Toda a RLS passa a filtrar por `current_empresa_id()` (derivado do profile do usuário logado) além do papel. Um `is_platform_admin` permite ao operador do produto (Excluvia) acesso cross-tenant para suporte/onboarding. Dispositivos (agentes Hiper) autenticam por token e carregam o `empresa_id` no qual gravam. Índices únicos globais (CNPJ do cliente, documento do pedido) viram únicos **por empresa**.

**Tech Stack:** Supabase (Postgres + RLS + triggers), Next.js 16 (App Router, server actions), TypeScript, Zod.

---

## Contexto / estado atual (leia antes)

- Tabelas: `profiles`, `pedidos`, `pedido_pontos_retirada`, `pedido_itens`, `pedido_logistica`, `pedido_eventos`, `pedido_comentarios`, `clientes`, `cliente_enderecos`.
- Enum `user_role` = `admin | vendedor | logistica`. Helper `current_user_role()` (security definer) lê `profiles.role`.
- RLS atual (resumo): admin tudo; vendedor seus pedidos (`vendedor_id=auth.uid()`); logística lê todos + muda status. Children (`pontos`, `itens`, `logistica`, `eventos`, `comentarios`) herdam via `EXISTS` em `pedidos`. `clientes`/`cliente_enderecos`: leitura/insert pra qualquer autenticado, update/delete só admin.
- Únicos GLOBAIS que viram por-empresa: `clientes_cnpj_cpf_uniq` (em `clientes.cnpj_cpf`), `pedidos_documento_erp_uniq` (em `pedidos.documento_erp`).
- `handle_new_user` cria `profiles` automaticamente ao criar `auth.users` (lê `role`/`full_name` do `raw_user_meta_data`).
- **Protocolo de migrations (CLAUDE.md) é obrigatório:** inventariar com `information_schema`, dry-run em `BEGIN; ... ROLLBACK;`, **≤100 linhas por migration**, uma coisa por vez, validar entre etapas, só commitar após validar em prod. Aplicar via MCP do **projeto Supabase do Franzoni** (confirmar qual antes — NÃO usar projeto de outro cliente).

## File Structure

**Criar (migrations):**
- `supabase/migrations/20260530000001_empresas.sql` — tabela `empresas` (tenant) + white-label + seed Franzoni + RLS.
- `supabase/migrations/20260530000002_profiles_empresa.sql` — `profiles.empresa_id` + `is_platform_admin` + helpers `current_empresa_id()`/`is_platform_admin()` + atualizar `handle_new_user` + backfill.
- `supabase/migrations/20260530000003_pedidos_empresa.sql` — `pedidos.empresa_id` + backfill + NOT NULL + índice; único `documento_erp` → por empresa.
- `supabase/migrations/20260530000004_clientes_empresa.sql` — `empresa_id` em `clientes` e `cliente_enderecos` + backfill + único `cnpj_cpf` → por empresa.
- `supabase/migrations/20260530000005_rls_multitenant_topo.sql` — RLS por empresa em `profiles`, `pedidos`, `clientes`, `cliente_enderecos`.
- `supabase/migrations/20260530000006_rls_multitenant_filhos.sql` — RLS por empresa nos filhos (`pontos`, `itens`, `logistica`, `eventos`, `comentarios`).
- `supabase/migrations/20260530000007_dispositivos.sql` — tabela `dispositivos` (token por máquina/agente).

**Criar (app):**
- `lib/empresa/current.ts` — `getEmpresaAtual(supabase)`: carrega a empresa do usuário logado (branding).
- `lib/empresa/actions.ts` — `criarEmpresaComAdminAction(...)` (só platform admin): cria empresa + 1º usuário admin.
- `lib/validators/empresa.ts` — schemas Zod.

**Modificar (app):**
- `components/layout/sidebar.tsx` e/ou `franzoni-logo.tsx` — nome/logo da empresa atual (white-label básico).
- `lib/types/database.ts` — regenerar tipos após as migrations (via MCP `generate_typescript_types`).

## Decisões de design (travadas)

- **Âncora do tenant:** `profiles.empresa_id`. RLS deriva `current_empresa_id()` dele. App de usuário **não** passa tenant explícito — vem da sessão. Só o endpoint de ingestão (service_role, Fase 1) seta `empresa_id` explicitamente a partir do token do dispositivo.
- **Platform admin:** `profiles.is_platform_admin` (boolean). Operador do produto vê/gere todos os tenants. Helper `is_platform_admin()`.
- **`empresa_id` só nas entidades de topo** (`profiles`, `pedidos`, `clientes`, `cliente_enderecos`). Filhos herdam via `EXISTS` no pedido (policies ganham a checagem de empresa). Evita coluna/backfill em tabela-filha.
- **Únicos por empresa:** `(empresa_id, cnpj_cpf)` e `(empresa_id, documento_erp)`.
- **White-label Fase 0 = nome + logo + slug + cor primária (dado).** Tematização dinâmica de cores em runtime (hoje `franzoni-orange` é token Tailwind hardcoded) fica como **follow-up (Fase 0b)** — não bloqueia a fundação.
- **Onboarding Fase 0 = ação server para platform admin criar empresa + 1º admin.** Signup self-service é Fase 3.

---

## Task 1: Migration `empresas`

**Files:** Create `supabase/migrations/20260530000001_empresas.sql`

- [ ] **Step 1: Inventariar**
```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema='public' AND table_name='empresas';
```
Esperado: 0 linhas.

- [ ] **Step 2: Escrever a migration**
```sql
-- 20260530000001_empresas.sql — tenants + white-label
create table if not exists public.empresas (
  id            uuid primary key default gen_random_uuid(),
  nome          text not null,
  slug          text not null unique,
  logo_url      text,
  cor_primaria  text default '#F25C05',           -- default = laranja Franzoni atual
  ativo         boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

drop trigger if exists set_empresas_updated_at on public.empresas;
create trigger set_empresas_updated_at
  before update on public.empresas
  for each row execute function public.set_updated_at();

-- Seed: Franzoni é a empresa #1. UUID fixo pra facilitar os backfills seguintes.
insert into public.empresas (id, nome, slug, cor_primaria)
values ('00000000-0000-0000-0000-0000000f0001', 'Franzoni Casa & Construção', 'franzoni', '#F25C05')
on conflict (id) do nothing;

alter table public.empresas enable row level security;
-- RLS definida na migration 05 (precisa dos helpers da migration 02 primeiro).
```

- [ ] **Step 3: Dry-run** (`BEGIN; <conteúdo> ROLLBACK;` via MCP). Esperado: sem erro.
- [ ] **Step 4: Aplicar** (`apply_migration` nome `empresas`). Validar:
```sql
SELECT id, nome, slug FROM public.empresas;
```
Esperado: 1 linha (Franzoni, id `...0f0001`).
- [ ] **Step 5: Commit**
```bash
git add supabase/migrations/20260530000001_empresas.sql
git commit -m "feat(db): tabela empresas (tenants) + seed Franzoni"
```

---

## Task 2: `profiles.empresa_id` + helpers + backfill

**Files:** Create `supabase/migrations/20260530000002_profiles_empresa.sql`

- [ ] **Step 1: Inventariar**
```sql
SELECT column_name FROM information_schema.columns
WHERE table_schema='public' AND table_name='profiles' AND column_name IN ('empresa_id','is_platform_admin');
```
Esperado: 0 linhas.

- [ ] **Step 2: Escrever a migration**
```sql
-- 20260530000002_profiles_empresa.sql
alter table public.profiles
  add column if not exists empresa_id uuid references public.empresas(id) on delete restrict,
  add column if not exists is_platform_admin boolean not null default false;

-- Backfill: todos os profiles atuais são da Franzoni
update public.profiles
  set empresa_id = '00000000-0000-0000-0000-0000000f0001'
  where empresa_id is null;

create index if not exists profiles_empresa_idx on public.profiles(empresa_id);

-- Helpers (security definer, search_path fixo)
create or replace function public.current_empresa_id()
returns uuid language sql stable security definer set search_path = public as $$
  select empresa_id from public.profiles where id = auth.uid()
$$;

create or replace function public.is_platform_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_platform_admin from public.profiles where id = auth.uid()), false)
$$;

-- handle_new_user passa a ler empresa_id do metadata (signup/onboarding define)
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name, role, empresa_id)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    coalesce((new.raw_user_meta_data->>'role')::user_role, 'vendedor'),
    (new.raw_user_meta_data->>'empresa_id')::uuid
  )
  on conflict (id) do nothing;
  return new;
end $$;
```

- [ ] **Step 3: Dry-run.** Esperado: sem erro.
- [ ] **Step 4: Aplicar** (nome `profiles_empresa`). Validar:
```sql
SELECT count(*) total, count(empresa_id) com_empresa FROM public.profiles;
```
Esperado: `total = com_empresa` (todos preenchidos).
- [ ] **Step 5: (opcional) marcar você como platform admin**
```sql
-- substitua pelo seu e-mail de operador
update public.profiles set is_platform_admin = true
where email = 'gestao@excluvia.com.br';
```
- [ ] **Step 6: Commit**
```bash
git add supabase/migrations/20260530000002_profiles_empresa.sql
git commit -m "feat(db): profiles.empresa_id + is_platform_admin + helpers de tenant"
```

---

## Task 3: `pedidos.empresa_id` + único por empresa

**Files:** Create `supabase/migrations/20260530000003_pedidos_empresa.sql`

- [ ] **Step 1: Inventariar** o índice único atual de documento:
```sql
SELECT indexname, indexdef FROM pg_indexes
WHERE schemaname='public' AND tablename='pedidos' AND indexname LIKE '%documento%';
```
Anote o `indexdef` (confirmar nome `pedidos_documento_erp_uniq`).

- [ ] **Step 2: Escrever a migration**
```sql
-- 20260530000003_pedidos_empresa.sql
alter table public.pedidos
  add column if not exists empresa_id uuid references public.empresas(id) on delete restrict;

update public.pedidos
  set empresa_id = '00000000-0000-0000-0000-0000000f0001'
  where empresa_id is null;

alter table public.pedidos alter column empresa_id set not null;
create index if not exists pedidos_empresa_idx on public.pedidos(empresa_id);

-- documento único POR EMPRESA (antes era global)
drop index if exists public.pedidos_documento_erp_uniq;
create unique index pedidos_documento_erp_uniq
  on public.pedidos (empresa_id, documento_erp)
  where documento_erp is not null;
```

- [ ] **Step 3: Dry-run.** Esperado: sem erro (se o `drop index` reclamar de constraint, troque por `alter table public.pedidos drop constraint if exists pedidos_documento_erp_uniq;`).
- [ ] **Step 4: Aplicar** (nome `pedidos_empresa`). Validar:
```sql
SELECT count(*) total, count(empresa_id) com_empresa FROM public.pedidos;
SELECT indexdef FROM pg_indexes WHERE indexname='pedidos_documento_erp_uniq';
```
Esperado: todos com empresa; índice agora em `(empresa_id, documento_erp)`.
- [ ] **Step 5: Commit**
```bash
git add supabase/migrations/20260530000003_pedidos_empresa.sql
git commit -m "feat(db): pedidos.empresa_id + documento único por empresa"
```

---

## Task 4: `empresa_id` em `clientes` e `cliente_enderecos`

**Files:** Create `supabase/migrations/20260530000004_clientes_empresa.sql`

- [ ] **Step 1: Inventariar** o único de cnpj:
```sql
SELECT indexname, indexdef FROM pg_indexes
WHERE schemaname='public' AND tablename='clientes' AND indexname LIKE '%cnpj%';
```

- [ ] **Step 2: Escrever a migration**
```sql
-- 20260530000004_clientes_empresa.sql
alter table public.clientes
  add column if not exists empresa_id uuid references public.empresas(id) on delete restrict;
update public.clientes set empresa_id = '00000000-0000-0000-0000-0000000f0001' where empresa_id is null;
alter table public.clientes alter column empresa_id set not null;
create index if not exists clientes_empresa_idx on public.clientes(empresa_id);

-- cnpj_cpf único POR EMPRESA
drop index if exists public.clientes_cnpj_cpf_uniq;
create unique index clientes_cnpj_cpf_uniq
  on public.clientes (empresa_id, cnpj_cpf) where cnpj_cpf is not null;

-- cliente_enderecos herda a empresa do cliente
alter table public.cliente_enderecos
  add column if not exists empresa_id uuid references public.empresas(id) on delete restrict;
update public.cliente_enderecos ce
  set empresa_id = c.empresa_id
  from public.clientes c where c.id = ce.cliente_id and ce.empresa_id is null;
alter table public.cliente_enderecos alter column empresa_id set not null;
create index if not exists cliente_enderecos_empresa_idx on public.cliente_enderecos(empresa_id);
```

- [ ] **Step 3: Dry-run.** Esperado: sem erro.
- [ ] **Step 4: Aplicar** (nome `clientes_empresa`). Validar:
```sql
SELECT (SELECT count(*) FROM clientes WHERE empresa_id IS NULL) clientes_sem,
       (SELECT count(*) FROM cliente_enderecos WHERE empresa_id IS NULL) end_sem;
```
Esperado: ambos 0.
- [ ] **Step 5: Commit**
```bash
git add supabase/migrations/20260530000004_clientes_empresa.sql
git commit -m "feat(db): empresa_id em clientes e cliente_enderecos + cnpj único por empresa"
```

---

## Task 5: RLS por empresa — entidades de topo

**Files:** Create `supabase/migrations/20260530000005_rls_multitenant_topo.sql`

> Regra geral nova: cada policy = (condição de papel já existente) **AND** (`empresa_id = current_empresa_id()`), **OR** `is_platform_admin()`.

- [ ] **Step 1: Escrever a migration**
```sql
-- 20260530000005_rls_multitenant_topo.sql

-- empresas: membro lê a sua; platform admin tudo
drop policy if exists empresas_member_read on public.empresas;
create policy empresas_member_read on public.empresas for select to authenticated
  using (id = public.current_empresa_id() or public.is_platform_admin());
drop policy if exists empresas_platform_all on public.empresas;
create policy empresas_platform_all on public.empresas for all to authenticated
  using (public.is_platform_admin()) with check (public.is_platform_admin());

-- profiles
drop policy if exists "profiles_self_read" on public.profiles;
create policy "profiles_self_read" on public.profiles for select using (
  public.is_platform_admin()
  or id = auth.uid()
  or (current_user_role() = 'admin' and empresa_id = public.current_empresa_id())
);
drop policy if exists "profiles_admin_all" on public.profiles;
create policy "profiles_admin_all" on public.profiles for all using (
  public.is_platform_admin()
  or (current_user_role() = 'admin' and empresa_id = public.current_empresa_id())
) with check (
  public.is_platform_admin()
  or (current_user_role() = 'admin' and empresa_id = public.current_empresa_id())
);
-- (profiles_self_update permanece igual)

-- pedidos
drop policy if exists "pedidos_read" on public.pedidos;
create policy "pedidos_read" on public.pedidos for select using (
  public.is_platform_admin()
  or (empresa_id = public.current_empresa_id()
      and (current_user_role() in ('admin','logistica') or vendedor_id = auth.uid()))
);
drop policy if exists "pedidos_vendedor_iu" on public.pedidos;
create policy "pedidos_vendedor_iu" on public.pedidos for insert with check (
  empresa_id = public.current_empresa_id()
  and current_user_role() = 'vendedor' and vendedor_id = auth.uid()
);
drop policy if exists "pedidos_vendedor_update" on public.pedidos;
create policy "pedidos_vendedor_update" on public.pedidos for update
  using (empresa_id = public.current_empresa_id() and current_user_role() = 'vendedor'
         and vendedor_id = auth.uid() and status in ('rascunho','pendente'))
  with check (empresa_id = public.current_empresa_id() and current_user_role() = 'vendedor'
         and vendedor_id = auth.uid() and status in ('rascunho','pendente','cancelado'));
drop policy if exists "pedidos_logistica_u" on public.pedidos;
create policy "pedidos_logistica_u" on public.pedidos for update
  using (empresa_id = public.current_empresa_id() and current_user_role() = 'logistica')
  with check (empresa_id = public.current_empresa_id() and current_user_role() = 'logistica');
drop policy if exists "pedidos_admin_all" on public.pedidos;
create policy "pedidos_admin_all" on public.pedidos for all using (
  public.is_platform_admin() or (empresa_id = public.current_empresa_id() and current_user_role() = 'admin')
) with check (
  public.is_platform_admin() or (empresa_id = public.current_empresa_id() and current_user_role() = 'admin')
);

-- clientes
drop policy if exists clientes_read on public.clientes;
create policy clientes_read on public.clientes for select to authenticated
  using (public.is_platform_admin() or empresa_id = public.current_empresa_id());
drop policy if exists clientes_insert on public.clientes;
create policy clientes_insert on public.clientes for insert to authenticated
  with check (empresa_id = public.current_empresa_id());
drop policy if exists clientes_admin_update on public.clientes;
create policy clientes_admin_update on public.clientes for update to authenticated
  using (empresa_id = public.current_empresa_id() and current_user_role() = 'admin')
  with check (empresa_id = public.current_empresa_id() and current_user_role() = 'admin');
drop policy if exists clientes_admin_delete on public.clientes;
create policy clientes_admin_delete on public.clientes for delete to authenticated
  using (empresa_id = public.current_empresa_id() and current_user_role() = 'admin');

-- cliente_enderecos
drop policy if exists enderecos_read on public.cliente_enderecos;
create policy enderecos_read on public.cliente_enderecos for select
  using (public.is_platform_admin() or empresa_id = public.current_empresa_id());
drop policy if exists enderecos_insert on public.cliente_enderecos;
create policy enderecos_insert on public.cliente_enderecos for insert
  with check (empresa_id = public.current_empresa_id());
drop policy if exists enderecos_update on public.cliente_enderecos;
create policy enderecos_update on public.cliente_enderecos for update
  using (empresa_id = public.current_empresa_id() and public.current_user_role() = 'admin')
  with check (empresa_id = public.current_empresa_id() and public.current_user_role() = 'admin');
drop policy if exists enderecos_delete on public.cliente_enderecos;
create policy enderecos_delete on public.cliente_enderecos for delete
  using (empresa_id = public.current_empresa_id() and public.current_user_role() = 'admin');
```

- [ ] **Step 2: Dry-run.** Esperado: sem erro.
- [ ] **Step 3: Aplicar** (nome `rls_multitenant_topo`).
- [ ] **Step 4: Validar isolamento** — logado como usuário Franzoni, `SELECT count(*) FROM pedidos;` deve mostrar os pedidos da Franzoni (não muda nada hoje, pois só há 1 empresa). Teste real de isolamento na Task 8.
- [ ] **Step 5: Commit**
```bash
git add supabase/migrations/20260530000005_rls_multitenant_topo.sql
git commit -m "feat(db): RLS por empresa nas entidades de topo + platform admin"
```

---

## Task 6: RLS por empresa — tabelas-filhas

**Files:** Create `supabase/migrations/20260530000006_rls_multitenant_filhos.sql`

> Cada filho herda via `EXISTS` no pedido; adicionamos `p.empresa_id = current_empresa_id()` (com `OR is_platform_admin()`).

- [ ] **Step 1: Escrever a migration**
```sql
-- 20260530000006_rls_multitenant_filhos.sql

drop policy if exists "pontos_via_pedido" on public.pedido_pontos_retirada;
create policy "pontos_via_pedido" on public.pedido_pontos_retirada for all using (
  public.is_platform_admin() or exists (
    select 1 from public.pedidos p where p.id = pedido_id
      and p.empresa_id = public.current_empresa_id()
      and (current_user_role() in ('admin','logistica') or p.vendedor_id = auth.uid()))
) with check (
  public.is_platform_admin() or exists (
    select 1 from public.pedidos p where p.id = pedido_id
      and p.empresa_id = public.current_empresa_id()
      and (current_user_role() in ('admin','logistica') or p.vendedor_id = auth.uid()))
);

drop policy if exists "itens_via_ponto" on public.pedido_itens;
create policy "itens_via_ponto" on public.pedido_itens for all using (
  public.is_platform_admin() or exists (
    select 1 from public.pedido_pontos_retirada pr
    join public.pedidos p on p.id = pr.pedido_id
    where pr.id = ponto_retirada_id and p.empresa_id = public.current_empresa_id()
      and (current_user_role() in ('admin','logistica') or p.vendedor_id = auth.uid()))
) with check (
  public.is_platform_admin() or exists (
    select 1 from public.pedido_pontos_retirada pr
    join public.pedidos p on p.id = pr.pedido_id
    where pr.id = ponto_retirada_id and p.empresa_id = public.current_empresa_id()
      and (current_user_role() in ('admin','logistica') or p.vendedor_id = auth.uid()))
);

drop policy if exists "logistica_read" on public.pedido_logistica;
create policy "logistica_read" on public.pedido_logistica for select using (
  public.is_platform_admin() or exists (
    select 1 from public.pedidos p where p.id = pedido_id
      and p.empresa_id = public.current_empresa_id()
      and (current_user_role() in ('admin','logistica') or p.vendedor_id = auth.uid()))
);
drop policy if exists "logistica_write" on public.pedido_logistica;
create policy "logistica_write" on public.pedido_logistica for all
  using (public.is_platform_admin() or (current_user_role() in ('admin','logistica')
    and exists (select 1 from public.pedidos p where p.id = pedido_id and p.empresa_id = public.current_empresa_id())))
  with check (public.is_platform_admin() or (current_user_role() in ('admin','logistica')
    and exists (select 1 from public.pedidos p where p.id = pedido_id and p.empresa_id = public.current_empresa_id())));

drop policy if exists "eventos_read" on public.pedido_eventos;
create policy "eventos_read" on public.pedido_eventos for select using (
  public.is_platform_admin() or exists (
    select 1 from public.pedidos p where p.id = pedido_id
      and p.empresa_id = public.current_empresa_id()
      and (current_user_role() in ('admin','logistica') or p.vendedor_id = auth.uid()))
);
drop policy if exists "eventos_insert" on public.pedido_eventos;
create policy "eventos_insert" on public.pedido_eventos for insert with check (
  public.is_platform_admin() or exists (
    select 1 from public.pedidos p where p.id = pedido_id
      and p.empresa_id = public.current_empresa_id()
      and (current_user_role() in ('admin','logistica') or p.vendedor_id = auth.uid()))
);

drop policy if exists comentarios_read on public.pedido_comentarios;
create policy comentarios_read on public.pedido_comentarios for select to authenticated using (
  public.is_platform_admin() or exists (
    select 1 from public.pedidos p where p.id = pedido_comentarios.pedido_id
      and p.empresa_id = public.current_empresa_id())
);
drop policy if exists comentarios_insert on public.pedido_comentarios;
create policy comentarios_insert on public.pedido_comentarios for insert to authenticated with check (
  autor_id = auth.uid() and exists (
    select 1 from public.pedidos p where p.id = pedido_comentarios.pedido_id
      and p.empresa_id = public.current_empresa_id())
);
-- comentarios_delete permanece (autor ou admin)
```

- [ ] **Step 2: Dry-run + aplicar** (nome `rls_multitenant_filhos`). Validar que o app da Franzoni continua funcionando (abrir um pedido, ver pontos/itens/comentários).
- [ ] **Step 3: Commit**
```bash
git add supabase/migrations/20260530000006_rls_multitenant_filhos.sql
git commit -m "feat(db): RLS por empresa nas tabelas-filhas do pedido"
```

---

## Task 7: Tabela `dispositivos` (token por agente)

**Files:** Create `supabase/migrations/20260530000007_dispositivos.sql`

- [ ] **Step 1: Escrever a migration**
```sql
-- 20260530000007_dispositivos.sql — agentes Hiper por empresa
create table if not exists public.dispositivos (
  id            uuid primary key default gen_random_uuid(),
  empresa_id    uuid not null references public.empresas(id) on delete cascade,
  nome          text not null,                 -- ex.: "PDV Loja Centro"
  token_hash    text not null unique,          -- hash do token (nunca o token cru)
  ativo         boolean not null default true,
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists dispositivos_empresa_idx on public.dispositivos(empresa_id);

alter table public.dispositivos enable row level security;
-- Admin da empresa lê os seus; platform admin tudo. Escrita: platform admin
-- (geração de token é operação de onboarding). O endpoint de ingestão usa
-- service_role e ignora RLS.
drop policy if exists dispositivos_read on public.dispositivos;
create policy dispositivos_read on public.dispositivos for select to authenticated using (
  public.is_platform_admin()
  or (empresa_id = public.current_empresa_id() and public.current_user_role() = 'admin')
);
drop policy if exists dispositivos_platform_write on public.dispositivos;
create policy dispositivos_platform_write on public.dispositivos for all to authenticated
  using (public.is_platform_admin()) with check (public.is_platform_admin());
```

- [ ] **Step 2: Dry-run + aplicar** (nome `dispositivos`). Validar colunas com `information_schema.columns`.
- [ ] **Step 3: Regenerar tipos TS**

Via MCP `generate_typescript_types` do projeto Franzoni → salvar em `lib/types/database.ts`. Rode `npm run typecheck` (deve passar; novas tabelas/colunas aparecem).
- [ ] **Step 4: Commit**
```bash
git add supabase/migrations/20260530000007_dispositivos.sql lib/types/database.ts
git commit -m "feat(db): tabela dispositivos (tokens de agente por empresa) + typegen"
```

---

## Task 8: Teste de isolamento entre empresas (SQL)

> Sem código novo — validação crítica de que a RLS isola. Use o SQL editor / MCP `execute_sql`.

- [ ] **Step 1: Criar uma 2ª empresa + 1 pedido fake nela**
```sql
insert into public.empresas (id, nome, slug)
values ('00000000-0000-0000-0000-0000000f0002','Empresa Teste','teste') on conflict do nothing;
```
- [ ] **Step 2: Verificar contagem por empresa (como service_role, vê tudo)**
```sql
select empresa_id, count(*) from public.pedidos group by 1;
```
Esperado: só a Franzoni tem pedidos (a Teste tem 0). Confirma que o backfill não vazou.
- [ ] **Step 3: (manual no app)** logar como usuário Franzoni e confirmar que tudo aparece normal; nenhum dado da "Empresa Teste" aparece. Documentar OK.
- [ ] **Step 4: Limpar a empresa de teste**
```sql
delete from public.empresas where id='00000000-0000-0000-0000-0000000f0002';
```

---

## Task 9: Loader da empresa atual + white-label básico

**Files:** Create `lib/empresa/current.ts`; Modify `components/layout/sidebar.tsx` (ou `franzoni-logo.tsx`)

- [ ] **Step 1: `lib/empresa/current.ts`**
```ts
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/types/database';

export type EmpresaAtual = {
  id: string; nome: string; slug: string; logo_url: string | null; cor_primaria: string | null;
};

/** Carrega a empresa do usuário logado (branding). Null se não logado. */
export async function getEmpresaAtual(
  supabase: SupabaseClient<Database>,
): Promise<EmpresaAtual | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: prof } = await supabase
    .from('profiles').select('empresa_id').eq('id', user.id).single();
  if (!prof?.empresa_id) return null;
  const { data: emp } = await supabase
    .from('empresas').select('id, nome, slug, logo_url, cor_primaria')
    .eq('id', prof.empresa_id).single();
  return (emp as EmpresaAtual) ?? null;
}
```

- [ ] **Step 2: Usar no layout** — em `components/layout/sidebar.tsx`, onde hoje aparece o nome/logo fixo "Franzoni", receber `empresa` por prop (carregada no server layout via `getEmpresaAtual`) e exibir `empresa?.nome` / `empresa?.logo_url`. Fallback para o logo atual quando `null`.

> Localize o ponto de uso: `grep -n "Franzoni" components/layout/sidebar.tsx components/franzoni-logo.tsx`. Passe `empresa` do Server Component pai (`app/(app)/layout.tsx`) que já tem o supabase server client.

- [ ] **Step 3: Typecheck + build**

Run: `npm run typecheck && npm run build`. Esperado: PASS.
- [ ] **Step 4: Commit**
```bash
git add lib/empresa/current.ts components/layout/sidebar.tsx "app/(app)/layout.tsx"
git commit -m "feat(white-label): carrega nome/logo da empresa atual no layout"
```

> **Follow-up Fase 0b (não bloqueia):** cor primária dinâmica. Hoje `franzoni-orange` é token Tailwind fixo. Para tematizar por tenant, injetar `--cor-primaria` (de `empresa.cor_primaria`) como CSS var no `<html>` e migrar usos de `franzoni-orange` para a var. Tarefa separada.

---

## Task 10: Onboarding — criar empresa + 1º admin (platform admin)

**Files:** Create `lib/validators/empresa.ts`, `lib/empresa/actions.ts`

- [ ] **Step 1: `lib/validators/empresa.ts`**
```ts
import { z } from 'zod';
export const novaEmpresaSchema = z.object({
  nome: z.string().min(1).max(200),
  slug: z.string().min(2).max(60).regex(/^[a-z0-9-]+$/, 'slug: minúsculas, números e hífen'),
  admin_email: z.string().email(),
  admin_nome: z.string().min(1).max(200),
});
export type NovaEmpresaInput = z.infer<typeof novaEmpresaSchema>;
```

- [ ] **Step 2: `lib/empresa/actions.ts` (server action, só platform admin)**
```ts
'use server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { novaEmpresaSchema, type NovaEmpresaInput } from '@/lib/validators/empresa';

export async function criarEmpresaComAdminAction(input: NovaEmpresaInput) {
  // 1) Confirmar que quem chama é platform admin
  const supa = await createClient();
  const { data: { user } } = await supa.auth.getUser();
  if (!user) return { error: 'Não autenticado' };
  const { data: me } = await supa.from('profiles').select('is_platform_admin').eq('id', user.id).single();
  if (!me?.is_platform_admin) return { error: 'Apenas operador da plataforma' };

  const parsed = novaEmpresaSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos' };
  const d = parsed.data;

  const admin = createAdminClient();
  // 2) Cria empresa
  const { data: emp, error: e1 } = await admin
    .from('empresas').insert({ nome: d.nome, slug: d.slug }).select('id').single();
  if (e1 || !emp) return { error: e1?.message ?? 'Falha ao criar empresa' };

  // 3) Convida o 1º usuário. SEGURANÇA: NÃO passamos role/empresa_id no metadata
  //    (handle_new_user ignora metadata de propósito — ver fix de segurança).
  //    O profile nasce com empresa_id=NULL e role='vendedor'.
  const { data: invited, error: e2 } = await admin.auth.admin.inviteUserByEmail(d.admin_email, {
    data: { full_name: d.admin_nome },
  });
  if (e2 || !invited?.user) return { error: `Empresa criada, mas convite falhou: ${e2?.message}` };

  // 4) Atribui empresa + role via service_role (trigger anti-escalonamento permite
  //    porque auth.uid() é null nesse contexto de servidor confiável).
  const { error: e3 } = await admin
    .from('profiles')
    .update({ empresa_id: emp.id as string, role: 'admin' })
    .eq('id', invited.user.id);
  if (e3) return { error: `Empresa/convite OK, mas atribuição de admin falhou: ${e3.message}` };

  return { ok: true as const, empresa_id: emp.id as string };
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`. Esperado: PASS.
> Nota: o `inviteUserByEmail` requer SMTP configurado no Supabase. Se não houver, trocar por `admin.auth.admin.createUser({ email, email_confirm: true, user_metadata: {...} })` e enviar reset de senha.
- [ ] **Step 4: Commit**
```bash
git add lib/validators/empresa.ts lib/empresa/actions.ts
git commit -m "feat(onboarding): criar empresa + 1º admin (platform admin)"
```

---

## Self-Review (cobertura)

- Multi-tenancy de dados (empresa_id + RLS por empresa): Tasks 1–6. ✓
- Isolamento validado: Task 8. ✓
- Platform admin (operador cross-tenant): Task 2 + policies. ✓
- Únicos por empresa (cnpj, documento): Tasks 3–4. ✓
- Tokens por dispositivo (base da frota): Task 7. ✓
- White-label (nome/logo): Task 9 (cores → Fase 0b). ✓
- Onboarding (criar tenant): Task 10 (self-service → Fase 3). ✓

**Rebase da Fase 1 (Ingestão Hiper) após esta fundação:**
- Endpoint `/api/ingest/pedido` autentica por **token do dispositivo** (consulta `dispositivos.token_hash`, pega `empresa_id`, atualiza `last_seen_at`) em vez de `HIPER_INGEST_SECRET` único.
- `inserirPedido` e a dedup por `documento_erp` passam a filtrar/gravar `empresa_id`.
- `hiper_vendedor_map` ganha `empresa_id` (mapa de vendedor por empresa).

**Type consistency:** helpers `current_empresa_id()` / `is_platform_admin()` usados igual em todas as policies; UUID fixo da Franzoni `00000000-0000-0000-0000-0000000f0001` usado em todos os backfills.

**Pendências de config:** marcar o operador como `is_platform_admin` (Task 2 Step 5); SMTP no Supabase para convites (Task 10).
```
