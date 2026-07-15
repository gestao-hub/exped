# Histórico Completo e Sync Resiliente Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tornar o Histórico consultável em todos os status e impedir que colisões de identidade, vendedores órfãos ou backlogs paginados voltem a ocultar pedidos da nuvem.

**Architecture:** A experiência do Histórico ganha filtros declarativos e uma política explícita de “lista completa, KPIs/exportação finalizados”. O Hub reconcilia identidades locais antes de subir referências, usa paginação keyset para o push e publica um estado sanitizado e preciso; a nuvem adiciona uma defesa de FK e hardening de RLS/funções. A publicação é dividida em aplicação/migrations, instalador de canário e promoção explícita do manifest.

**Tech Stack:** Next.js 16.2.6 App Router, React 19.2.4, TypeScript 5, Supabase/PostgreSQL, Node.js ESM, Vitest 4, pgTAP, Vercel, GitHub Actions e Inno Setup.

## Global Constraints

- Base de implementação: `v0.3.20` (`08e96b0`); versão de release: `0.3.21`.
- Ler os guias relevantes em `node_modules/next/dist/docs/` antes de alterar Server Components ou Route Handlers.
- Antes de qualquer mudança Supabase, consultar `https://supabase.com/changelog.md` e a documentação oficial atual.
- Criar migrations exclusivamente com `supabase migration new <nome>`; nunca inventar o timestamp do arquivo.
- Histórico abre em `todos`; os oito status existentes continuam disponíveis.
- KPIs e CSV permanecem restritos a `status = 'finalizado'` e `deleted_at is null`.
- Lista, detalhe e exportação nunca exibem linhas com `deleted_at` não nulo.
- Não inferir nem preencher `data_entrega` ausente.
- Nunca expor `deviceToken`, `service_role`, hash de senha, e-mail, payload ou SQL no `/status` ou em respostas HTTP.
- Não mover `pg_trgm`/`unaccent`, não remover índices por ausência de uso observada e não executar `npm audit fix --force`.
- Não aceitar a correção do `postcss` que rebaixa Next.js para `9.3.3`.
- Toda mudança comportamental segue red-green-refactor e termina em commit próprio.
- A migration da nuvem precisa ser aditiva; rollback não pode apagar pedidos, perfis ou aliases.
- O manifest só pode ser promovido depois de banco, Vercel e canário Franzoni estarem saudáveis.

## Preflight Amendments (2026-07-14)

These amendments supersede conflicting task details below. They were added after comparing the plan with the current runtime, migrations and release tooling.

1. The History CSV is fixed to `status = 'finalizado'`. A caller cannot export another status by changing the query string. Tests must cover an attempted override.
2. The Hub and ExpedAgent share `agent.syncNowPort`: `5005` by default, a custom loopback port is supported and `0` disables on-demand sync. Vercel never receives `AGENT_SYNC_URL`.
3. List, detail and export soft-delete predicates require query-level regression tests; helper-only tests are insufficient.
4. A failed pulled table/page never advances its cursor. Identity aliases become eligible for reconciliation only after the real canonical `profiles` row was successfully applied, never merely because the auth trigger created a placeholder profile.
5. Missing-vendor fallback runs only for writes marked with `exped.sync = 'on'`; ordinary application writes retain FK failure semantics.
6. Sync cycles are single-flight. A watchdog may report a stalled cycle but must not start overlapping mutable work or let a stale cycle overwrite newer state.
7. Database migrations and pgTAP run on an isolated Supabase branch created for this change before production. Production receives no fixture inserts.
8. Versioned Storage ZIPs are immutable: staging creates once or accepts an existing object only when its SHA-256 matches.
9. The app manifest updates only the Next standalone package and migrations. Hub `.mjs` runtime changes are distributed by the reviewed Windows installer. Manifest rollback is app-only; Hub runtime rollback uses the previous installer.
10. Promotion uses the current reviewed release tooling, not tooling checked out from the target artifact tag. Production deployment happens only after review, CI and merge of the exact commit.

---

## File Structure

### Histórico

- `lib/pedidos/filtros-lista.ts`: interpreta busca por mapa/texto e monta o filtro textual seguro do PostgREST.
- `lib/pedidos/__tests__/filtros-lista.test.ts`: cobre `4079`, `#4079`, texto e caracteres da gramática PostgREST.
- `lib/pedidos/historico.ts`: concentra a política visível do Histórico e a descrição somente leitura baseada no status real.
- `lib/pedidos/__tests__/historico.test.ts`: fixa status inicial, status de exportação e descrições.
- `app/(app)/historico/__tests__/page.test.tsx`: verifica as propriedades produzidas pelo Server Component sem tentar renderizá-lo no DOM.
- `app/(app)/historico/export/__tests__/route.test.ts`: verifica autenticação, `finalizado` padrão e exclusão de soft-delete na rota.
- `components/pedidos-list.tsx`: aplica os filtros declarativos e exclui soft-deletados em qualquer modo.
- `components/status-badge.tsx`: reutiliza os rótulos centralizados de status.
- `app/(app)/historico/page.tsx`: abre em Todos e explicita que os indicadores são de finalizados.
- `app/(app)/historico/[id]/page.tsx`: exclui soft-deletados e descreve o status real.
- `app/(app)/historico/export/route.ts`: mantém CSV de finalizados e exclui soft-deletados.

### Sincronização

- `lib/sync/tables.ts`: tipa PK simples/composta e corrige `hiper_vendedor_map`.
- `lib/sync/__tests__/table-parity.test.ts`: compara integralmente os registros cloud/local.
- `hub/sync-tables.mjs`: espelho local com JSDoc coerente.
- `hub/identity-reconciliation.mjs`: regra de normalização, criação de alias e orquestração da reconciliação.
- `hub/test/identity-reconciliation.test.mjs`: cobre conflito, espera, sucesso, seis referências e rollback do adaptador.
- `hub/sync.mjs`: integra identidade, push keyset paginado, contagem de backlog e diagnóstico.
- `hub/sync-state.mjs`: mantém apenas estado público sanitizado do ciclo.
- `hub/test/sync-state.test.mjs`: cobre tentativa, sucesso, falhas consecutivas e sanitização.
- `hub/test/sync.test.mjs`: cobre 500+500+30, orçamento, cursores, bloqueio e integração de identidade.
- `lib/sync/engine.ts`: anexa tabela/PK sanitizadas a falhas de escrita conhecidas.
- `lib/sync/__tests__/engine.test.ts`: cobre contexto seguro sem vazar erro do banco.
- `app/api/sync/push/route.ts`: devolve `blockedRow` seguro em erro conhecido.
- `app/api/sync/__tests__/routes.test.ts`: fixa o contrato HTTP do diagnóstico.
- `hub/maestro.mjs`: publica o snapshot completo em `/status`.
- `hub/test/maestro.test.mjs`: garante allowlist dos campos públicos.

### Banco, Segurança E Release

- `supabase/migrations/*_sync_missing_vendor_fallback.sql`: migration criada pela CLI para neutralizar vendedor inexistente em pedido/OS.
- `supabase/migrations/*_historico_sync_security_hardening.sql`: migration criada pela CLI para RLS, grants e `search_path`.
- `supabase/tests/20260714_sync_missing_vendor_fallback.test.sql`: pgTAP da defesa de FK.
- `supabase/tests/20260714_historico_sync_security_hardening.test.sql`: pgTAP de RLS, grants, helpers e escopo por perfil.
- `package.json` e `package-lock.json`: versões seguras compatíveis e release `0.3.21`.
- `docs/security/2026-07-14-npm-audit.md`: risco residual do `postcss` embarcado no Next.js.
- `scripts/release-hub.mjs`: separa staging do ZIP e promoção do manifest.
- `scripts/__tests__/release-hub.test.mjs`: cobre parsing de modo, URL e manifest.
- `.github/workflows/release-hub.yml`: tag apenas prepara/publica o ZIP.
- `.github/workflows/promote-hub.yml`: promoção manual e auditável do manifest.

---

## Phase 1: Histórico

### Task 1: Busca Por Mapa E Exclusão De Soft-Delete

**Files:**
- Create: `lib/pedidos/filtros-lista.ts`
- Create: `lib/pedidos/__tests__/filtros-lista.test.ts`
- Modify: `components/pedidos-list.tsx:43-45,166-190,295-302`

**Interfaces:**
- Produces: `parsePedidoSearch(raw: string): PedidoSearchFilter`.
- Produces: `buildPedidoTextSearchOr(text: string): string`.
- Consumes: `PedidoStatus` e o query builder já existente em `PedidosList`.

- [ ] **Step 1: Write the failing search tests**

```ts
// lib/pedidos/__tests__/filtros-lista.test.ts
import { describe, expect, it } from 'vitest';
import { buildPedidoTextSearchOr, parsePedidoSearch } from '../filtros-lista';

describe('parsePedidoSearch', () => {
  it.each(['4079', '#4079', '  #4079  '])('interpreta %s como numero_mapa', (raw) => {
    expect(parsePedidoSearch(raw)).toEqual({ kind: 'numero_mapa', value: 4079 });
  });

  it('mantém documento ERP como busca textual', () => {
    expect(parsePedidoSearch('L001000000282')).toEqual({
      kind: 'texto',
      value: 'L001000000282',
    });
  });

  it('retorna vazio para espaços', () => {
    expect(parsePedidoSearch('   ')).toEqual({ kind: 'vazio' });
  });
});

describe('buildPedidoTextSearchOr', () => {
  it('preserva os três campos atuais', () => {
    expect(buildPedidoTextSearchOr('Muraro')).toBe(
      'cliente_nome.ilike."%Muraro%",documento_erp.ilike."%Muraro%",cliente_bairro.ilike."%Muraro%"',
    );
  });

  it('cota vírgula, parênteses, barra e aspas sem alterar a gramática do filtro', () => {
    expect(buildPedidoTextSearchOr('A,(B)\\"C')).toBe(
      'cliente_nome.ilike."%A,(B)\\\\\\"C%",documento_erp.ilike."%A,(B)\\\\\\"C%",cliente_bairro.ilike."%A,(B)\\\\\\"C%"',
    );
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- lib/pedidos/__tests__/filtros-lista.test.ts`

Expected: FAIL with `Cannot find module '../filtros-lista'`.

- [ ] **Step 3: Implement the parser and safe PostgREST value quoting**

```ts
// lib/pedidos/filtros-lista.ts
export type PedidoSearchFilter =
  | { kind: 'vazio' }
  | { kind: 'numero_mapa'; value: number }
  | { kind: 'texto'; value: string };

export function parsePedidoSearch(raw: string): PedidoSearchFilter {
  const value = raw.trim();
  if (!value) return { kind: 'vazio' };

  const mapa = /^#?(\d+)$/.exec(value);
  if (mapa) {
    const parsed = Number(mapa[1]);
    if (Number.isSafeInteger(parsed)) return { kind: 'numero_mapa', value: parsed };
  }

  return { kind: 'texto', value };
}

function quotePostgrestValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function buildPedidoTextSearchOr(text: string): string {
  const pattern = quotePostgrestValue(`%${text}%`);
  return ['cliente_nome', 'documento_erp', 'cliente_bairro']
    .map((column) => `${column}.ilike.${pattern}`)
    .join(',');
}
```

Modify the query block in `components/pedidos-list.tsx`:

```tsx
import { buildPedidoTextSearchOr, parsePedidoSearch } from '@/lib/pedidos/filtros-lista';

let query = supabase
  .from('pedidos')
  .select('*', { count: 'exact' })
  .is('deleted_at', null)
  .order(sortBy, { ascending: sortDir === 'asc', nullsFirst: false })
  .order('id', { ascending: true })
  .range(pageFrom, pageTo);

if (empresaId) query = query.eq('empresa_id', empresaId);
if (status !== 'todos') query = query.eq('status', status);

const searchFilter = parsePedidoSearch(search);
if (searchFilter.kind === 'numero_mapa') {
  query = query.eq('numero_mapa', searchFilter.value);
} else if (searchFilter.kind === 'texto') {
  query = query.or(buildPedidoTextSearchOr(searchFilter.value));
}
```

Change the placeholder to:

