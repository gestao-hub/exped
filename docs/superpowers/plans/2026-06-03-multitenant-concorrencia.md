# Multi-tenant + Concorrência — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sustentar muitas lojas + muitos usuários: realtime escopado por empresa, busca trigram por-tenant, cache dos dados quase-estáticos lidos em toda navegação, e higiene de índice/RLS.

**Architecture:** Migrations aditivas (btree_gin + trgm com empresa_id; índice faltante; RPCs com empresa_id explícito). Cache: `React.cache()` por-request (getUser/profiles) + `unstable_cache` (config da empresa). Realtime: filtro `empresa_id` + nome dinâmico + debounce.

**Tech Stack:** Postgres/Supabase, Next.js 16 (React.cache/unstable_cache), supabase-realtime-js, Vitest.

**Spec:** [docs/superpowers/specs/2026-06-03-multitenant-concorrencia-design.md](../specs/2026-06-03-multitenant-concorrencia-design.md)

**Ajuste de escopo vs spec:** cache cross-request dos KPIs do Admin DEFERIDO (cachear agregação session-RLS com segurança exige refatorar as RPCs p/ receber empresa_id sem leak; admin = público pequeno). No lugar: `empresa_id` explícito nas RPCs (planner usa índice composto). O cache que atinge TODO usuário (dedup + config) fica.

**Deploy:** SQL → nuvem (usuário) ANTES do push; hub via migration no reinstall; app via Vercel.

---

## Task 1: Migration — busca trigram por-tenant + higiene de índice

**Files:**
- Create: `supabase/migrations/20260603180000_multitenant_indices.sql`

- [ ] **Step 1: Confirmar que os índices simples antigos NÃO são usados isoladamente** (antes de dropar)

Run: `cd /root/exped && grep -rn "pedidos_status_idx\|pedidos_bairro_idx\|pedidos_data_entrega_idx" --include=*.ts --include=*.tsx --include=*.sql . | grep -v "20260518000003"`
Expected: só referências em migrations de criação (nenhum código depende do nome). As queries do app sempre filtram empresa (RLS) → cobertas pelos compostos `(empresa_id, status, data_entrega)` e `(empresa_id, created_at/updated_at)`. Se aparecer uso explícito do nome, NÃO dropar e reportar.

- [ ] **Step 2: Escrever a migration**

```sql
-- 20260603180000_multitenant_indices.sql — busca trigram escopada por empresa + higiene (aditivo).
create extension if not exists btree_gin;

-- Recria os índices de busca incluindo empresa_id (prefixo btree) → poda por tenant antes do GIN.
drop index if exists public.pedidos_search_trgm_idx;
create index pedidos_search_trgm_idx on public.pedidos
  using gin (empresa_id, (coalesce(cliente_nome,'') || ' ' || coalesce(documento_erp,'') || ' ' || coalesce(cliente_bairro,'')) gin_trgm_ops);

drop index if exists public.clientes_nome_trgm;
create index clientes_nome_trgm on public.clientes
  using gin (empresa_id, nome gin_trgm_ops);

-- Índice faltante (RLS de cliente_enderecos filtra empresa_id, sem índice de apoio).
create index if not exists cliente_enderecos_empresa_idx on public.cliente_enderecos (empresa_id);

-- Higiene: dropa índices de coluna única pré-multitenant (cobertos pelos compostos; evita o
-- planner cruzar tenants por esses paths).
drop index if exists public.pedidos_status_idx;
drop index if exists public.pedidos_bairro_idx;
drop index if exists public.pedidos_data_entrega_idx;
```

- [ ] **Step 3: Validar sintaxe**

