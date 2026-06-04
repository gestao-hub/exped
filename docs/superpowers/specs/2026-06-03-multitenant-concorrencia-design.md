# Multi-tenant + Concorrência — Design (escala p/ muitas lojas e muitos usuários)

> Data: 2026-06-03 · Projeto: Exped. Base: 4 auditorias paralelas (RLS, cache/carga, realtime, busca cross-tenant).
> **Não há vazamento de dados** — o RLS está correto e completo. Tudo aqui é **performance** em escala.

## 1. Objetivo e escopo

Sustentar **muitas lojas (multi-tenant)** + **muitos usuários simultâneos** sem degradar. Quatro frentes:

1. **Realtime por-empresa** — o maior gargalo de concorrência (fan-out 1:N global).
2. **Busca textual multi-tenant** — índices trigram sem `empresa_id` varrem todos os tenants.
3. **Cache de dados quase-estáticos** — toda navegação re-busca quem-é-você + config da empresa.
4. **Higiene de índice/RLS** — índices antigos competindo com os compostos; RPCs sem `empresa_id` explícito.

### Decisão de cache (firmada pelo usuário: "equilibrado")
- **`React.cache()`** (dedup por-request, ZERO staleness) em `getUser`/`profiles`.
- **`unstable_cache`** com TTL: **config da empresa ~10min**; **KPIs do Admin/Histórico ~2-3min**.
- **Fila de Logística + detalhes de pedido = SEMPRE ao vivo** (não cacheia).

### Fora de escopo (deferido)
- **Cache de sessão do `current_empresa_id()` via GUC** — mexe em função security-critical; risco de leak se errar; ganho marginal (já é `STABLE`).
- **Desnormalizar `empresa_id` em `pedido_eventos`** — mudança maior (coluna+trigger+backfill); o KPI que sofre já vai ser cacheado.
- **Remover `pedido_eventos`/`pedido_logistica` da publicação realtime** — otimização menor de WAL; conservador, fica pra depois.

## 2. Frente 1 — Realtime por-empresa (maior impacto)

**Problema:** [components/pedidos-list.tsx:269](../../../components/pedidos-list.tsx) e
[components/alertas/use-alertas-pedido.ts:106](../../../components/alertas/use-alertas-pedido.ts) escutam
`postgres_changes` na tabela `pedidos` **sem `filter`** e com **nome de canal fixo**. Com 50 lojas × 20 usuários,
1 mudança de pedido → ~1000 WebSockets + ~1000 refetches. E a cascata `itensParciais` ([pedidos-list.tsx:205-258](../../../components/pedidos-list.tsx)) re-roda a cada evento.

**Solução:**
- Pegar `empresaId = useUser().profile.empresa_id` (o contexto já existe; ambos os componentes estão sob `UserProvider`).
- **Filtro + nome dinâmico** nos dois canais:
  ```ts
  supabase.channel(`pedidos-list:${empresaId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'pedidos', filter: `empresa_id=eq.${empresaId}` }, ...)
  ```
  (alertas: idem, `event: 'INSERT'`, canal `pedidos-alertas:${empresaId}`). Fan-out cai de 1:1000 → 1:20.
- **Debounce do refetch:** o handler do realtime acumula em `setTimeout` ~500ms antes de `setTick` — evita N refetches num lote do sync.
- **Desacoplar `itensParciais`:** trocar a dependência do efeito de `[supabase, pedidos]` por `[supabase, idsParciais]` onde `idsParciais = pedidos.filter(p=>p.status==='parcialmente_entregue').map(p=>p.id).join(',')` — só re-busca itens quando o CONJUNTO de parciais muda, não a cada mutação do array.

> Nota: no hub local o realtime é um shim (pode ser no-op); o filtro vale principalmente na nuvem (Vercel) onde o Realtime real faz fan-out. O código é o mesmo nos dois.

## 3. Frente 2 — Busca textual multi-tenant (índices trigram)

**Problema:** `pedidos_search_trgm_idx` ([20260518000003_pedidos.sql:41](../../../supabase/migrations/20260518000003_pedidos.sql)) e
`clientes_nome_trgm` ([20260519000001_clientes.sql:29](../../../supabase/migrations/20260519000001_clientes.sql)) foram
criados ANTES de `empresa_id` existir e **nunca recriados** — o `ilike '%x%'` varre os trigramas de **todos os tenants**
antes do RLS filtrar.

**Solução (migration):**
```sql
create extension if not exists btree_gin;

drop index if exists public.pedidos_search_trgm_idx;
create index pedidos_search_trgm_idx on public.pedidos
  using gin (empresa_id, (coalesce(cliente_nome,'') || ' ' || coalesce(documento_erp,'') || ' ' || coalesce(cliente_bairro,'')) gin_trgm_ops);