```tsx
placeholder="Buscar por mapa, cliente, documento ou bairro…"
```

- [ ] **Step 4: Run focused tests, typecheck and lint for touched files**

Run: `npm test -- lib/pedidos/__tests__/filtros-lista.test.ts`

Expected: PASS, 6 tests.

Run: `npm run typecheck`

Expected: exit 0.

Run: `npx eslint components/pedidos-list.tsx lib/pedidos/filtros-lista.ts lib/pedidos/__tests__/filtros-lista.test.ts`

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add components/pedidos-list.tsx lib/pedidos/filtros-lista.ts lib/pedidos/__tests__/filtros-lista.test.ts
git commit -m "fix(historico): buscar mapa e ocultar removidos"
```

### Task 2: Política Do Histórico, Exportação E Detalhe

**Files:**
- Create: `lib/pedidos/historico.ts`
- Create: `lib/pedidos/__tests__/historico.test.ts`
- Create: `app/(app)/historico/__tests__/page.test.tsx`
- Create: `app/(app)/historico/export/__tests__/route.test.ts`
- Modify: `components/status-badge.tsx:4-13,54`
- Modify: `app/(app)/historico/page.tsx:22-31,53`
- Modify: `app/(app)/historico/[id]/page.tsx:31,81`
- Modify: `app/(app)/historico/export/route.ts:63-75`

**Interfaces:**
- Produces: `HISTORICO_INITIAL_STATUS = 'todos'`.
- Produces: `HISTORICO_EXPORT_STATUS = 'finalizado'`.
- Produces: `pedidoStatusLabel(status: PedidoStatus): string`.
- Produces: `historicoDetailDescription(status: PedidoStatus): string`.

- [ ] **Step 1: Write failing policy tests**

```ts
// lib/pedidos/__tests__/historico.test.ts
import { describe, expect, it } from 'vitest';
import {
  HISTORICO_EXPORT_STATUS,
  HISTORICO_INITIAL_STATUS,
  historicoDetailDescription,
  pedidoStatusLabel,
} from '../historico';

describe('política do histórico', () => {
  it('abre em todos e exporta finalizados', () => {
    expect(HISTORICO_INITIAL_STATUS).toBe('todos');
    expect(HISTORICO_EXPORT_STATUS).toBe('finalizado');
  });

  it('descreve o status real sem afirmar finalização', () => {
    expect(pedidoStatusLabel('em_separacao')).toBe('Em separação');
    expect(historicoDetailDescription('em_separacao')).toBe(
      'Status: Em separação. Somente leitura.',
    );
  });
});
```

```tsx
// app/(app)/historico/__tests__/page.test.tsx
import { Children, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ single: vi.fn() }));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ rpc: () => ({ single: mocks.single }) }),
}));
vi.mock('@/components/pedidos-list', () => ({ PedidosList: () => null }));

import HistoricoPage from '../page';

beforeEach(() => {
  mocks.single.mockResolvedValue({
    data: { pedidos_finalizados: 7, valor_faturado: 125, clientes_unicos: 1 },
  });
});

describe('HistoricoPage', () => {
  it('abre a lista em todos e deixa explícita a exportação de finalizados', async () => {
    const page = await HistoricoPage();
    const children = Children.toArray(page.props.children) as ReactElement[];
    const header = children[0] as ReactElement<{
      description: string;
      actions: ReactElement<{ href: string; children: ReactNode }>;
    }>;
    const list = children[2] as ReactElement<{ initialStatus: string; mode: string }>;

    expect(header.props.description).toContain('todos os status');
    expect(header.props.actions.props.href).toBe('/historico/export?status=finalizado');
    const actionText = Children.toArray(header.props.actions.props.children)
      .filter((child): child is string => typeof child === 'string')
      .join('')
      .trim();
    expect(actionText).toBe('Exportar finalizados');
    expect(list.props).toMatchObject({ mode: 'historico', initialStatus: 'todos' });
  });
});
```

- [ ] **Step 2: Write the failing export route test**

```ts
// app/(app)/historico/export/__tests__/route.test.ts
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }));

import { GET } from '../route';

type RecordedQuery = {
  select: (...args: unknown[]) => RecordedQuery;
  is: (...args: unknown[]) => RecordedQuery;
  order: (...args: unknown[]) => RecordedQuery;
  range: (...args: unknown[]) => RecordedQuery;
  eq: (...args: unknown[]) => RecordedQuery;
  gte: (...args: unknown[]) => RecordedQuery;
  lte: (...args: unknown[]) => RecordedQuery;
  then: (
    resolve: (value: { data: never[]; error: null }) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise<unknown>;
};

function pedidosQuery(calls: unknown[][]): RecordedQuery {
  const query = {} as RecordedQuery;
  query.select = (...args) => (calls.push(['select', ...args]), query);
  query.is = (...args) => (calls.push(['is', ...args]), query);
  query.order = (...args) => (calls.push(['order', ...args]), query);
  query.range = (...args) => (calls.push(['range', ...args]), query);
  query.eq = (...args) => (calls.push(['eq', ...args]), query);
  query.gte = (...args) => (calls.push(['gte', ...args]), query);
  query.lte = (...args) => (calls.push(['lte', ...args]), query);
  query.then = (resolve, reject) =>
    Promise.resolve({ data: [] as never[], error: null }).then(resolve, reject);
  return query;
}

beforeEach(() => vi.clearAllMocks());

describe('GET /historico/export', () => {
  it('usa finalizado por padrão e exclui deleted_at', async () => {
    const calls: unknown[][] = [];
    type ProfileQuery = {
      select: () => ProfileQuery;
      eq: () => ProfileQuery;
      single: () => Promise<{ data: { empresa_id: string } }>;
    };
    const profile = {} as ProfileQuery;
    profile.select = () => profile;
    profile.eq = () => profile;
    profile.single = async () => ({ data: { empresa_id: 'e1' } });
    mocks.createClient.mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) },
      from: (table: string) => (table === 'profiles' ? profile : pedidosQuery(calls)),
    });

    const response = await GET(
      new NextRequest('http://localhost/historico/export') as never,
    );
    await response.text();

    expect(calls).toContainEqual(['is', 'deleted_at', null]);
    expect(calls).toContainEqual(['eq', 'status', 'finalizado']);
  });
});
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run: `npm test -- lib/pedidos/__tests__/historico.test.ts 'app/(app)/historico/__tests__/page.test.tsx' 'app/(app)/historico/export/__tests__/route.test.ts'`

Expected: FAIL because `lib/pedidos/historico.ts` does not exist and the current page still passes `finalizado`.

- [ ] **Step 4: Implement the shared policy and page copy**

```ts
// lib/pedidos/historico.ts
import type { PedidoStatus } from '@/lib/types';

export const HISTORICO_INITIAL_STATUS = 'todos' as const;
export const HISTORICO_EXPORT_STATUS = 'finalizado' as const;

export const PEDIDO_STATUS_LABELS: Record<PedidoStatus, string> = {
  rascunho: 'Rascunho',
  em_financeiro: 'No caixa',
  pendente: 'Pendente',
  em_separacao: 'Em separação',
  em_transporte: 'Em transporte',
  parcialmente_entregue: 'Parcialmente entregue',
  finalizado: 'Finalizado',
  cancelado: 'Cancelado',
};

export function pedidoStatusLabel(status: PedidoStatus): string {
  return PEDIDO_STATUS_LABELS[status];
}

export function historicoDetailDescription(status: PedidoStatus): string {
  return `Status: ${pedidoStatusLabel(status)}. Somente leitura.`;
}
```

Use `PEDIDO_STATUS_LABELS[status]` in `components/status-badge.tsx`. In `app/(app)/historico/page.tsx`, use:

```tsx
description="Pedidos de todos os status e indicadores acumulados de finalizados."
```

```tsx
<Download className="h-4 w-4 mr-1" /> Exportar finalizados
```

```tsx
<PedidosList
  mode="historico"
  initialStatus={HISTORICO_INITIAL_STATUS}
  showNewButton={false}
  bounded
/>
```

Keep the export URL fixed at `status=finalizado`.

- [ ] **Step 5: Apply active-row constraints and actual detail status**

In `app/(app)/historico/export/route.ts`, place `.is('deleted_at', null)` immediately after `.select(SELECT)`.

In `app/(app)/historico/[id]/page.tsx`, change the pedido query and description to:

```tsx
supabase.from('pedidos').select('*').eq('id', id).is('deleted_at', null).single()
```

```tsx
description={historicoDetailDescription(pedido.status)}
```

Do not touch `data_entrega`, `historico_kpis` or the CSV date columns.

- [ ] **Step 6: Run focused and full Phase 1 verification**

Run: `npm test -- lib/pedidos/__tests__/filtros-lista.test.ts lib/pedidos/__tests__/historico.test.ts 'app/(app)/historico/__tests__/page.test.tsx' 'app/(app)/historico/export/__tests__/route.test.ts'`

Expected: PASS.

Run: `npm run typecheck`

Expected: exit 0.

Run: `npm run lint`

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add 'app/(app)/historico' components/status-badge.tsx lib/pedidos/historico.ts lib/pedidos/__tests__/historico.test.ts
git commit -m "feat(historico): exibir todos os status"
```

---

## Phase 2: Sync Resiliente

### Task 3: Paridade Integral Do Registro De Sync

**Files:**
- Create: `lib/sync/__tests__/table-parity.test.ts`
- Modify: `lib/sync/tables.ts:22-45`
- Modify: `hub/sync-tables.mjs:14-32`
- Modify: `lib/sync/engine.ts:11,23-40,131-239`
- Modify: `lib/sync/supabase-db.ts:4,52-125`

**Interfaces:**
- Produces: `SyncPrimaryKey = string | readonly string[]`.
- Produces: discriminated `TwoWaySyncTable` with `pk: string` and `DownSyncTable` with `pk: SyncPrimaryKey`.
- Guarantees: cloud e Hub têm nome, direção, PK e parent idênticos.

- [ ] **Step 1: Write the failing parity test**

```ts
// lib/sync/__tests__/table-parity.test.ts
import { describe, expect, it } from 'vitest';
import { SYNC_TABLES as CLOUD_TABLES } from '../tables';
import { SYNC_TABLES as HUB_TABLES } from '../../../hub/sync-tables.mjs';

type ComparableTable = {
  name: string;
  dir: string;
  pk: string | readonly string[];
  parent?: { table: string; fk: string };
};