Run: `node -e "const s=require('fs').readFileSync('supabase/migrations/20260603180000_multitenant_indices.sql','utf8'); if(!/btree_gin/.test(s)) throw new Error('sem btree_gin'); if((s.match(/gin \(empresa_id/g)||[]).length!==2) throw new Error('esperava 2 indices gin com empresa_id'); console.log('OK multitenant indices')"`
Expected: `OK multitenant indices`

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260603180000_multitenant_indices.sql
git commit -m "perf(multitenant): trgm por-tenant (btree_gin) + cliente_enderecos idx + dropa indices simples antigos"
```

---

## Task 2: Migration — RPCs de KPI com `empresa_id` explícito

**Files:**
- Create: `supabase/migrations/20260603180100_kpis_empresa_explicito.sql`

- [ ] **Step 1: Escrever a migration** (CREATE OR REPLACE com o predicado explícito; mantém SECURITY INVOKER)

```sql
-- 20260603180100_kpis_empresa_explicito.sql — empresa_id explícito no WHERE das RPCs de KPI
-- pra o planner enxergar o predicado e usar os índices compostos (empresa_id, ...). INVOKER:
-- current_empresa_id() roda como o usuário (mesma segurança de antes — não muda escopo).
create or replace function public.historico_kpis()
returns table (pedidos_finalizados bigint, valor_faturado numeric, clientes_unicos bigint)
language sql stable security invoker as $$
  select count(*)::bigint, coalesce(sum(valor_total),0)::numeric, count(distinct cliente_nome)::bigint
  from public.pedidos
  where empresa_id = public.current_empresa_id() and status='finalizado' and deleted_at is null;
$$;

create or replace function public.admin_top_clientes(p_limit int default 10)
returns table (cliente_nome text, total numeric, pedidos bigint)
language sql stable security invoker as $$
  select cliente_nome, sum(valor_total)::numeric, count(*)::bigint from public.pedidos
  where empresa_id = public.current_empresa_id() and status='finalizado' and deleted_at is null and cliente_nome is not null
  group by cliente_nome order by 2 desc limit greatest(1, least(p_limit,100));
$$;

create or replace function public.admin_top_bairros(p_limit int default 10)
returns table (cliente_bairro text, pedidos bigint)
language sql stable security invoker as $$
  select cliente_bairro, count(*)::bigint from public.pedidos
  where empresa_id = public.current_empresa_id() and deleted_at is null and cliente_bairro is not null
  group by cliente_bairro order by 2 desc limit greatest(1, least(p_limit,100));
$$;

create or replace function public.admin_tempo_medio_horas()
returns numeric language sql stable security invoker as $$
  select avg(extract(epoch from (ev.created_at - p.created_at)) / 3600.0)::numeric
  from public.pedido_eventos ev
  join public.pedidos p on p.id = ev.pedido_id
  where p.empresa_id = public.current_empresa_id()
    and ev.tipo = 'status_change' and (ev.payload->>'to') = 'finalizado' and p.deleted_at is null;
$$;
```

- [ ] **Step 2: Validar + commit**

Run: `node -e "const s=require('fs').readFileSync('supabase/migrations/20260603180100_kpis_empresa_explicito.sql','utf8'); if((s.match(/empresa_id = public.current_empresa_id\(\)/g)||[]).length!==4) throw new Error('esperava 4 predicados de empresa'); console.log('OK kpis empresa explicito')"`
```bash
git add supabase/migrations/20260603180100_kpis_empresa_explicito.sql
git commit -m "perf(kpi): empresa_id explicito no WHERE das RPCs (planner usa indice composto)"
```

---

## Task 3: Cache — `React.cache` (getUser/profiles) + config da empresa

**Files:**
- Create: `lib/auth/cached.ts`
- Modify: `lib/auth/require-role.ts`, `lib/empresa/current.ts`, `app/(app)/configuracoes/actions.ts`

- [ ] **Step 1: Criar `lib/auth/cached.ts`** (dedup por-request)

```ts
import { cache } from 'react';
import { unstable_cache } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/server';

/** getUser deduplicado dentro do mesmo render (layout + páginas + helpers chamam 1x só). */
export const getAuthUserCached = cache(async () => {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  return data.user ?? null;
});

/** profile do usuário, deduplicado por-request. */
export const getProfileCached = cache(async (userId: string) => {
  const supabase = await createClient();
  const { data } = await supabase.from('profiles').select('*').eq('id', userId).single();
  return data ?? null;
});

/**
 * Config da empresa (white-label) — quase-estática, lida em TODA navegação. Cache
 * cross-request 10min via unstable_cache; service_role (sem cookies → cacheável; dado
 * não-sensível, escopado pelo empresaId da chave). Invalida em configuracoes/actions.
 */