drop index if exists public.clientes_nome_trgm;
create index clientes_nome_trgm on public.clientes
  using gin (empresa_id, nome gin_trgm_ops);
```
Com `btree_gin`, o planner poda por `empresa_id` (prefixo btree) antes do GIN → elimina a varredura cross-tenant.
**Mensurável** (gerar N empresas + medir `ilike` antes/depois).

## 4. Frente 3 — Cache de dados quase-estáticos

**Problema:** `getUser()`+`profiles`+`empresas` rodam **2-3× por pageload** (middleware + layout + `getEmpresaAtual` + `requireRole`).
Com 50 usuários simultâneos ≈ 300 queries/s só de "quem é você".

**Solução:**
- **Novo `lib/auth/cached.ts`** com helpers `React.cache()`:
  ```ts
  import { cache } from 'react';
  export const getAuthUserCached = cache(async () => { const s = await createClient(); return s.auth.getUser(); });
  export const getProfileCached = cache(async (userId: string) => { const s = await createClient(); return s.from('profiles').select('*').eq('id', userId).single(); });
  ```
  Reescrever `requireRole` e `getEmpresaAtual` pra usar esses (dedup dentro do mesmo render).
- **Config da empresa via `unstable_cache`** (`lib/empresa/current.ts`): a query de `empresas` (nome/logo/cor/usa_os) entra em `unstable_cache(['empresa-config', empresaId], { revalidate: 600, tags: [\`empresa-${empresaId}\`] })` usando `createServiceRoleClient()` (sem cookies — cacheável; dado não-sensível). Invalidação: `revalidateTag(\`empresa-${id}\`)` em `configuracoes/actions.ts` ao salvar.
- **KPIs do Admin/Histórico via `unstable_cache`** (TTL 120-180s, tag `kpis-${empresaId}`). Invalidação best-effort: `revalidateTag` quando um pedido muda de status (em `vendas/actions.ts`); senão, expira pelo TTL.

## 5. Frente 4 — Higiene de índice + RPC

**Solução (migration + RPCs):**
- **`empresa_id` explícito nas RPCs de KPI** (`historico_kpis`, `admin_top_clientes`, `admin_top_bairros`, `admin_tempo_medio_horas`):
  adicionar `and p.empresa_id = current_empresa_id()` (ou `empresa_id = current_empresa_id()`) no WHERE — o planner passa a
  enxergar o predicado e usar o índice composto. (As funções continuam SECURITY INVOKER.)
- **Índice faltando:** `create index if not exists cliente_enderecos_empresa_idx on public.cliente_enderecos(empresa_id);`
- **Dropar índices de coluna única pré-multitenant** que competem com os compostos (e podem fazer o planner cruzar tenants):
  `drop index if exists public.pedidos_status_idx, public.pedidos_bairro_idx, public.pedidos_data_entrega_idx;`
  (cobertos por `pedidos_empresa_status_entrega_idx`, `pedidos_empresa_*`).

> Cuidado: confirmar (no plano) que nenhuma query depende dos índices simples isoladamente antes de dropar — os compostos
> `(empresa_id, ...)` cobrem os casos do app (que sempre tem empresa via RLS). Dropar é reversível.

## 6. Testes e medição
- **Realtime/cache (frente 1,3,4):** typecheck + suíte verde; revisão de invalidação (cada `unstable_cache` tem o `revalidateTag` correspondente). Não há como medir fan-out real daqui (precisa stack+carga).
- **Busca multi-tenant (frente 2):** **medir** — Postgres local, gerar ex. 20 empresas × 25k pedidos, `EXPLAIN ANALYZE` do `ilike` antes/depois do índice `(empresa_id, trgm)`.
- **Higiene de índice:** `EXPLAIN` confirma uso do índice composto após `empresa_id` explícito nas RPCs.

## 7. Arquivos
- Migration `supabase/migrations/20260603180000_multitenant_indices.sql` (btree_gin + trgm c/ empresa + cliente_enderecos + drop antigos).
- Migration `supabase/migrations/20260603180100_kpis_empresa_explicito.sql` (RPCs com empresa_id explícito).
- `lib/auth/cached.ts` (novo), `lib/auth/require-role.ts`, `lib/empresa/current.ts` (usar cache).
- `components/pedidos-list.tsx`, `components/alertas/use-alertas-pedido.ts` (realtime por-empresa + debounce + itensParciais desacoplado).
- `app/(app)/configuracoes/actions.ts`, `app/(app)/vendas/actions.ts` (revalidateTag de invalidação).
- `app/(app)/admin/page.tsx`, `app/(app)/historico/page.tsx` (KPIs via unstable_cache).