function normalize(tables: readonly ComparableTable[]) {
  return tables
    .map((table) => ({
      name: table.name,
      dir: table.dir,
      pk: Array.isArray(table.pk) ? [...table.pk] : [table.pk],
      parent: table.parent ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

describe('registro de sync', () => {
  it('é idêntico na nuvem e no Hub', () => {
    expect(normalize(CLOUD_TABLES)).toEqual(normalize(HUB_TABLES));
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- lib/sync/__tests__/table-parity.test.ts`

Expected: FAIL showing cloud `hiper_vendedor_map.pk = ['id']` versus Hub `['empresa_id', 'hiper_usuario_id']`.

- [ ] **Step 3: Introduce discriminated table types and fix the PK**

```ts
// lib/sync/tables.ts
export type SyncDir = 'two-way' | 'down';
export type SyncPrimaryKey = string | readonly string[];

type SyncTableBase = {
  name: string;
  parent?: { table: string; fk: string };
};

export type TwoWaySyncTable = SyncTableBase & {
  dir: 'two-way';
  pk: string;
};

export type DownSyncTable = SyncTableBase & {
  dir: 'down';
  pk: SyncPrimaryKey;
};

export type SyncTable = TwoWaySyncTable | DownSyncTable;
```

Change the cloud registry entry to:

```ts
{ name: 'hiper_vendedor_map', pk: ['empresa_id', 'hiper_usuario_id'], dir: 'down' },
```

Change the Hub typedef to:

```js
/** @typedef {{ name: string, pk: string|string[], dir: 'two-way'|'down', parent?: { table: string, fk: string } }} SyncTable */
```

Narrow the five push-only `SyncDb` methods to `TwoWaySyncTable`:

```ts
findCanonical(table: TwoWaySyncTable, empresaId: string, pk: unknown): Promise<Row | null>;
findCanonicalGlobal(table: TwoWaySyncTable, pk: unknown): Promise<Row | null>;
findCanonicalMany(
  table: TwoWaySyncTable,
  empresaId: string,
  pks: unknown[],
): Promise<Map<string, Row>>;
```

Update the engine import to include `getSyncTable` and `TwoWaySyncTable`:

```ts
import {
  SYNC_TABLES,
  getSyncTable,
  hasDirectEmpresaId,
  type TwoWaySyncTable,
} from './tables';
```

`parentBelongsToEmpresa` and `parentsInEmpresa` keep their current string-table signatures. In both validation and processing loops, narrow before indexing:

```ts
const table = getSyncTable(name);
if (!table) throw new PushError(422, `Tabela desconhecida: ${name}`);
if (table.dir !== 'two-way') {
  throw new PushError(403, `Tabela read-only (down): ${name}`);
}
const pk = table.pk; // string after discriminated-union narrowing
```

Replace every `SYNC_TABLES.find((x) => x.name === name)!` in `runPush` with the guarded block above. Do not add composite-PK writes to cloud push because every `two-way` table still has `pk: string`.

- [ ] **Step 4: Run parity, engine tests and typecheck**

Run: `npm test -- lib/sync/__tests__/table-parity.test.ts lib/sync/__tests__/engine.test.ts hub/test/sync.test.mjs`

Expected: PASS.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add lib/sync/tables.ts lib/sync/engine.ts lib/sync/supabase-db.ts lib/sync/__tests__/table-parity.test.ts hub/sync-tables.mjs
git commit -m "fix(sync): alinhar registro de tabelas"
```

### Task 4: Reconciliação Transacional De Identidade Local

**Files:**
- Create: `hub/identity-reconciliation.mjs`
- Create: `hub/test/identity-reconciliation.test.mjs`
- Modify: `hub/sync.mjs:27-35,124-134,250-313,403-588`
- Modify: `hub/test/sync.test.mjs:15-60,347-393`

**Interfaces:**
- Consumes from DB: `findAuthUserByNormalizedEmail`, `upsertAuthUserById`, `aliasAndUpsertAuthUser`, `listPendingIdentityAliases`, `profileExists`, `repointIdentityAlias`, `markIdentityAliasError`.
- Produces: `applyAuthUserWithIdentity(db, row)`.
- Produces: `reconcilePendingIdentityAliases(db): Promise<{ resolved: number; pending: number }>`.
- Produces: `IDENTITY_REFERENCES`, a fixed six-item allowlist.

- [ ] **Step 1: Write the failing identity unit tests**

```js
// hub/test/identity-reconciliation.test.mjs
import { describe, expect, it, vi } from 'vitest';
import {
  IDENTITY_REFERENCES,
  applyAuthUserWithIdentity,
  normalizeIdentityEmail,
  reconcilePendingIdentityAliases,
} from '../identity-reconciliation.mjs';

describe('identidade local', () => {
  it('normaliza com trim + lower', () => {
    expect(normalizeIdentityEmail('  Eduardo@Franzoni.Local ')).toBe('eduardo@franzoni.local');
  });

  it('registra alias quando e-mail igual chega com UUID diferente', async () => {
    const db = {
      findAuthUserByNormalizedEmail: vi.fn(async () => ({ id: 'old-id' })),
      upsertAuthUserById: vi.fn(),
      aliasAndUpsertAuthUser: vi.fn(async () => undefined),
    };
    const row = { id: 'cloud-id', email: ' Eduardo@Franzoni.Local ' };

    await applyAuthUserWithIdentity(db, row);

    expect(db.aliasAndUpsertAuthUser).toHaveBeenCalledWith({
      oldUserId: 'old-id',
      canonicalUser: row,
      normalizedEmail: 'eduardo@franzoni.local',
      aliasEmail: 'exped-alias+old-id@invalid.local',
    });
    expect(db.upsertAuthUserById).not.toHaveBeenCalled();
  });

  it('não une IDs quando os e-mails são diferentes', async () => {
    const db = {
      findAuthUserByNormalizedEmail: vi.fn(async () => null),
      upsertAuthUserById: vi.fn(async () => undefined),
      aliasAndUpsertAuthUser: vi.fn(),
    };
    const row = { id: 'cloud-id', email: 'outro@franzoni.local' };
    await applyAuthUserWithIdentity(db, row);
    expect(db.upsertAuthUserById).toHaveBeenCalledWith(row);
    expect(db.aliasAndUpsertAuthUser).not.toHaveBeenCalled();
  });

  it('mantém alias pendente até o profile canônico existir', async () => {
    const db = {
      listPendingIdentityAliases: vi.fn(async () => [
        { old_user_id: 'old-id', canonical_user_id: 'cloud-id' },
      ]),
      profileExists: vi.fn(async () => false),
      repointIdentityAlias: vi.fn(),
      markIdentityAliasError: vi.fn(),
    };
    await expect(reconcilePendingIdentityAliases(db)).resolves.toEqual({ resolved: 0, pending: 1 });
    expect(db.repointIdentityAlias).not.toHaveBeenCalled();
  });

  it('mantém exatamente as seis referências aprovadas', () => {
    expect(IDENTITY_REFERENCES).toEqual([
      { table: 'pedidos', column: 'vendedor_id', propagate: true },
      { table: 'ordens_servico', column: 'vendedor_id', propagate: true },
      { table: 'hiper_vendedor_map', column: 'vendedor_id', propagate: false },
      { table: 'pedido_comentarios', column: 'autor_id', propagate: false },
      { table: 'pedido_eventos', column: 'usuario_id', propagate: false },
      { table: 'pedido_logistica', column: 'updated_by', propagate: false },
    ]);
  });
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `npm test -- hub/test/identity-reconciliation.test.mjs`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement the identity orchestrator**

```js
// hub/identity-reconciliation.mjs
export const IDENTITY_REFERENCES = Object.freeze([
  { table: 'pedidos', column: 'vendedor_id', propagate: true },
  { table: 'ordens_servico', column: 'vendedor_id', propagate: true },
  { table: 'hiper_vendedor_map', column: 'vendedor_id', propagate: false },
  { table: 'pedido_comentarios', column: 'autor_id', propagate: false },
  { table: 'pedido_eventos', column: 'usuario_id', propagate: false },
  { table: 'pedido_logistica', column: 'updated_by', propagate: false },
]);

export function normalizeIdentityEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

export function identityAliasEmail(oldUserId) {
  return `exped-alias+${String(oldUserId).toLowerCase()}@invalid.local`;
}

export async function applyAuthUserWithIdentity(db, row) {
  const normalizedEmail = normalizeIdentityEmail(row.email);
  if (!normalizedEmail) return db.upsertAuthUserById(row);

  const existing = await db.findAuthUserByNormalizedEmail(normalizedEmail);
  if (!existing || String(existing.id) === String(row.id)) {
    return db.upsertAuthUserById(row);
  }

  return db.aliasAndUpsertAuthUser({
    oldUserId: String(existing.id),
    canonicalUser: row,
    normalizedEmail,
    aliasEmail: identityAliasEmail(existing.id),
  });
}

export async function reconcilePendingIdentityAliases(db) {
  const aliases = await db.listPendingIdentityAliases();
  let resolved = 0;
  let pending = 0;

  for (const alias of aliases) {
    if (!(await db.profileExists(alias.canonical_user_id))) {
      pending += 1;
      continue;
    }
    try {
      await db.repointIdentityAlias(alias);
      resolved += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : 'falha local';
      await db.markIdentityAliasError(alias.old_user_id, message).catch(() => undefined);
      throw new Error('Falha ao reconciliar identidade local', { cause: error });
    }
  }

  return { resolved, pending };
}
```

- [ ] **Step 4: Add the private schema and atomic PSQL adapter operations**

Add these exact idempotent statements to `ensureCursorTable()` in `makePsqlDb`:

```sql
create schema if not exists exped_internal;
revoke all on schema exped_internal from public, anon, authenticated;
create table if not exists exped_internal.identity_aliases (
  old_user_id uuid primary key,
  canonical_user_id uuid not null,
  normalized_email text not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  last_error text
);
revoke all on exped_internal.identity_aliases from public, anon, authenticated;
```

Refactor the temp-file execution into `psqlScript(cfg, body)` and keep `psqlSyncWrite(cfg, sql)` as:

```js
async function psqlSyncWrite(cfg, sql) {
  return psqlScript(cfg, `begin; set local exped.sync = 'on'; ${sql}; commit;`);
}
```

Extract the current auth-user filtering into these exact helpers, then use the same statement in both the ordinary and alias paths:

```js
const AUTH_GENERATED_COLS = new Set(['confirmed_at']);
const AUTH_TOKEN_COLS = new Set([
  'confirmation_token', 'recovery_token', 'email_change_token_new',
  'email_change', 'email_change_token_current', 'phone_change',
  'phone_change_token', 'reauthentication_token',
]);

function authUserForLocal(row) {
  const filtered = Object.fromEntries(
    Object.entries(row)
      .filter(([key]) => !AUTH_GENERATED_COLS.has(key))
      .map(([key, value]) => [key, AUTH_TOKEN_COLS.has(key) && value == null ? '' : value]),
  );
  for (const column of AUTH_TOKEN_COLS) {
    if (filtered[column] == null) filtered[column] = '';
  }
  if (!filtered.id) throw new Error('auth.users sem id');
  return filtered;
}

function quoteIdent(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function authUserUpsertStatement(row) {
  const filtered = authUserForLocal(row);
  const columns = Object.keys(filtered).map(quoteIdent);
  const updates = columns
    .filter((column) => column !== '"id"')
    .map((column) => `${column} = excluded.${column}`)
    .join(', ');
  const columnList = columns.join(', ');
  const conflict = updates ? `do update set ${updates}` : 'do nothing';
  return (
    `insert into auth.users (${columnList}) ` +
    `select ${columnList} from jsonb_populate_record(` +
    `null::auth.users, ${sqlStr(JSON.stringify(filtered))}::jsonb) ` +
    `on conflict ("id") ${conflict}`
  );
}
```

Implement the PSQL adapter methods as follows:

```js
async findAuthUserByNormalizedEmail(normalizedEmail) {
  return psqlJson(
    cfg,
    `select coalesce((select jsonb_build_object('id', id, 'email', email)::text ` +
      `from auth.users where lower(btrim(email)) = ${sqlStr(normalizedEmail)} ` +
      `order by id limit 1), '')`,
  );
},

async upsertAuthUserById(row) {
  await psqlScript(cfg, `begin; ${authUserUpsertStatement(row)}; commit;`);
},

async aliasAndUpsertAuthUser({
  oldUserId, canonicalUser, normalizedEmail, aliasEmail,
}) {
  const canonicalId = String(canonicalUser.id);
  await psqlScript(cfg, [
    'begin;',
    `select pg_advisory_xact_lock(hashtext(${sqlStr(`exped.identity:${normalizedEmail}`)}));`,
    `insert into exped_internal.identity_aliases ` +
      `(old_user_id, canonical_user_id, normalized_email, resolved_at, last_error) values (` +
      `${sqlStr(oldUserId)}::uuid, ${sqlStr(canonicalId)}::uuid, ` +
      `${sqlStr(normalizedEmail)}, null, null) ` +
      `on conflict (old_user_id) do update set ` +
      `canonical_user_id = excluded.canonical_user_id, ` +
      `normalized_email = excluded.normalized_email, resolved_at = null, last_error = null;`,
    `update auth.users set email = ${sqlStr(aliasEmail)}, updated_at = now() ` +
      `where id = ${sqlStr(oldUserId)}::uuid and id <> ${sqlStr(canonicalId)}::uuid;`,
    `${authUserUpsertStatement(canonicalUser)};`,
    'commit;',
  ].join('\n'));
},

async listPendingIdentityAliases() {
  return (await psqlJson(
    cfg,
    `select coalesce(jsonb_agg(to_jsonb(a) order by a.created_at), '[]'::jsonb)::text ` +
      `from exped_internal.identity_aliases a where resolved_at is null`,
  )) || [];
},

async profileExists(userId) {
  return (await psqlCmd(
    cfg,
    `select exists(select 1 from public.profiles where id = ${sqlStr(userId)}::uuid)`,
  )).trim() === 't';
},

async markIdentityAliasError(oldUserId, message) {
  await psqlCmd(
    cfg,
    `update exped_internal.identity_aliases set last_error = ` +
      `${sqlStr(String(message).slice(0, 500))} where old_user_id = ${sqlStr(oldUserId)}::uuid`,
  );
},
```

Implement `repointIdentityAlias` with one concrete transaction assembled only from the fixed `IDENTITY_REFERENCES` allowlist:

```js
async repointIdentityAlias(alias) {
  const oldId = sqlStr(String(alias.old_user_id));
  const canonicalId = sqlStr(String(alias.canonical_user_id));
  const propagating = IDENTITY_REFERENCES
    .filter((ref) => ref.propagate)
    .map((ref) =>
      `update public.${quoteIdent(ref.table)} set ${quoteIdent(ref.column)} = ${canonicalId}::uuid ` +
      `where ${quoteIdent(ref.column)} = ${oldId}::uuid;`,
    );
  const internal = IDENTITY_REFERENCES
    .filter((ref) => !ref.propagate)
    .map((ref) =>
      `update public.${quoteIdent(ref.table)} set ${quoteIdent(ref.column)} = ${canonicalId}::uuid ` +
      `where ${quoteIdent(ref.column)} = ${oldId}::uuid;`,
    );

  await psqlScript(cfg, [
    'begin;',
    `select 1 from public.profiles where id = ${canonicalId}::uuid for key share;`,
    ...propagating,
    `set local exped.sync = 'on';`,
    ...internal,
    `delete from public.profiles where id = ${oldId}::uuid;`,
    `delete from auth.users where id = ${oldId}::uuid;`,
    `update exped_internal.identity_aliases set resolved_at = now(), last_error = null ` +
      `where old_user_id = ${oldId}::uuid;`,
    'commit;',
  ].join('\n'));
},
```

The first two updates run before `exped.sync = 'on'` so their normal stamps are pushed next cycle. Any failure rolls back all reference changes; only the separate `markIdentityAliasError` statement may persist afterward.

- [ ] **Step 5: Integrate auth application and post-page reconciliation**

Replace `db.upsertAuthUser(row)` with:

```js
await applyAuthUserWithIdentity(db, row);
```

After applying all `pulled.tables` rows for the page, call:

```js
try {
  await reconcilePendingIdentityAliases(db);
} catch (error) {
  ok = false;
  firstError ??= error?.message || String(error);
  logger.error(`sync identity: ${error?.message}`);
}
```

Import `IDENTITY_REFERENCES` in `hub/test/sync.test.mjs` and add this state to `makeMemDb`:

```js
const identityAliases = new Map();
let nextIdentityFailure = null;

function normalizedEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function snapshot() {
  return JSON.parse(JSON.stringify({
    tables: [...tables].map(([name, rows]) => [name, [...rows]]),
    aliases: [...identityAliases],
  }));
}
```

Add these exact methods to the fake DB return value:

```js
async findAuthUserByNormalizedEmail(email) {
  return [...tbl('auth.users').values()].find(
    (row) => normalizedEmail(row.email) === email,
  ) || null;
},
async upsertAuthUserById(row) {
  tbl('auth.users').set(row.id, { ...row });
},
async aliasAndUpsertAuthUser({
  oldUserId, canonicalUser, normalizedEmail: email, aliasEmail,
}) {
  const old = tbl('auth.users').get(oldUserId);
  if (old) tbl('auth.users').set(oldUserId, { ...old, email: aliasEmail });
  tbl('auth.users').set(canonicalUser.id, { ...canonicalUser });
  identityAliases.set(oldUserId, {
    old_user_id: oldUserId,
    canonical_user_id: canonicalUser.id,
    normalized_email: email,
    resolved_at: null,
    last_error: null,
  });
},
async listPendingIdentityAliases() {
  return [...identityAliases.values()].filter((alias) => !alias.resolved_at);
},
async profileExists(userId) {
  return tbl('profiles').has(userId);
},
async repointIdentityAlias(alias) {
  if (nextIdentityFailure) {
    const error = nextIdentityFailure;
    nextIdentityFailure = null;
    throw error;
  }
  for (const ref of IDENTITY_REFERENCES) {
    for (const [key, row] of tbl(ref.table)) {
      if (row[ref.column] === alias.old_user_id) {
        tbl(ref.table).set(key, { ...row, [ref.column]: alias.canonical_user_id });
      }
    }
  }
  tbl('profiles').delete(alias.old_user_id);
  tbl('auth.users').delete(alias.old_user_id);
  identityAliases.set(alias.old_user_id, {
    ...identityAliases.get(alias.old_user_id),
    resolved_at: '2026-07-14T10:00:01Z',
    last_error: null,
  });
},
async markIdentityAliasError(oldUserId, message) {
  identityAliases.set(oldUserId, {
    ...identityAliases.get(oldUserId),
    last_error: message,
  });
},
identityAlias: (oldUserId) => identityAliases.get(oldUserId),
snapshot,
failNextIdentityTransaction(error) {
  nextIdentityFailure = error;
},
```

Then add these integration assertions:

```js
it('conflito de e-mail migra as seis referências para o UUID canônico', async () => {
  const oldId = '00000000-0000-0000-0000-000000000111';
  const canonicalId = '00000000-0000-0000-0000-000000000222';
  db.seed('auth.users', { id: oldId, email: ' EDUARDO@FRANZONI.LOCAL ' });
  for (const [table, column] of [
    ['pedidos', 'vendedor_id'],
    ['ordens_servico', 'vendedor_id'],
    ['hiper_vendedor_map', 'vendedor_id'],
    ['pedido_comentarios', 'autor_id'],
    ['pedido_eventos', 'usuario_id'],
    ['pedido_logistica', 'updated_by'],
  ]) {
    db.seed(table, { id: `${table}-1`, [column]: oldId, updated_at: '2026-07-01T00:00:00Z' });
  }

  await syncOnce({
    db, apiBase, deviceToken,
    pushFn: async ({ rows }) => ({ tables: rows }),
    pullFn: async () => ({
      auth_users: [{ id: canonicalId, email: 'eduardo@franzoni.local', updated_at: '2026-07-14T10:00:00Z' }],
      tables: {
        profiles: [{ id: canonicalId, empresa_id: 'E1', updated_at: '2026-07-14T10:00:00Z' }],
      },
      nextCursors: {
        'auth.users': '2026-07-14T10:00:00Z',
        profiles: '2026-07-14T10:00:00Z',
      },
    }),
  });

  expect(db.identityAlias(oldId)).toMatchObject({ canonical_user_id: canonicalId });
  for (const [table, column] of [
    ['pedidos', 'vendedor_id'],
    ['ordens_servico', 'vendedor_id'],
    ['hiper_vendedor_map', 'vendedor_id'],
    ['pedido_comentarios', 'autor_id'],
    ['pedido_eventos', 'usuario_id'],
    ['pedido_logistica', 'updated_by'],
  ]) {
    expect(db.get(table, `${table}-1`)[column]).toBe(canonicalId);
  }
});

it('falha de reconciliação preserva todas as referências antigas', async () => {
  const snapshot = db.snapshot();
  db.failNextIdentityTransaction(new Error('FK simulada'));
  await expect(db.repointIdentityAlias({
    old_user_id: '00000000-0000-0000-0000-000000000111',
    canonical_user_id: '00000000-0000-0000-0000-000000000222',
  })).rejects.toThrow('FK simulada');
  expect(db.snapshot()).toEqual(snapshot);
});
```

- [ ] **Step 6: Run identity and sync tests**

Run: `npm test -- hub/test/identity-reconciliation.test.mjs hub/test/sync.test.mjs`

Expected: PASS.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add hub/identity-reconciliation.mjs hub/test/identity-reconciliation.test.mjs hub/sync.mjs hub/test/sync.test.mjs
git commit -m "fix(sync): reconciliar identidades locais"
```

### Task 5: Fallback De Vendedor Ausente Na Nuvem

**Files:**
- Create via CLI: `supabase/migrations/*_sync_missing_vendor_fallback.sql`
- Create: `supabase/tests/20260714_sync_missing_vendor_fallback.test.sql`

**Interfaces:**
- Produces: trigger function `public.null_missing_vendedor_id()`.
- Produces: triggers `pedidos_null_missing_vendedor` and `ordens_servico_null_missing_vendedor`.
- Guarantees: apenas UUID inexistente vira `null`; UUID canônico existente é preservado.

- [ ] **Step 1: Refresh official Supabase context**

Run: `curl -fsSL https://supabase.com/changelog.md | rg -n "breaking-change|Postgres|RLS|trigger"`

Expected: command succeeds; inspect every relevant linked breaking change before continuing.

Read the current official RLS and database-functions documentation through the Supabase MCP `search_docs` tool. Record no secrets in the plan or commit.

- [ ] **Step 2: Write the failing pgTAP test**

```sql
-- supabase/tests/20260714_sync_missing_vendor_fallback.test.sql
begin;
select plan(6);

select has_function(
  'public', 'null_missing_vendedor_id', array[]::text[],
  'função de fallback existe'
);

insert into public.pedidos
  (id, empresa_id, cliente_nome, data_emissao, vendedor_id)
values
  ('00000000-0000-0000-0000-000000004079',
   '00000000-0000-0000-0000-0000000f0001',
   'Teste mapa 4079', current_date,
   '00000000-0000-0000-0000-00000000dead');

select is(
  (select vendedor_id from public.pedidos where id = '00000000-0000-0000-0000-000000004079'),
  null::uuid,
  'pedido com vendedor inexistente é preservado sem vendedor'
);

insert into public.ordens_servico
  (id, empresa_id, cliente_nome, vendedor_id)
values
  ('00000000-0000-0000-0000-000000004080',
   '00000000-0000-0000-0000-0000000f0001',
   'Teste OS',
   '00000000-0000-0000-0000-00000000dead');

select is(
  (select vendedor_id from public.ordens_servico where id = '00000000-0000-0000-0000-000000004080'),
  null::uuid,
  'OS com vendedor inexistente é preservada sem vendedor'
);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000004078',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'vendedor-4078@teste.local', '', now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
);
update public.profiles
set empresa_id = '00000000-0000-0000-0000-0000000f0001'
where id = '00000000-0000-0000-0000-000000004078';

insert into public.pedidos
  (id, empresa_id, cliente_nome, data_emissao, vendedor_id)
values
  ('00000000-0000-0000-0000-000000004078',
   '00000000-0000-0000-0000-0000000f0001',
   'Teste vendedor válido', current_date,
   '00000000-0000-0000-0000-000000004078');

select is(
  (select vendedor_id from public.pedidos where id = '00000000-0000-0000-0000-000000004078'),
  '00000000-0000-0000-0000-000000004078'::uuid,
  'vendedor canônico existente é preservado'
);

select trigger_is(
  'public', 'pedidos', 'pedidos_null_missing_vendedor',
  'public', 'null_missing_vendedor_id',
  'trigger instalado em pedidos'
);
select trigger_is(
  'public', 'ordens_servico', 'ordens_servico_null_missing_vendedor',
  'public', 'null_missing_vendedor_id',
  'trigger instalado em OS'
);

select * from finish();
rollback;
```

- [ ] **Step 3: Run the test on the isolated test database and verify RED**

Run: `supabase test db supabase/tests/20260714_sync_missing_vendor_fallback.test.sql --db-url "$SUPABASE_TEST_DB_URL"`

Expected: FAIL because the function/trigger does not exist and the orphan insert violates the FK.

- [ ] **Step 4: Generate the migration with the CLI and implement it**

Run: `supabase migration new sync_missing_vendor_fallback`

Expected: one new path ending in `_sync_missing_vendor_fallback.sql`. Put exactly this SQL in that generated file:

```sql
create or replace function public.null_missing_vendedor_id()
returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  if new.vendedor_id is not null
     and not exists (select 1 from public.profiles p where p.id = new.vendedor_id) then
    new.vendedor_id := null;
  end if;
  return new;
end;
$$;

drop trigger if exists pedidos_null_missing_vendedor on public.pedidos;
create trigger pedidos_null_missing_vendedor
before insert or update on public.pedidos
for each row execute function public.null_missing_vendedor_id();

drop trigger if exists ordens_servico_null_missing_vendedor on public.ordens_servico;
create trigger ordens_servico_null_missing_vendedor
before insert or update on public.ordens_servico
for each row execute function public.null_missing_vendedor_id();

revoke all on function public.null_missing_vendedor_id() from public, anon, authenticated;
```

`SECURITY DEFINER` is required here because non-admin profiles cannot read every row in `profiles`; without it, RLS could make an existing seller look absent. The function is not a client RPC: all client/PUBLIC execute grants are revoked, and its body only performs an existence check plus assignment to `NEW`.

- [ ] **Step 5: Apply only to the isolated database and verify GREEN**

Run: `supabase db push --db-url "$SUPABASE_TEST_DB_URL" --dry-run`

Expected: lists only the new pending migration(s).

Run: `supabase db push --db-url "$SUPABASE_TEST_DB_URL"`

Expected: migration applied successfully.

Run: `supabase test db supabase/tests/20260714_sync_missing_vendor_fallback.test.sql --db-url "$SUPABASE_TEST_DB_URL"`

Expected: `1..6`, all tests `ok`.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/*_sync_missing_vendor_fallback.sql supabase/tests/20260714_sync_missing_vendor_fallback.test.sql
git commit -m "fix(sync): aceitar vendedor órfão sem bloquear fila"
```

### Task 6: Diagnóstico Seguro Da Linha Bloqueada

**Files:**
- Modify: `lib/sync/engine.ts:104-115,126-245`
- Modify: `lib/sync/__tests__/engine.test.ts:160-384`
- Modify: `app/api/sync/push/route.ts:44-54`
- Modify: `app/api/sync/__tests__/routes.test.ts:132-197`
- Modify: `hub/sync.mjs:84-99,162-179`

**Interfaces:**
- Produces: `BlockedRow = { table: string; pk: string }`.
- Extends: `PushError(status, message, blockedRow?)`.
- HTTP error body: `{ error: string, blockedRow?: BlockedRow }`; never includes DB message.
- Hub HTTP error object: `.status` and optional `.blockedRow` after strict shape validation.

- [ ] **Step 1: Write failing engine and route tests**

Add to `lib/sync/__tests__/engine.test.ts`:

```ts
it('envolve falha de escrita com tabela/PK e sem mensagem interna', async () => {
  const { db } = makeDb();
  db.upsertRaw = async () => {
    throw new Error('duplicate key value violates secret_constraint');
  };

  await expect(
    runPush(db, 'E1', {
      pedidos: [{ id: 'p-4079', field_updated_at: {} }],
    }),
  ).rejects.toMatchObject({
    status: 500,
    message: 'Falha ao gravar linha de sync',
    blockedRow: { table: 'pedidos', pk: 'p-4079' },
  });
});
```

Add to `app/api/sync/__tests__/routes.test.ts`:

```ts
it('500 conhecido devolve somente tabela/PK sanitizadas', async () => {
  fakeDb.findCanonical.mockResolvedValue(null);
  fakeDb.upsertRaw.mockRejectedValue(
    new Error('duplicate key value violates users_email_partial_key'),
  );
  const res = await pushPOST(
    req({ rows: { pedidos: [{ id: 'p-4079', field_updated_at: {} }] } }, 'tok') as never,
  );
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({
    error: 'Falha ao gravar linha de sync',
    blockedRow: { table: 'pedidos', pk: 'p-4079' },
  });
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- lib/sync/__tests__/engine.test.ts app/api/sync/__tests__/routes.test.ts`

Expected: FAIL because the current route returns only `Falha no push de sync`.

- [ ] **Step 3: Implement sanitized context**

```ts
export type BlockedRow = { table: string; pk: string };

export class PushError extends Error {
  constructor(
    public status: number,
    message: string,
    public blockedRow?: BlockedRow,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

function blockedRowFor(table: TwoWaySyncTable, row: Row): BlockedRow {
  const raw = String(row[table.pk] ?? 'desconhecida');
  return { table: table.name, pk: raw.replace(/[^a-zA-Z0-9_.:/-]/g, '').slice(0, 128) };
}
```

Wrap only `db.upsertRaw`:

```ts
let saved: Row | null;
try {
  saved = await db.upsertRaw(t.name, toWrite);
} catch (cause) {
  throw new PushError(
    500,
    'Falha ao gravar linha de sync',
    blockedRowFor(t, row),
    { cause },
  );
}
```

Return it from the route only for `PushError`:

```ts
return NextResponse.json(
  { error: e.message, ...(e.blockedRow ? { blockedRow: e.blockedRow } : {}) },
  { status: e.status },
);
```

Replace the non-2xx block in `makeHttpPush` with:

```js
if (!res.ok) {
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const err = new Error(`push HTTP ${res.status}`);
  err.status = res.status;
  const blocked = body?.blockedRow;
  const tableAllowed =
    typeof blocked?.table === 'string' &&
    TWO_WAY_TABLES.some((table) => table.name === blocked.table);
  const pkAllowed =
    typeof blocked?.pk === 'string' &&
    blocked.pk.length > 0 &&
    blocked.pk.length <= 128 &&
    /^[a-zA-Z0-9_.:/-]+$/.test(blocked.pk);
  if (tableAllowed && pkAllowed) {
    err.blockedRow = { table: blocked.table, pk: blocked.pk };
  }
  throw err;
}
```

Never copy the server's arbitrary body, SQL detail or stack into the Hub state.

- [ ] **Step 4: Run tests and commit**

Run: `npm test -- lib/sync/__tests__/engine.test.ts app/api/sync/__tests__/routes.test.ts hub/test/sync.test.mjs`

Expected: PASS.

```bash
git add lib/sync/engine.ts lib/sync/__tests__/engine.test.ts app/api/sync/push/route.ts app/api/sync/__tests__/routes.test.ts hub/sync.mjs
git commit -m "feat(sync): identificar linha bloqueada com segurança"
```

### Task 7: Push Keyset Paginado E Estado Preciso

**Files:**
- Create: `hub/sync-state.mjs`
- Create: `hub/test/sync-state.test.mjs`
- Modify: `hub/sync.mjs:45-61,110-321,466-587`
- Modify: `hub/test/sync.test.mjs:15-61,150-345`

**Interfaces:**
- Local cursor adds: `push_pk text not null default ''`.
- DB consumes: `selectChanged(table, pk, { at, pk }, limit)` and `countChanged(table, pk, { at, pk })`.
- `syncOnce` accepts testable `maxPushPages`, `pushBudgetMs`, `nowFn`.
- Public state: `pendingPush`, `pendingByTable`, `caughtUp`, `phase`, `runningSince`, `lastSyncAt`, `lastSuccessAt`, `consecutiveFailures`, `lastError`, `lastBlockedRow`, `lastSkipped`.

- [ ] **Step 1: Write failing state tests**

```js
// hub/test/sync-state.test.mjs
import { describe, expect, it } from 'vitest';
import { createSyncState, finishAttempt, sanitizeSyncError } from '../sync-state.mjs';

describe('sync state', () => {
  it('distingue sucesso com backlog de caught up', () => {
    const state = createSyncState(['clientes', 'pedidos']);
    finishAttempt(state, {
      ok: true,
      error: null,
      pendingByTable: { clientes: 0, pedidos: 30 },
      lastSkipped: 0,
      lastBlockedRow: null,
      at: '2026-07-14T13:39:27.312Z',
    });
    expect(state).toMatchObject({
      lastSyncOk: true,
      pendingPush: 30,
      caughtUp: false,
      lastSuccessAt: '2026-07-14T13:39:27.312Z',
      consecutiveFailures: 0,
    });
  });

  it('conta falhas consecutivas e sanitiza SQL/multilinha', () => {
    const state = createSyncState(['pedidos']);
    for (let i = 0; i < 2; i += 1) {
      finishAttempt(state, {
        ok: false,
        error: 'psql C:\\TEMP\\x.sql\nduplicate key detail secreto',
        pendingByTable: { pedidos: 1 },
        lastSkipped: 0,
        lastBlockedRow: { table: 'pedidos', pk: 'p1' },
        at: `2026-07-14T13:39:2${i}.000Z`,
      });
    }
    expect(state.consecutiveFailures).toBe(2);
    expect(state.phase).toBe('error');
    expect(sanitizeSyncError(state.lastError)).not.toMatch(/TEMP|duplicate key/i);
  });
});
```

- [ ] **Step 2: Write failing pagination tests**

Add to `hub/test/sync.test.mjs`:

```js
it('push 500 + 500 + 30 envia três páginas e zera backlog', async () => {
  for (let i = 0; i < 1030; i += 1) {
    db.seed('pedidos', {
      id: `p${String(i).padStart(4, '0')}`,
      updated_at: `2026-07-14T10:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
    });
  }
  const sizes = [];
  const pushFn = async ({ rows }) => {
    sizes.push(rows.pedidos.length);
    return { tables: rows };
  };

  await syncOnce({
    db,
    apiBase,
    deviceToken,
    pushFn,
    pullFn: async () => ({ tables: {}, nextCursors: {} }),
  });

  expect(sizes).toEqual([500, 500, 30]);
  expect(getState()).toMatchObject({ pendingPush: 0, caughtUp: true });
});

it('orçamento encerra saudável sem anunciar backlog zero', async () => {
  for (let i = 0; i < 530; i += 1) {
    db.seed('pedidos', {
      id: `p${String(i).padStart(4, '0')}`,
      updated_at: `2026-07-14T11:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
    });
  }
  const times = [0, 0, 101];
  let timeIndex = 0;
  await syncOnce({
    db,
    apiBase,
    deviceToken,
    maxPushPages: 10,
    pushBudgetMs: 100,
    nowFn: () => times[Math.min(timeIndex++, times.length - 1)],
    pushFn: async ({ rows }) => ({ tables: rows }),
    pullFn: async () => ({ tables: {}, nextCursors: {} }),
  });
  expect(getState()).toMatchObject({
    lastSyncOk: true,
    pendingPush: 30,
    pendingByTable: expect.objectContaining({ pedidos: 30 }),
    caughtUp: false,
  });
});

it('keyset não perde 30 linhas quando 530 updated_at são iguais', async () => {
  const timestamp = '2026-07-14T12:00:00.000Z';
  for (let i = 0; i < 530; i += 1) {
    db.seed('pedidos', {
      id: `p${String(i).padStart(4, '0')}`,
      updated_at: timestamp,
    });
  }
  const sizes = [];
  await syncOnce({
    db, apiBase, deviceToken,
    pushFn: async ({ rows }) => {
      sizes.push(rows.pedidos.length);
      return { tables: rows };
    },
    pullFn: async () => ({ tables: {}, nextCursors: {} }),
  });

  expect(sizes).toEqual([500, 30]);
  expect(await db.getCursor('pedidos')).toMatchObject({
    push_at: timestamp,
    push_pk: 'p0529',
  });
  expect(getState()).toMatchObject({ pendingPush: 0, caughtUp: true });
});
```

- [ ] **Step 3: Run the new tests and verify RED**

Run: `npm test -- hub/test/sync-state.test.mjs hub/test/sync.test.mjs`

Expected: FAIL because only one push page is sent and successful cycles report `pendingPush: 0` unconditionally.

- [ ] **Step 4: Implement the state module**

```js
// hub/sync-state.mjs
const SAFE_ERROR = 'Falha no ciclo de sincronização';

export function sanitizeSyncError(error) {
  if (!error) return null;
  const oneLine = String(error).split(/\r?\n/, 1)[0];
  if (/psql|sql|constraint|duplicate key|\\temp\\/i.test(oneLine)) return SAFE_ERROR;
  return oneLine.replace(/[\u0000-\u001f]/g, ' ').slice(0, 240);
}

export function createSyncState(tableNames) {
  return {
    lastSyncOk: null,
    lastError: null,
    lastSyncAt: null,
    lastSuccessAt: null,
    pendingPush: 0,
    pendingByTable: Object.fromEntries(tableNames.map((name) => [name, 0])),
    caughtUp: false,
    phase: 'idle',
    runningSince: null,
    consecutiveFailures: 0,
    lastBlockedRow: null,
    lastSkipped: 0,
  };
}

export function finishAttempt(state, result) {
  const pendingByTable = { ...result.pendingByTable };
  const pendingPush = Object.values(pendingByTable).reduce((sum, value) => sum + value, 0);
  state.lastSyncOk = result.ok;
  state.lastError = result.ok ? null : sanitizeSyncError(result.error);
  state.lastSyncAt = result.at;
  state.pendingByTable = pendingByTable;
  state.pendingPush = pendingPush;
  state.caughtUp = result.backlogCounted !== false && pendingPush === 0;
  state.phase = result.ok ? 'idle' : 'error';
  state.lastSkipped = result.lastSkipped;
  state.lastBlockedRow = result.lastBlockedRow;
  if (result.ok) {
    state.lastSuccessAt = result.at;
    state.consecutiveFailures = 0;
  } else {
    state.consecutiveFailures += 1;
  }
}
```

- [ ] **Step 5: Add keyset cursor storage and exact count**

`ensureCursorTable()` must add the column for existing installations:

```sql
alter table public._sync_cursors
add column if not exists push_pk text not null default '';
```

Update `makeMemDb` to exercise the same tuple semantics:

```js
function pkValue(pk, row) {
  return Array.isArray(pk) ? pk.map((column) => row[column]).join('/') : row[pk];
}

async getCursor(table) {
  return cursors.get(table) || {
    pull_at: '1970-01-01T00:00:00Z',
    push_at: '1970-01-01T00:00:00Z',
    push_pk: '',
  };
},
async selectChanged(table, pk, cursor, limit) {
  return [...tbl(table).values()]
    .filter((row) => {
      const at = String(row.updated_at ?? '');
      const rowPk = String(pkValue(pk, row) ?? '');
      return at > cursor.at || (at === cursor.at && rowPk > cursor.pk);
    })
    .sort((a, b) => {
      const byTime = String(a.updated_at).localeCompare(String(b.updated_at));
      return byTime || String(pkValue(pk, a)).localeCompare(String(pkValue(pk, b)));
    })
    .slice(0, limit);
},
async countChanged(table, pk, cursor) {
  return (await this.selectChanged(table, pk, cursor, Number.MAX_SAFE_INTEGER)).length;
},
async upsert(table, pk, row) {
  tbl(table).set(pkValue(pk, row), { ...row });
},
```

Return `push_pk` from `getCursor`, persist it in `setCursor`, and implement PSQL selection/count as:

```js
const TWO_WAY_NAMES = new Set(TWO_WAY_TABLES.map((table) => table.name));

function assertTwoWaySource(table, pk) {
  if (!TWO_WAY_NAMES.has(table)) throw new Error(`tabela de push não permitida: ${table}`);
  const registered = TWO_WAY_TABLES.find((entry) => entry.name === table);
  if (!registered || registered.pk !== pk) throw new Error(`PK de push inválida: ${table}`);
}

async selectChanged(table, pk, cursor, limit) {
  assertTwoWaySource(table, pk);
  const tableIdent = quoteIdent(table);
  const pkIdent = quoteIdent(pk);
  const rows = await psqlJson(
    cfg,
    `select coalesce(jsonb_agg(to_jsonb(t) order by t.updated_at, t.${pkIdent}::text), ` +
      `'[]'::jsonb)::text from (` +
      `select * from public.${tableIdent} where (updated_at, ${pkIdent}::text) > (` +
      `${sqlStr(cursor.at)}::timestamptz, ${sqlStr(cursor.pk)}::text) ` +
      `order by updated_at asc, ${pkIdent}::text asc limit ${Number(limit)}) t`,
  );
  return rows || [];
},

async countChanged(table, pk, cursor) {
  assertTwoWaySource(table, pk);
  const out = await psqlCmd(
    cfg,
    `select count(*) from public.${quoteIdent(table)} where (updated_at, ` +
      `${quoteIdent(pk)}::text) > (${sqlStr(cursor.at)}::timestamptz, ` +
      `${sqlStr(cursor.pk)}::text)`,
  );
  return Number(out.trim());
},
```

The table comes only from `TWO_WAY_TABLES`; throw before PSQL if it is absent from that allowlist. After a confirmed page, set `push_at` and `push_pk` from the last ordered row. A failed/rejected page leaves both untouched.

- [ ] **Step 6: Replace one-page push with bounded pagination**

Add constants:

```js
export const MAX_PUSH_PAGES_PER_CYCLE = 10;
export const PUSH_BUDGET_MS = 45_000;
```

Extend the function signature without changing existing callers:

```js
export async function syncOnce({
  db,
  apiBase,
  deviceToken,
  fetchImpl = globalThis.fetch,
  pullFn,
  pushFn,
  log,
  maxPushPages = MAX_PUSH_PAGES_PER_CYCLE,
  pushBudgetMs = PUSH_BUDGET_MS,
  nowFn = Date.now,
}) {
```

Add this helper immediately before `syncOnce`:

```js
function safeBlockedRow(table, row, supplied) {
  if (supplied && typeof supplied.table === 'string' && typeof supplied.pk === 'string') {
    return { table: supplied.table.slice(0, 128), pk: supplied.pk.slice(0, 128) };
  }
  return {
    table: table.name,
    pk: String(row?.[table.pk] ?? 'desconhecida')
      .replace(/[^a-zA-Z0-9_.:/-]/g, '')
      .slice(0, 128),
  };
}

async function pushTablePages({ db, table, doPush, budget, nowFn }) {
  while (budget.pages < budget.maxPages && nowFn() <= budget.deadline) {
    let current;
    let rows;
    try {
      current = await db.getCursor(table.name);
      const cursor = { at: current.push_at || EPOCH, pk: current.push_pk || '' };
      rows = await db.selectChanged(table.name, table.pk, cursor, SYNC_LIMIT);
    } catch (error) {
      return { ok: false, error, blockedRow: null };
    }
    if (!rows.length) return { ok: true, error: null, blockedRow: null };

    let result;
    try {
      result = await doPush({ rows: { [table.name]: rows } });
    } catch (error) {
      return {
        ok: false,
        error,
        blockedRow: safeBlockedRow(table, rows[0], error?.blockedRow),
      };
    }

    try {
      const canonical = result?.tables?.[table.name] || [];
      for (const row of canonical) await db.upsert(table.name, table.pk, row);
      const last = rows[rows.length - 1];
      await db.setCursor(table.name, {
        push_at: String(last.updated_at),
        push_pk: String(last[table.pk]),
      });
    } catch (error) {
      return {
        ok: false,
        error,
        blockedRow: safeBlockedRow(table, rows[0], null),
      };
    }

    budget.pages += 1;
    if (rows.length < SYNC_LIMIT) return { ok: true, error: null, blockedRow: null };
  }
  return { ok: true, error: null, blockedRow: null };
}
```

Replace the push loop in `syncOnce` with this exact control flow, preserving the existing pull block after it:

```js
state.phase = 'pushing';
state.lastSkipped = 0;
let ok = true;
let firstError = null;
let lastBlockedRow = null;
const budget = {
  pages: 0,
  maxPages: maxPushPages,
  deadline: nowFn() + pushBudgetMs,
};

for (const table of TWO_WAY_TABLES) {
  const pushed = await pushTablePages({ db, table, doPush, budget, nowFn });
  if (!pushed.ok) {
    ok = false;
    firstError ??= pushed.error?.message || String(pushed.error);
    lastBlockedRow ??= pushed.blockedRow;
    logger.error(`sync push ${table.name}: ${pushed.error?.message || pushed.error}`);
  }
}

state.phase = 'pulling';
```

This intentionally treats HTTP 403 as a failed cycle, continues to later tables and never advances the rejected table cursor.

At cycle end, replace the old state assignments with:

```js
let backlogCounted = true;
let pendingByTable = {};
try {
  for (const table of TWO_WAY_TABLES) {
    const current = await db.getCursor(table.name);
    const cursor = { at: current.push_at || EPOCH, pk: current.push_pk || '' };
    pendingByTable[table.name] = await db.countChanged(
      table.name,
      table.pk,
      cursor,
    );
  }
} catch (error) {
  backlogCounted = false;
  pendingByTable = { ...state.pendingByTable };
  ok = false;
  firstError ??= error?.message || String(error);
}

finishAttempt(state, {
  ok,
  error: firstError,
  pendingByTable,
  backlogCounted,
  lastSkipped: state.lastSkipped,
  lastBlockedRow,
  at: new Date().toISOString(),
});
```

A budget stop without an error remains `lastSyncOk: true` and `caughtUp: false` because the exact count stays non-zero.

- [ ] **Step 7: Run focused tests and full sync suite**

Run: `npm test -- hub/test/sync-state.test.mjs hub/test/sync.test.mjs lib/sync/__tests__/engine.test.ts app/api/sync/__tests__/routes.test.ts`

Expected: PASS, including same-timestamp 530-row regression.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add hub/sync-state.mjs hub/test/sync-state.test.mjs hub/sync.mjs hub/test/sync.test.mjs
git commit -m "feat(sync): drenar backlog com estado preciso"
```

### Task 8: Contrato Público Do `/status`

**Files:**
- Modify: `hub/maestro.mjs:281-301,415-438`
- Modify: `hub/test/maestro.test.mjs`

**Interfaces:**
- Produces: `publicSyncStatus(enabled: boolean, state: SyncState)`.
- Exposes only the approved allowlist; absent fields never fall through via object spread.

- [ ] **Step 1: Write the failing allowlist test**

```js
// append to hub/test/maestro.test.mjs
import { publicSyncStatus } from '../maestro.mjs';

it('/status publica telemetria aprovada sem segredos', () => {
  const publicState = publicSyncStatus(true, {
    lastSyncOk: true,
    pendingPush: 30,
    pendingByTable: { pedidos: 30 },
    caughtUp: false,
    phase: 'idle',
    runningSince: null,
    lastSyncAt: '2026-07-14T13:39:27.312Z',
    lastSuccessAt: '2026-07-14T13:39:27.312Z',
    consecutiveFailures: 0,
    lastError: null,
    lastBlockedRow: null,
    lastSkipped: 0,
    deviceToken: 'não pode sair',
    email: 'não pode sair',
  });

  expect(publicState).toEqual({
    enabled: true,
    lastSyncOk: true,
    pendingPush: 30,
    pendingByTable: { pedidos: 30 },
    caughtUp: false,
    phase: 'idle',
    runningSince: null,
    lastSyncAt: '2026-07-14T13:39:27.312Z',
    lastSuccessAt: '2026-07-14T13:39:27.312Z',
    consecutiveFailures: 0,
    lastError: null,
    lastBlockedRow: null,
    lastSkipped: 0,
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- hub/test/maestro.test.mjs`

Expected: FAIL because `publicSyncStatus` is not exported.

- [ ] **Step 3: Implement the explicit allowlist**

```js
export function publicSyncStatus(enabled, s) {
  return {
    enabled,
    lastSyncOk: s.lastSyncOk,
    pendingPush: s.pendingPush,
    pendingByTable: s.pendingByTable,
    caughtUp: s.caughtUp,
    phase: s.phase,
    runningSince: s.runningSince,
    lastSyncAt: s.lastSyncAt,
    lastSuccessAt: s.lastSuccessAt,
    consecutiveFailures: s.consecutiveFailures,
    lastError: s.lastError,
    lastBlockedRow: s.lastBlockedRow,
    lastSkipped: s.lastSkipped,
  };
}
```

Replace the inline `sync` object in the status response with `publicSyncStatus(!!stopSync, s)`. Update the generation-safe portion of `start()` to:

```js
const myGen = ++gen;
runningSince = now;
state.runningSince = new Date(now).toISOString();
try {
  await syncOnceFn({ db, apiBase, deviceToken, fetchImpl, log: logger });
} catch (error) {
  state.lastSyncOk = false;
  state.lastError = sanitizeSyncError(error?.message || String(error));
  state.phase = 'error';
  state.consecutiveFailures += 1;
  logger.error(`sync tick: ${error?.message}`);
} finally {
  if (myGen === gen) {
    runningSince = null;
    state.runningSince = null;
  }
}
```

Import `sanitizeSyncError` from `sync-state.mjs`. The stale watchdog generation cannot clear the newer `runningSince` because of the `myGen === gen` guard.

- [ ] **Step 4: Run Hub tests and commit**

Run: `npm test -- hub/test/maestro.test.mjs hub/test/sync-state.test.mjs hub/test/sync.test.mjs`

Expected: PASS.

```bash
git add hub/maestro.mjs hub/test/maestro.test.mjs hub/sync.mjs
git commit -m "feat(hub): expor saúde completa do sync"
```

---

## Phase 3: Segurança E Publicação

### Task 9: Hardening Supabase De Baixo Risco

**Files:**
- Create via CLI: `supabase/migrations/*_historico_sync_security_hardening.sql`
- Create: `supabase/tests/20260714_historico_sync_security_hardening.test.sql`

**Interfaces:**
- RLS enabled with zero client policies on `provision_redeem_attempts`.
- `service_role` keeps server-side access through `provision_note_attempt(text)`.
- Trigger functions lose `PUBLIC`/client execute.
- Five advisor-reported functions receive `search_path = public`.

- [ ] **Step 1: Write the failing pgTAP security test**

```sql
-- supabase/tests/20260714_historico_sync_security_hardening.test.sql
begin;
select plan(22);

select ok(c.relrowsecurity, 'RLS ativo em provision_redeem_attempts')
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'provision_redeem_attempts';

select ok(not has_table_privilege('anon', 'public.provision_redeem_attempts', 'select'), 'anon sem select');
select ok(not has_table_privilege('authenticated', 'public.provision_redeem_attempts', 'select'), 'authenticated sem select');
select ok(not has_table_privilege('anon', 'public.provision_redeem_attempts', 'insert'), 'anon sem insert');
select ok(not has_table_privilege('authenticated', 'public.provision_redeem_attempts', 'insert'), 'authenticated sem insert');

select ok(not has_function_privilege('anon', 'public.log_pedido_status_change()', 'execute'), 'trigger log não é RPC anon');
select ok(not has_function_privilege('authenticated', 'public.log_pedido_status_change()', 'execute'), 'trigger log não é RPC autenticada');
select ok(not has_function_privilege('anon', 'public.pedido_reconcilia_cliente()', 'execute'), 'trigger cliente não é RPC anon');
select ok(not has_function_privilege('authenticated', 'public.pedido_reconcilia_cliente()', 'execute'), 'trigger cliente não é RPC autenticada');
select ok(not has_function_privilege('anon', 'public.prevent_vendedor_qtd_entregue()', 'execute'), 'trigger entrega não é RPC anon');
select ok(not has_function_privilege('authenticated', 'public.prevent_vendedor_qtd_entregue()', 'execute'), 'trigger entrega não é RPC autenticada');

select ok(has_function_privilege('authenticated', 'public.current_empresa_id()', 'execute'), 'helper de RLS continua executável');
select ok(has_function_privilege('authenticated', 'public.current_user_role()', 'execute'), 'helper de role continua executável');
select ok(has_function_privilege('authenticated', 'public.is_platform_admin()', 'execute'), 'helper platform continua executável');

select ok('search_path=public' = any(coalesce(proconfig, '{}'::text[])), 'stamp_sync_fields com search_path fixo')
from pg_proc where oid = 'public.stamp_sync_fields()'::regprocedure;
select ok('search_path=public' = any(coalesce(proconfig, '{}'::text[])), 'historico_kpis com search_path fixo')
from pg_proc where oid = 'public.historico_kpis()'::regprocedure;
select ok('search_path=public' = any(coalesce(proconfig, '{}'::text[])), 'admin_top_clientes com search_path fixo')
from pg_proc where oid = 'public.admin_top_clientes(integer)'::regprocedure;
select ok('search_path=public' = any(coalesce(proconfig, '{}'::text[])), 'admin_top_bairros com search_path fixo')
from pg_proc where oid = 'public.admin_top_bairros(integer)'::regprocedure;
select ok('search_path=public' = any(coalesce(proconfig, '{}'::text[])), 'admin_tempo_medio_horas com search_path fixo')
from pg_proc where oid = 'public.admin_tempo_medio_horas()'::regprocedure;

insert into public.empresas (id, nome, slug)
values
  ('00000000-0000-0000-0000-00000000a001', 'Empresa teste A', 'teste-a-20260714'),
  ('00000000-0000-0000-0000-00000000a002', 'Empresa teste B', 'teste-b-20260714');

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
select id,
       '00000000-0000-0000-0000-000000000000'::uuid,
       'authenticated', 'authenticated', email, '', now(),
       '{"provider":"email","providers":["email"]}'::jsonb,
       '{}'::jsonb, now(), now()
from (values
  ('00000000-0000-0000-0000-00000000a011'::uuid, 'admin-a@teste.local'),
  ('00000000-0000-0000-0000-00000000a012'::uuid, 'financeiro-a@teste.local'),
  ('00000000-0000-0000-0000-00000000a013'::uuid, 'vendedor-a@teste.local'),
  ('00000000-0000-0000-0000-00000000a014'::uuid, 'outro-vendedor-a@teste.local')
) as users(id, email);

update public.profiles set
  empresa_id = '00000000-0000-0000-0000-00000000a001',
  role = case id
    when '00000000-0000-0000-0000-00000000a011' then 'admin'::public.user_role
    when '00000000-0000-0000-0000-00000000a012' then 'financeiro'::public.user_role
    else 'vendedor'::public.user_role
  end
where id in (
  '00000000-0000-0000-0000-00000000a011',
  '00000000-0000-0000-0000-00000000a012',
  '00000000-0000-0000-0000-00000000a013',
  '00000000-0000-0000-0000-00000000a014'
);

insert into public.pedidos
  (id, empresa_id, cliente_nome, data_emissao, vendedor_id, status)
values
  ('00000000-0000-0000-0000-00000000a021', '00000000-0000-0000-0000-00000000a001', 'Próprio', current_date, '00000000-0000-0000-0000-00000000a013', 'finalizado'),
  ('00000000-0000-0000-0000-00000000a022', '00000000-0000-0000-0000-00000000a001', 'Sem vendedor', current_date, null, 'em_separacao'),
  ('00000000-0000-0000-0000-00000000a023', '00000000-0000-0000-0000-00000000a001', 'Outro vendedor', current_date, '00000000-0000-0000-0000-00000000a014', 'pendente'),
  ('00000000-0000-0000-0000-00000000a024', '00000000-0000-0000-0000-00000000a002', 'Outro tenant', current_date, null, 'finalizado');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000a011","role":"authenticated"}';
select is((select count(*) from public.pedidos), 3::bigint, 'admin lê todos da própria empresa');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000a012","role":"authenticated"}';
select is((select count(*) from public.pedidos), 3::bigint, 'financeiro lê todos da própria empresa');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000a013","role":"authenticated"}';
select is((select count(*) from public.pedidos), 2::bigint, 'vendedor lê próprios e sem responsável');
reset role;

select * from finish();
rollback;
```

- [ ] **Step 2: Verify RED on the isolated database**

Run: `supabase test db supabase/tests/20260714_historico_sync_security_hardening.test.sql --db-url "$SUPABASE_TEST_DB_URL"`

Expected: at least the RLS and trigger-execute assertions fail.

- [ ] **Step 3: Generate and implement the hardening migration**

Run: `supabase migration new historico_sync_security_hardening`

Put exactly this SQL in the generated file:

```sql
alter table public.provision_redeem_attempts enable row level security;
revoke all on table public.provision_redeem_attempts from public, anon, authenticated;

revoke all on function public.log_pedido_status_change() from public, anon, authenticated;
revoke all on function public.pedido_reconcilia_cliente() from public, anon, authenticated;
revoke all on function public.prevent_vendedor_qtd_entregue() from public, anon, authenticated;

alter function public.stamp_sync_fields() set search_path = public;
alter function public.historico_kpis() set search_path = public;
alter function public.admin_top_clientes(integer) set search_path = public;
alter function public.admin_top_bairros(integer) set search_path = public;
alter function public.admin_tempo_medio_horas() set search_path = public;
```

Do not revoke execute from `current_empresa_id()`, `current_user_role()` or `is_platform_admin()`.

- [ ] **Step 4: Apply/test in isolation and run advisors**

Run: `supabase db push --db-url "$SUPABASE_TEST_DB_URL" --dry-run`

Expected: only pending hardening migration(s).

Run: `supabase db push --db-url "$SUPABASE_TEST_DB_URL"`

Expected: success.

Run: `supabase test db supabase/tests/20260714_historico_sync_security_hardening.test.sql --db-url "$SUPABASE_TEST_DB_URL"`

Expected: `1..22`, all tests `ok`.

Run: `supabase db advisors --db-url "$SUPABASE_TEST_DB_URL" --type security --level warn --fail-on error`

Expected: no disabled-RLS error for `provision_redeem_attempts` and no new error.

- [ ] **Step 5: Re-run the complete RLS scenario after advisors**

Run: `supabase test db supabase/tests/20260714_historico_sync_security_hardening.test.sql --db-url "$SUPABASE_TEST_DB_URL"`

Expected: all 22 assertions pass, including admin, financeiro and vendedor tenant scopes.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/*_historico_sync_security_hardening.sql supabase/tests/20260714_historico_sync_security_hardening.test.sql
git commit -m "security(db): endurecer RLS e funções internas"
```

### Task 10: Dependências Compatíveis E Registro Do Risco Residual

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `docs/security/2026-07-14-npm-audit.md`

**Interfaces:**
- Pins: `@babel/core = 7.29.7`, `hono = 4.12.30`, `js-yaml = 4.3.0` through npm overrides.
- Updates: `vitest` and `@vitest/ui` to `4.1.10` together.
- Leaves: Next.js at `16.2.6`; no force fix.

- [ ] **Step 1: Capture the failing audit baseline**

Run: `npm audit --omit=dev --json > /tmp/exped-audit-before.json`

Expected: non-zero with 5 production findings, including high-severity `hono` and the `next -> postcss` path.

- [ ] **Step 2: Add compatible exact overrides and test-tool updates**

Add to `package.json`:

```json
"overrides": {
  "@babel/core": "7.29.7",
  "hono": "4.12.30",
  "js-yaml": "4.3.0"
}
```

Set both Vitest packages to exact `4.1.10`, then run:

Run: `npm install --package-lock-only`

Expected: lockfile updates without changing Next.js.

Run: `npm ci`

Expected: clean install.

- [ ] **Step 3: Verify audit, tests and build before accepting overrides**

Run: `npm audit --omit=dev --json > /tmp/exped-audit-after.json`

Expected: `hono`, `@babel/core` and `js-yaml` absent; only the Next.js-embedded `postcss` advisory may remain.

Run: `npm test`

Expected: all tests pass.

Run: `npm run typecheck`

Expected: exit 0.

Run: `npm run build`

Expected: production build succeeds on Next.js `16.2.6`.

- [ ] **Step 4: Document the exact residual risk**

```md
# npm audit residual — 2026-07-14

- Residual: `next@16.2.6 -> postcss@8.4.31`, advisory `GHSA-qx2v-qp2m-jg93`.
- The npm suggested fix is `next@9.3.3`, an incompatible downgrade rejected by project policy.
- No `--force` was used. Re-evaluate when a compatible Next.js release updates its embedded PostCSS.
- Cleared in this change: `hono`, `@babel/core`, `js-yaml`, plus the vulnerable Vite/esbuild development path through Vitest 4.1.10.
```

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json docs/security/2026-07-14-npm-audit.md
git commit -m "chore(deps): corrigir dependências transitivas seguras"
```

### Task 11: Release Em Duas Fases E Versão 0.3.21

**Files:**
- Modify: `scripts/release-hub.mjs`
- Modify: `scripts/__tests__/release-hub.test.mjs`
- Modify: `.github/workflows/release-hub.yml`
- Create: `.github/workflows/promote-hub.yml`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- CLI: `node scripts/release-hub.mjs stage [version]` uploads ZIP only.
- CLI: `node scripts/release-hub.mjs promote [version]` hashes the ZIP already in Storage and uploads `manifest.json`.
- Tag `v0.3.21` builds the Windows installer and stages the app ZIP; it does not promote automatically.

- [ ] **Step 1: Write failing release-mode tests**

```js
// append to scripts/__tests__/release-hub.test.mjs
import { parseReleaseArgs, publicZipUrl } from '../release-hub.mjs';

it('stage e promote exigem modo explícito', () => {
  expect(parseReleaseArgs(['stage', '0.3.21'], '0.3.20')).toEqual({
    mode: 'stage', version: '0.3.21',
  });
  expect(parseReleaseArgs(['promote'], '0.3.21')).toEqual({
    mode: 'promote', version: '0.3.21',
  });
  expect(() => parseReleaseArgs([], '0.3.21')).toThrow('use stage ou promote');
});

it('monta a URL pública do ZIP versionado', () => {
  expect(publicZipUrl('ref123', '0.3.21')).toBe(
    'https://ref123.supabase.co/storage/v1/object/public/hub-releases/0.3.21.zip',
  );
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- scripts/__tests__/release-hub.test.mjs`

Expected: FAIL because `parseReleaseArgs` and `publicZipUrl` do not exist.

- [ ] **Step 3: Split staging and promotion**

Implement these pure interfaces:

```js
export function parseReleaseArgs(argv, packageVersion) {
  const [mode, requestedVersion] = argv;
  if (!['stage', 'promote'].includes(mode)) throw new Error('use stage ou promote');
  const version = requestedVersion || packageVersion;
  if (!versaoValida(version)) throw new Error(`versão inválida: ${version}`);
  return { mode, version };
}

export function publicZipUrl(ref, version) {
  return `https://${ref}.supabase.co/storage/v1/object/public/hub-releases/${version}.zip`;
}
```

For `stage`, keep packaging/checksum calculation but upload only `<version>.zip`; print the candidate manifest without writing `manifest.json`. For `promote`, fetch the already-public ZIP, require HTTP 200, hash the received bytes, build the manifest and upload only `manifest.json`. This makes re-promoting `0.3.20` the Hub rollback operation.

Use these concrete functions and main dispatch:

```js
async function stageRelease(ref, sr, version) {
  const releaseDir = montarRelease(version);
  const zipPath = path.join(ROOT, 'releases', `${version}.zip`);
  rmSync(zipPath, { force: true });
  execFileSync(
    'bash',
    ['-c', `cd "${releaseDir}" && zip -qr "${zipPath}" .`],
    { stdio: 'inherit' },
  );
  const zip = readFileSync(zipPath);
  const candidate = buildManifest(
    version,
    publicZipUrl(ref, version),
    sha256Buffer(zip),
  );
  await uploadStorage(ref, sr, `${version}.zip`, zip, 'application/zip');
  console.log('ZIP staged; manifest candidate:', JSON.stringify(candidate));
  return candidate;
}

async function promoteRelease(ref, sr, version) {
  const url = publicZipUrl(ref, version);
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`download ${version}.zip HTTP ${response.status}`);
  }
  const zip = Buffer.from(await response.arrayBuffer());
  const manifest = buildManifest(version, url, sha256Buffer(zip));
  await uploadStorage(
    ref,
    sr,
    'manifest.json',
    Buffer.from(JSON.stringify(manifest)),
    'application/json',
  );
  console.log('Manifest promoted:', JSON.stringify(manifest));
  return manifest;
}

async function main() {
  const ref = process.env.PROJECT_REF;
  const sr = process.env.SR;
  if (!ref || !sr) throw new Error('defina PROJECT_REF e SR (service_role)');
  const packageVersion = JSON.parse(
    readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
  ).version;
  const { mode, version } = parseReleaseArgs(process.argv.slice(2), packageVersion);
  if (mode === 'stage') await stageRelease(ref, sr, version);
  else await promoteRelease(ref, sr, version);
}
```

- [ ] **Step 4: Update CI workflows**

Change the tag workflow command to:

```yaml
- name: Stage release ZIP
  run: node scripts/release-hub.mjs stage
```

Create `.github/workflows/promote-hub.yml`:

```yaml
name: promote-hub
on:
  workflow_dispatch:
    inputs:
      version:
        description: Version already staged in hub-releases
        required: true
        type: string
jobs:
  promote:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: v${{ inputs.version }}
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - name: Promote manifest
        run: node scripts/release-hub.mjs promote "${{ inputs.version }}"
        env:
          SR: ${{ secrets.SUPABASE_SERVICE_ROLE }}
          PROJECT_REF: ${{ secrets.SUPABASE_PROJECT_REF }}
```

- [ ] **Step 5: Bump version only after all prior tasks are green**

Run: `npm version 0.3.21 --no-git-tag-version`

Expected: `package.json` and `package-lock.json` both show `0.3.21`.

- [ ] **Step 6: Run release tests and full build**

Run: `npm test -- scripts/__tests__/release-hub.test.mjs scripts/__tests__/montar-payload.test.mjs`

Expected: PASS.

Run: `npm run build`

Expected: `.next/standalone/server.js` exists.

- [ ] **Step 7: Commit**

```bash
git add scripts/release-hub.mjs scripts/__tests__/release-hub.test.mjs .github/workflows/release-hub.yml .github/workflows/promote-hub.yml package.json package-lock.json
git commit -m "release: preparar publicação segura 0.3.21"
```

### Task 12: Verificação, Deploy, Canário E Rollback

**Files:**
- Verify only: all changed files
- Operational records: Vercel deployment, Supabase migration history, GitHub tag/artifacts, Storage manifest

**Interfaces:**
- Acceptance endpoint: `https://app-exped.vercel.app`.
- Supabase project: `louaguxcohfeicxxqggw`.
- Franzoni local status: `http://127.0.0.1:3001/status`.
- Canary installer: GitHub Actions artifact `ExpedSetup-0.3.21`.

- [ ] **Step 1: Run the complete local verification gate**

Run: `npm test`

Expected: all tests pass; baseline skips remain explicit.

Run: `npm run typecheck`

Expected: exit 0.

Run: `npm run lint`

Expected: exit 0.

Run: `npm run build`

Expected: production build succeeds.

Run: `git diff --check origin/main...HEAD`

Expected: no whitespace errors.

- [ ] **Step 2: Review the final diff and security invariants**

Run: `git diff --stat origin/main...HEAD`

Run: `git diff origin/main...HEAD -- app/api/sync hub lib/sync supabase/migrations supabase/tests`

Verify manually: no token/service key, no raw SQL error in HTTP/status, no delete of business rows, no `npm audit fix --force`, no Next.js downgrade.

- [ ] **Step 3: Capture production pre-deploy facts**

Run through Supabase MCP `execute_sql` using read-only statements:

```sql
select status, count(*) from public.pedidos where deleted_at is null group by status order by status;
select count(*) as pedidos_orfaos
from public.pedidos p left join public.profiles v on v.id = p.vendedor_id
where p.deleted_at is null and p.vendedor_id is not null and v.id is null;
select count(*) as os_orfas
from public.ordens_servico o left join public.profiles v on v.id = o.vendedor_id
where o.deleted_at is null and o.vendedor_id is not null and v.id is null;
select id, numero_mapa, documento_erp, status, valor_total
from public.pedidos where numero_mapa = 4079 and deleted_at is null;
```

Expected: save counts in the task log; map 4079 remains `L001000000282`, `R$ 125,00` and is not modified by deploy.

- [ ] **Step 4: Apply migrations to production with a dry run first**

Run: `supabase db push --linked --dry-run`

Expected: only the two reviewed `20260714` migrations are pending.

Run: `supabase db push --linked`

Expected: success and migration history updated once.

Run: `supabase db advisors --linked --type security --level warn --fail-on error`

Expected: no RLS-disabled error for `provision_redeem_attempts`; existing extension warnings may remain documented.

Re-run both pgTAP files against a test branch after production push; do not run fixture inserts against production.

- [ ] **Step 5: Deploy and smoke-test Vercel**

Use the Vercel plugin/CLI official flow:

```bash
vercel link --yes --project app-exped
vercel pull --yes --environment=production
vercel build --prod
vercel deploy --prebuilt --prod
```

Expected: production alias resolves to `https://app-exped.vercel.app`.

With an authenticated browser session, verify admin and financeiro:

1. `/historico` opens with status `Todos`.
2. Search `4079`, `#4079` and `L001000000282` each finds the same order.
3. All eight status options can be selected.
4. KPIs equal the finalizado-only SQL totals.
5. Button reads `Exportar finalizados`; CSV contains no soft-deleted row.
6. Detail for 4079 says `Status: Em separação. Somente leitura.`.

Also smoke logística and vendedor to confirm their existing RLS scopes.

- [ ] **Step 6: Publish branch/PR and create the release tag after production health**

Push `codex/history-sync-hardening`, open a reviewed PR, merge only after CI and Vercel preview pass, then tag the merged commit:

```bash
git tag v0.3.21
git push origin v0.3.21
```

Expected: `release-hub` stages `0.3.21.zip`; `build-installer` produces `ExpedSetup-0.3.21`; `manifest.json` still points to `0.3.20`.

- [ ] **Step 7: Install the Hub canary at Franzoni**

Run `ExpedSetup.exe` over the existing installation as Administrator. The installer must preserve `C:\Exped\config.json` (`onlyifdoesntexist`) and replace Hub `.mjs` files. After restart:

```powershell
Start-Sleep -Seconds 20
Invoke-RestMethod http://127.0.0.1:3001/status | ConvertTo-Json -Depth 10
```

Expected:

```json
{
  "sync": {
    "enabled": true,
    "lastSyncOk": true,
    "pendingPush": 0,
    "caughtUp": true,
    "phase": "idle",
    "consecutiveFailures": 0,
    "lastError": null,
    "lastBlockedRow": null
  }
}
```

If backlog is non-zero, it must decrease across cycles and never be reported as zero prematurely. Confirm a newly changed local order appears in cloud and that map 4079 remains present.

- [ ] **Step 8: Promote the manifest only after canary success**

Trigger GitHub workflow `promote-hub` with input `0.3.21`, or run with protected credentials:

```bash
node scripts/release-hub.mjs promote 0.3.21
```

Fetch the public manifest and ZIP, recompute SHA-256 and assert equality. Observe at least two normal sync intervals on Franzoni before declaring completion.

- [ ] **Step 9: Exercise rollback commands before closing**

Application rollback: promote the immediately previous healthy Vercel deployment.

Hub/app package rollback:

```bash
node scripts/release-hub.mjs promote 0.3.20
```

Database emergency rollback is additive and explicit:

```sql
drop trigger if exists pedidos_null_missing_vendedor on public.pedidos;
drop trigger if exists ordens_servico_null_missing_vendedor on public.ordens_servico;
drop function if exists public.null_missing_vendedor_id();
```

Do not disable RLS or restore public execute unless a separately reviewed rollback migration proves it necessary. Never delete aliases or orders during rollback.

---

## Final Acceptance Checklist

- [ ] Admin e financeiro abrem Histórico em Todos.
- [ ] `4079`, `#4079` e `L001000000282` encontram o mesmo pedido.
- [ ] Oito status filtram resultados ativos coerentes.
- [ ] KPIs e CSV continuam finalizados-only.
- [ ] Soft-deletados não aparecem em lista, detalhe ou exportação.
- [ ] Mesmo e-mail com UUID diferente cria alias e migra seis referências em transação.
- [ ] Vendedor inexistente vira `null` sem bloquear pedido/OS.
- [ ] Push de 1.030 linhas usa três páginas; timestamps empatados não perdem linhas.
- [ ] Backlog remanescente nunca aparece falsamente como zero.
- [ ] `/status` distingue processando, saudável com backlog, caught up, offline e bloqueado.
- [ ] Nenhum segredo, e-mail, payload ou SQL aparece no diagnóstico público.
- [ ] Advisor não reporta RLS desabilitada em tabela pública.
- [ ] `npm test`, typecheck, lint e build passam.
- [ ] Vercel, migrations, instalador canário e manifest foram publicados nessa ordem.