export const getEmpresaConfigCached = (empresaId: string) =>
  unstable_cache(
    async () => {
      const sb = createServiceRoleClient();
      const { data } = await sb
        .from('empresas')
        .select('id, nome, slug, logo_url, cor_primaria, usa_os')
        .eq('id', empresaId)
        .single();
      return data ?? null;
    },
    ['empresa-config', empresaId],
    { revalidate: 600, tags: [`empresa-${empresaId}`] },
  )();
```

- [ ] **Step 2: `require-role.ts` usa os cached**

LER o arquivo. Trocar o corpo de `requireRole` pra usar `getAuthUserCached()` (em vez de `supabase.auth.getUser()`) e `getProfileCached(user.id)` (em vez do `.from('profiles')...`), mantendo os redirects iguais. Import no topo: `import { getAuthUserCached, getProfileCached } from '@/lib/auth/cached';`. Remover o `createClient` se não usado mais.

- [ ] **Step 3: `lib/empresa/current.ts` usa cached + config cacheada**

LER o arquivo. Reescrever `getEmpresaAtual` pra: usar `getAuthUserCached()` + `getProfileCached(user.id)` pra obter o `empresa_id`, e então `return getEmpresaConfigCached(empresaId)`. A assinatura pode perder o param `supabase` (não usa mais cookies pro config). Ajustar o chamador no layout. Import: `import { getAuthUserCached, getProfileCached, getEmpresaConfigCached } from '@/lib/auth/cached';`.

- [ ] **Step 4: Invalidação no save da empresa** (`configuracoes/actions.ts`)

LER o arquivo. Onde houver `await ...update(...).eq('id', c.empresaId)` em `empresas` seguido de `revalidatePath('/configuracoes')`, ADICIONAR `revalidateTag(\`empresa-${c.empresaId}\`)` logo após. Import: garantir `import { revalidatePath, revalidateTag } from 'next/cache';`.

- [ ] **Step 5: Verify + commit**

Run: `npm run typecheck` (exit 0).
```bash
git add lib/auth/cached.ts lib/auth/require-role.ts lib/empresa/current.ts "app/(app)/configuracoes/actions.ts"
git commit -m "perf(cache): React.cache em getUser/profiles + config da empresa via unstable_cache (10min)"
```

---

## Task 4: Realtime por-empresa + debounce + itensParciais desacoplado

**Files:**
- Modify: `components/pedidos-list.tsx`, `components/alertas/use-alertas-pedido.ts`, `components/alertas/alertas-provider.tsx`

- [ ] **Step 1: `pedidos-list.tsx` — empresaId do contexto + canal filtrado + debounce**

LER o componente. No topo do `PedidosList`, adicionar `const { profile } = useUser();` (import `import { useUser } from '@/components/providers/user-provider';`) e `const empresaId = profile.empresa_id;`.
No `useEffect` do realtime, trocar `supabase.channel('pedidos-list')` por `supabase.channel(\`pedidos-list:${empresaId}\`)` e o `.on('postgres_changes', { event: '*', schema: 'public', table: 'pedidos' }, ...)` por incluir `filter: \`empresa_id=eq.${empresaId}\``. Trocar o callback `() => setTick((t) => t + 1)` por um debounce:
```ts
let deb: ReturnType<typeof setTimeout> | null = null;
const onChange = () => { if (deb) clearTimeout(deb); deb = setTimeout(() => setTick((t) => t + 1), 500); };
```
usar `onChange` no `.on(...)`. Adicionar `empresaId` às deps do `useEffect` do realtime e limpar o `deb` no cleanup.

- [ ] **Step 2: `pedidos-list.tsx` — desacoplar `itensParciais` do array inteiro**

LER o `useEffect` de itensParciais (deps `[supabase, pedidos]`). Antes dele, derivar a chave estável:
```ts
const idsParciais = pedidos.filter((p) => p.status === 'parcialmente_entregue').map((p) => p.id).sort().join(',');
```
e trocar as deps do efeito de `[supabase, pedidos]` por `[supabase, idsParciais]`. Dentro do efeito, recomputar os ids a partir de `idsParciais.split(',').filter(Boolean)` (ou manter o filtro sobre `pedidos` — o efeito só re-roda quando `idsParciais` muda). Ajustar pra não usar `pedidos` direto nas deps.

- [ ] **Step 3: `alertas-provider.tsx` + `use-alertas-pedido.ts` — passar empresaId + filtrar canal**

LER os dois. No provider, `const { profile } = useUser();` já existe — passar `empresaId: profile.empresa_id` pro hook `useAlertasPedido({ ... })`. No hook, receber `empresaId` nas props e trocar `supabase.channel('pedidos-alertas')` por `supabase.channel(\`pedidos-alertas:${empresaId}\`)` + adicionar `filter: \`empresa_id=eq.${empresaId}\`` no `.on('postgres_changes', { event:'INSERT', ... })`. Adicionar `empresaId` às deps do `useEffect`.

- [ ] **Step 4: Verify + commit**

Run: `npm run typecheck` (exit 0). Run: `npm run lint -- components/pedidos-list.tsx components/alertas/use-alertas-pedido.ts components/alertas/alertas-provider.tsx` (sem novo erro).
```bash
git add components/pedidos-list.tsx components/alertas/use-alertas-pedido.ts components/alertas/alertas-provider.tsx
git commit -m "perf(realtime): canais por-empresa (filter+nome dinamico) + debounce 500ms + itensParciais desacoplado"
```

---

## Task 5: Gates + medição (trgm multi-tenant) + verificação adversarial

- [ ] **Step 1: Gates completos**

Run: `npm run typecheck` (exit 0). Run: `npm run test` (0 failed). Run: `npm run lint` (sem novos erros nos arquivos tocados).

- [ ] **Step 2: Medir a busca trgm multi-tenant** (Postgres local — evidência)

Subir Postgres local (como na medição anterior: `runuser -u postgres`), criar `pedidos` com `empresa_id` + a coluna de busca, gerar ~20 empresas × 25k pedidos (500k linhas), criar o índice trgm **sem** empresa_id e medir `EXPLAIN ANALYZE select ... where empresa_id=$1 and (cliente_nome||...) ilike '%termo%'`; depois recriar com `btree_gin (empresa_id, ... gin_trgm_ops)` e medir de novo. Reportar antes/depois (ms + se poda por empresa). Limpar o Postgres no fim.

- [ ] **Step 3: Verificação adversarial (ultracode)** — revisores independentes refutando:
  (a) dropar `pedidos_status_idx`/`_bairro_idx`/`_data_entrega_idx` não deixa nenhuma query do app sem índice (os compostos cobrem);
  (b) o `empresa_id` explícito nas RPCs não muda o RESULTADO (mesmo escopo que current_empresa_id já dava via RLS);
  (c) o filtro `empresa_id=eq.X` no realtime + o debounce não perdem eventos legítimos da própria empresa;
  (d) `getEmpresaConfigCached` (service_role, cache 10min) não vaza config entre empresas (chave = empresaId) e invalida no save.

- [ ] **Step 4: SQL pra nuvem** — gerar os blocos de `20260603180000` e `20260603180100` pro usuário colar no Supabase (na ordem; o `drop index` + `btree_gin` antes).

---

## Self-Review (autor)
- **Cobertura do spec:** Frente 1 realtime (T4) ✓; Frente 2 trgm (T1) ✓; Frente 3 cache — React.cache+config (T3) ✓, KPI cross-request DEFERIDO (documentado no header) ; Frente 4 higiene+empresa explícito (T1+T2) ✓.
- **Placeholders:** SQL/código completos; os "LER o arquivo" trazem a instrução exata do trecho a trocar (não é placeholder — é precisão sobre arquivo grande).
- **Consistência:** `getAuthUserCached`/`getProfileCached`/`getEmpresaConfigCached` definidos em T3 e usados em require-role/current; tags `empresa-${id}` batem (cached.ts ↔ configuracoes/actions); `useUser().profile.empresa_id` usado igual em pedidos-list e alertas; nomes de índice batem entre criação (T1) e o grep de checagem (T1 Step1).
- **Risco:** T1 (drop de índice) tem checagem prévia; T4 (realtime) protegido por verificação adversarial (não perder eventos). Cache de config é por-empresa (sem leak).
