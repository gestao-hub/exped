# Ingestão Hiper → Franzoni (nuvem) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir que pedidos do Hiper entrem na plataforma Franzoni automaticamente (sem upload manual), como rascunho, e que o vendedor revise/enriqueça (observação + endereço de entrega) antes de enviar à logística.

**Architecture:** Um Serviço Windows externo (Plano 2) fará `POST` num novo endpoint `/api/ingest/pedido`, enviando o PDF do pedido + os campos estruturados lidos do banco do Hiper. O endpoint autentica por segredo de dispositivo, extrai a forma de pagamento do PDF (único campo que não existe no banco do Hiper a nível de pedido), mapeia o vendedor do Hiper para um usuário Franzoni, e cria o pedido como `rascunho` reusando a lógica de inserção. O vendedor então abre uma nova tela de revisão (`/vendas/[id]/revisar`) que reusa o `PedidoForm` em modo edição para completar e enviar.

**Tech Stack:** Next.js 16 (App Router, route handlers, server actions), Supabase (Postgres + Storage + RLS + service_role), TypeScript estrito, Zod, `unpdf`, vitest, Playwright (qa/).

---

## Contexto do repositório (leia antes de começar)

- Parser do PDF: [lib/parser/franzoni-erp.ts](../../../lib/parser/franzoni-erp.ts) → `parseFranzoniErp(text): PedidoParsed`. Já extrai `forma_pagamento` e `parcelas`.
- Validador alvo: [lib/validators/pedido.ts](../../../lib/validators/pedido.ts) → `pedidoFormSchema` / `PedidoFormInput`.
- Inserção atual: [app/(app)/vendas/actions.ts](../../../app/(app)/vendas/actions.ts) → `criarPedidoAction(raw, status)`. Faz dedup por `documento_erp`, `upsertCliente`, insere em `pedidos` + `pedido_pontos_retirada` + `pedido_itens`.
- Cliente: [lib/clientes/upsert.ts](../../../lib/clientes/upsert.ts) → `upsertCliente`. Tabela `clientes` (colunas `*_padrao`).
- Form: [components/pedido-form.tsx](../../../components/pedido-form.tsx) (514 linhas) — hoje só chama `criarPedidoAction`. Tem `EnderecoSelector` para escolher endereço de entrega.
- Endereços: [components/clientes/endereco-selector.tsx](../../../components/clientes/endereco-selector.tsx), tabela `cliente_enderecos`.
- Supabase server client: [lib/supabase/server.ts](../../../lib/supabase/server.ts) (usa cookies/sessão). **Não existe** client service_role ainda.
- Enums: `pedido_status` = `rascunho | pendente | em_separacao | finalizado | cancelado | parcialmente_entregue`. `ponto_retirada_tipo` = `loja | deposito`.
- `pedidos` tem índice único global em `documento_erp` (`pedidos_documento_erp_uniq`).
- Migrations ficam em `supabase/migrations/AAAAMMDDHHMMSS_*.sql`. **Seguir o protocolo de migrations do CLAUDE.md** (inventariar, dry-run BEGIN/ROLLBACK, ≤100 linhas, validar). Projeto Supabase do Franzoni — aplicar via MCP do projeto correto (confirmar qual antes; NÃO usar um projeto de outro cliente).
- Testes: `npm test` (vitest). Exemplo de teste do parser: [lib/parser/franzoni-erp.test.ts](../../../lib/parser/franzoni-erp.test.ts).

## File Structure (o que cada arquivo faz)

**Criar:**
- `supabase/migrations/20260529120000_hiper_vendedor_map.sql` — tabela de mapeamento `hiper_usuario_id (int) → vendedor_id (uuid)`.
- `lib/supabase/admin.ts` — client Supabase com service_role (server-only), para o endpoint de ingestão que roda sem sessão de usuário.
- `lib/pedidos/inserir.ts` — função pura `inserirPedido(supabase, input, opts)` extraída de `criarPedidoAction` (DRY: usada pela action e pelo endpoint).
- `lib/pedidos/from-db.ts` — `pedidoRowsToFormInput(...)`: converte linhas do banco (pedido + pontos + itens) em `PedidoFormInput` para pré-preencher o form de revisão.
- `lib/parser/extrair-pagamento.ts` — `extrairPagamentoDoPdfText(text)`: reusa `parseFranzoniErp` e devolve só `{ forma_pagamento, parcelas }`.
- `lib/validators/ingest.ts` — `ingestPedidoSchema` / `IngestPedidoInput`: shape do JSON estruturado enviado pelo Serviço Windows.
- `app/api/ingest/pedido/route.ts` — endpoint de ingestão (token auth + parse PDF + merge + inserir).
- `app/(app)/vendas/[id]/revisar/page.tsx` — tela de revisão/enriquecimento do rascunho (Server Component que carrega o pedido e renderiza o form).
- `app/(app)/vendas/[id]/revisar/revisar-client.tsx` — wrapper client que renderiza `PedidoForm` em modo edição.
- `qa/tests/ingest-revisar.spec.ts` — e2e: rascunho sincronizado aparece, vendedor revisa e envia.

**Modificar:**
- `app/(app)/vendas/actions.ts` — `criarPedidoAction` passa a chamar `inserirPedido`; adicionar `atualizarPedidoAction(id, raw, status)`.
- `components/pedido-form.tsx` — aceitar `mode`/`pedidoId` e chamar `atualizarPedidoAction` quando em edição.
- `app/(app)/vendas/[id]/page.tsx` — botão "Revisar e enviar" quando `status === 'rascunho'`.
- `.env.example` — documentar `SUPABASE_SERVICE_ROLE_KEY`, `HIPER_INGEST_SECRET`, `HIPER_DEFAULT_VENDEDOR_ID`.

## Decisões de design (travadas)

- **Auth do endpoint:** header `x-ingest-secret` comparado com `process.env.HIPER_INGEST_SECRET` (1 máquina, 1 segredo). Sem sessão de usuário.
- **Banco vs PDF:** campos estruturados (cliente, itens, datas, total, vendedor) vêm do JSON do Serviço (fonte = banco Hiper). `forma_pagamento`/`parcelas` vêm do parse do PDF. Status inicial = `rascunho`.
- **Vendedor:** JSON traz `hiper_usuario_id`. Endpoint resolve via `hiper_vendedor_map`; fallback `HIPER_DEFAULT_VENDEDOR_ID`. Hoje só há 1 vendedor ativo (Michel, id Hiper = 1).
- **Dedup:** por `documento_erp` (já existe). Reenvio do mesmo pedido = `{ duplicate }`, idempotente.
- **Enriquecimento:** vendedor completa observação + endereço de entrega na tela `/vendas/[id]/revisar` e clica "Enviar para Logística" (→ `atualizarPedidoAction(id, values, 'pendente')`).

---

## Task 1: Migration — tabela `hiper_vendedor_map`

**Files:**
- Create: `supabase/migrations/20260529120000_hiper_vendedor_map.sql`

- [ ] **Step 1: Inventariar (protocolo de migrations)**

Rode via MCP do projeto Supabase do Franzoni:
```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema='public' AND table_name IN ('profiles','hiper_vendedor_map');
```
Esperado: `profiles` existe; `hiper_vendedor_map` NÃO existe.

- [ ] **Step 2: Escrever a migration**

```sql
-- 20260529120000_hiper_vendedor_map.sql
-- Mapeia o usuário/vendedor do Hiper (id_usuario_vendedor) para um vendedor Franzoni.
create table if not exists public.hiper_vendedor_map (
  hiper_usuario_id integer primary key,
  hiper_usuario_nome text,
  vendedor_id uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);

alter table public.hiper_vendedor_map enable row level security;

-- Leitura: qualquer autenticado. Escrita: só admin (via role no profiles).
create policy "hiper_vendedor_map_select"
  on public.hiper_vendedor_map for select
  to authenticated using (true);

create policy "hiper_vendedor_map_admin_write"
  on public.hiper_vendedor_map for all
  to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));
```

- [ ] **Step 3: Dry-run**

Via MCP, rode o conteúdo dentro de `BEGIN; ... ROLLBACK;`. Esperado: sem erros.

- [ ] **Step 4: Aplicar**

Via MCP `apply_migration` com o nome `hiper_vendedor_map`. Depois valide:
```sql
SELECT column_name, data_type FROM information_schema.columns
WHERE table_schema='public' AND table_name='hiper_vendedor_map' ORDER BY ordinal_position;
```
Esperado: `hiper_usuario_id integer`, `hiper_usuario_nome text`, `vendedor_id uuid`, `created_at timestamptz`.

- [ ] **Step 5: Seed (config — preencher com o UUID real do vendedor Franzoni)**

> Descubra o UUID do vendedor: `SELECT id, full_name, email, role FROM profiles WHERE role='vendedor';`
> Substitua `<UUID_DO_MICHEL>` abaixo pelo id real.
```sql
insert into public.hiper_vendedor_map (hiper_usuario_id, hiper_usuario_nome, vendedor_id)
values (1, 'Michel', '<UUID_DO_MICHEL>')
on conflict (hiper_usuario_id) do update set vendedor_id = excluded.vendedor_id;
```

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260529120000_hiper_vendedor_map.sql
git commit -m "feat(db): tabela hiper_vendedor_map para mapear vendedor Hiper->Franzoni"
```

---

## Task 2: Extrair `inserirPedido` (refactor DRY)

**Files:**
- Create: `lib/pedidos/inserir.ts`
- Modify: `app/(app)/vendas/actions.ts` (`criarPedidoAction` passa a delegar)

- [ ] **Step 1: Criar `lib/pedidos/inserir.ts` com a lógica extraída**

```ts
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/types/database';
import type { PedidoFormInput } from '@/lib/validators/pedido';
import { upsertCliente } from '@/lib/clientes/upsert';

export type InserirPedidoResult =
  | { error: string }
  | { id: string; numero: number }
  | { duplicate: true; existing_id: string; existing_numero: number };

/**
 * Insere pedido (cabeçalho + pontos + itens). vendedorId é explícito (a action
 * usa auth.uid(); o endpoint de ingestão usa o vendedor mapeado do Hiper).
 * `d` já deve estar validado por pedidoFormSchema.
 */
export async function inserirPedido(
  supabase: SupabaseClient<Database>,
  d: PedidoFormInput,
  opts: { vendedorId: string; status: 'rascunho' | 'pendente' },
): Promise<InserirPedidoResult> {
  if (d.documento_erp) {
    const { data: existing } = await supabase
      .from('pedidos')
      .select('id, numero_mapa')
      .eq('documento_erp', d.documento_erp)
      .neq('status', 'cancelado')
      .maybeSingle();
    if (existing) {
      return {
        duplicate: true,
        existing_id: existing.id as string,
        existing_numero: existing.numero_mapa as number,
      };
    }
  }

  let cliente_id: string | null = null;
  try {
    const { id } = await upsertCliente(supabase, {
      cnpj_cpf: d.cliente_cnpj_cpf,
      codigo_erp: d.cliente_codigo,
      nome: d.cliente_nome,
      endereco: d.cliente_endereco,
      bairro: d.cliente_bairro,
      cidade: d.cliente_cidade,
      uf: d.cliente_uf,
      cep: d.cliente_cep,
      telefone: d.cliente_telefone,
    });
    cliente_id = id;
  } catch {
    cliente_id = null;
  }

  const { data: pedido, error: insErr } = await supabase
    .from('pedidos')
    .insert({
      documento_erp: d.documento_erp ?? null,
      data_emissao: d.data_emissao ?? null,
      data_entrega: d.data_entrega ?? null,
      cliente_codigo: d.cliente_codigo ?? null,
      cliente_nome: d.cliente_nome,
      cliente_cnpj_cpf: d.cliente_cnpj_cpf ?? null,
      cliente_endereco: d.cliente_endereco ?? null,
      cliente_bairro: d.cliente_bairro ?? null,
      cliente_cidade: d.cliente_cidade ?? null,
      cliente_uf: d.cliente_uf ?? null,
      cliente_cep: d.cliente_cep ?? null,
      cliente_telefone: d.cliente_telefone ?? null,
      cliente_id,
      cliente_endereco_id: d.cliente_endereco_id ?? null,
      forma_pagamento: d.forma_pagamento ?? null,
      parcelas: d.parcelas ?? null,
      valor_total: d.valor_total,
      observacoes: d.observacoes ?? null,
      status: opts.status,
      storage_pdf_path: d.storage_pdf_path ?? null,
      vendedor_id: opts.vendedorId,
    })
    .select('id, numero_mapa')
    .single();

  if (insErr || !pedido) {
    if (insErr?.code === '23505' && insErr.message.includes('pedidos_documento_erp_uniq')) {
      return {
        error: `Já existe um pedido ativo com o documento ${d.documento_erp}. Ele pode ter sido criado por outro vendedor — fale com um admin se precisar reaproveitar este documento.`,
      };
    }
    return { error: insErr?.message ?? 'Falha ao criar pedido' };
  }

  for (let i = 0; i < d.pontos_retirada.length; i++) {
    const ponto = d.pontos_retirada[i];
    const { data: pontoRow, error: pontoErr } = await supabase
      .from('pedido_pontos_retirada')
      .insert({
        pedido_id: pedido.id,
        tipo: ponto.tipo,
        empresa_nome: ponto.empresa_nome,
        endereco: ponto.endereco ?? null,
        ordem: i,
      })
      .select('id')
      .single();
    if (pontoErr || !pontoRow) return { error: `Falha no ponto ${i + 1}: ${pontoErr?.message}` };

    if (ponto.itens.length > 0) {
      const itensPayload = ponto.itens.map((it, idx) => ({
        ponto_retirada_id: pontoRow.id,
        codigo: it.codigo,
        descricao: it.descricao,
        quantidade: it.quantidade,
        unidade: it.unidade,
        preco_unitario: it.preco_unitario,
        desconto: it.desconto,
        total: it.total,
        referencia: it.referencia ?? null,
        ordem: idx,
      }));
      const { error: itErr } = await supabase.from('pedido_itens').insert(itensPayload);
      if (itErr) return { error: `Falha nos itens do ponto ${i + 1}: ${itErr.message}` };
    }
  }

  return { id: pedido.id as string, numero: pedido.numero_mapa as number };
}
```

- [ ] **Step 2: Reescrever `criarPedidoAction` para delegar**

Em `app/(app)/vendas/actions.ts`, substitua o corpo de `criarPedidoAction` (após `const d = parsed.data;`) por:
```ts
  return inserirPedido(supabase, d, { vendedorId: user.id, status });
```
E adicione o import no topo: `import { inserirPedido } from '@/lib/pedidos/inserir';`. Remova o import de `upsertCliente` se ficar sem uso. Mantenha `SavePedidoResult` como alias de `InserirPedidoResult` (ou re-exporte).

- [ ] **Step 3: Typecheck + testes existentes**

Run: `npm run typecheck && npm test`
Expected: PASS (nenhuma regressão; comportamento idêntico).

- [ ] **Step 4: Commit**

```bash
git add lib/pedidos/inserir.ts "app/(app)/vendas/actions.ts"
git commit -m "refactor(pedidos): extrai inserirPedido reutilizável de criarPedidoAction"
```

---

## Task 3: `extrairPagamentoDoPdfText` (TDD)

**Files:**
- Create: `lib/parser/extrair-pagamento.ts`
- Test: `lib/parser/extrair-pagamento.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

```ts
import { describe, it, expect } from 'vitest';
import { extrairPagamentoDoPdfText } from './extrair-pagamento';

describe('extrairPagamentoDoPdfText', () => {
  it('extrai forma de pagamento e parcelas de um pedido com pagamento', () => {
    const texto = [
      'Total 16,79',
      'Forma de Pagamento: ENTREGA A RECEBER 10x',
      'Observação: ENTREGAR EM UMA CASA',
      'É vedada a autenticação deste documento',
    ].join('\n');
    expect(extrairPagamentoDoPdfText(texto)).toEqual({
      forma_pagamento: 'ENTREGA A RECEBER',
      parcelas: '10x',
    });
  });

  it('devolve campos vazios quando o PDF não tem pagamento', () => {
    const texto = 'Total 16,79\nForma de Pagamento:\nÉ vedada';
    expect(extrairPagamentoDoPdfText(texto)).toEqual({
      forma_pagamento: null,
      parcelas: null,
    });
  });
});
```

- [ ] **Step 2: Rodar o teste — deve falhar**

Run: `npm test -- extrair-pagamento`
Expected: FAIL ("extrairPagamentoDoPdfText is not a function").

- [ ] **Step 3: Implementar**

```ts
import { parseFranzoniErp } from './franzoni-erp';

/** Extrai só a forma de pagamento + parcelas do texto do PDF do Hiper. */
export function extrairPagamentoDoPdfText(text: string): {
  forma_pagamento: string | null;
  parcelas: string | null;
} {
  const p = parseFranzoniErp(text);
  return {
    forma_pagamento: p.forma_pagamento ?? null,
    parcelas: p.parcelas ?? null,
  };
}
```

- [ ] **Step 4: Rodar — deve passar**

Run: `npm test -- extrair-pagamento`
Expected: PASS (2 testes).

- [ ] **Step 5: Commit**

```bash
git add lib/parser/extrair-pagamento.ts lib/parser/extrair-pagamento.test.ts
git commit -m "feat(parser): extrairPagamentoDoPdfText para o fluxo de ingestão"
```

---

## Task 4: Schema de ingestão + client service_role

**Files:**
- Create: `lib/validators/ingest.ts`
- Create: `lib/supabase/admin.ts`
- Test: `lib/validators/ingest.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: Teste do schema (falha)**

```ts
import { describe, it, expect } from 'vitest';
import { ingestPedidoSchema } from './ingest';

describe('ingestPedidoSchema', () => {
  it('aceita um payload estruturado mínimo válido', () => {
    const r = ingestPedidoSchema.safeParse({
      documento_erp: 'L602',
      hiper_usuario_id: 1,
      cliente_nome: 'Roseli rosa dos santos',
      valor_total: 1799.9,
      pontos_retirada: [{ tipo: 'loja', empresa_nome: 'Franzoni', itens: [] }],
    });
    expect(r.success).toBe(true);
  });

  it('rejeita sem hiper_usuario_id', () => {
    const r = ingestPedidoSchema.safeParse({ cliente_nome: 'X', valor_total: 0, pontos_retirada: [] });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar — falha**

Run: `npm test -- ingest`
Expected: FAIL ("Cannot find module './ingest'").

- [ ] **Step 3: Implementar `lib/validators/ingest.ts`**

```ts
import { z } from 'zod';
import { itemSchema, pontoRetiradaSchema } from './pedido';

/**
 * Payload estruturado enviado pelo Serviço Windows (campos vindos do banco do
 * Hiper). Pagamento NÃO vem aqui — é extraído do PDF no endpoint.
 */
export const ingestPedidoSchema = z.object({
  documento_erp: z.string().max(80).nullable().optional(),
  data_emissao: z.string().max(80).nullable().optional(),
  data_entrega: z.string().max(80).nullable().optional(),
  hiper_usuario_id: z.number().int(),
  hiper_usuario_nome: z.string().max(250).nullable().optional(),
  cliente_codigo: z.string().max(80).nullable().optional(),
  cliente_nome: z.string().min(1).max(250),
  cliente_cnpj_cpf: z.string().max(80).nullable().optional(),
  cliente_endereco: z.string().max(1000).nullable().optional(),
  cliente_bairro: z.string().max(250).nullable().optional(),
  cliente_cidade: z.string().max(250).nullable().optional(),
  cliente_uf: z.string().max(2).nullable().optional(),
  cliente_cep: z.string().max(80).nullable().optional(),
  cliente_telefone: z.string().max(80).nullable().optional(),
  valor_total: z.number().nonnegative(),
  observacoes: z.string().max(5000).nullable().optional(),
  pontos_retirada: z.array(pontoRetiradaSchema).max(5),
});

export type IngestPedidoInput = z.infer<typeof ingestPedidoSchema>;

// referência usada só para garantir o import de itemSchema acima permanecer válido
export type IngestItem = z.infer<typeof itemSchema>;
```

- [ ] **Step 4: Implementar `lib/supabase/admin.ts`**

```ts
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/types/database';

/**
 * Client com service_role — IGNORA RLS. Usar SOMENTE em código server-side
 * confiável (ex.: endpoint de ingestão autenticado por segredo). Nunca expor
 * ao browser.
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE service_role não configurado');
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
```

- [ ] **Step 5: Documentar env**

Em `.env.example`, adicione:
```
# Ingestão Hiper (Serviço Windows → /api/ingest/pedido)
SUPABASE_SERVICE_ROLE_KEY=
HIPER_INGEST_SECRET=
HIPER_DEFAULT_VENDEDOR_ID=
```

- [ ] **Step 6: Rodar + commit**

Run: `npm test -- ingest && npm run typecheck`
Expected: PASS.
```bash
git add lib/validators/ingest.ts lib/validators/ingest.test.ts lib/supabase/admin.ts .env.example
git commit -m "feat(ingest): schema do payload + client service_role + env"
```

---

## Task 5: Endpoint `/api/ingest/pedido`

**Files:**
- Create: `app/api/ingest/pedido/route.ts`

- [ ] **Step 1: Implementar o route handler**

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { ingestPedidoSchema } from '@/lib/validators/ingest';
import { pedidoFormSchema, type PedidoFormInput } from '@/lib/validators/pedido';
import { extrairPagamentoDoPdfText } from '@/lib/parser/extrair-pagamento';
import { inserirPedido } from '@/lib/pedidos/inserir';

export const runtime = 'nodejs';
export const maxDuration = 30;

const MAX_BYTES = 10 * 1024 * 1024;
const BUCKET = 'pedidos-pdfs';

export async function POST(req: NextRequest) {
  // 1) Auth por segredo de dispositivo
  const secret = req.headers.get('x-ingest-secret');
  if (!process.env.HIPER_INGEST_SECRET || secret !== process.env.HIPER_INGEST_SECRET) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }

  // 2) Multipart: PDF + dados (JSON string)
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'Esperado multipart/form-data' }, { status: 400 });
  }
  const file = form.get('file');
  const dadosRaw = form.get('dados');
  if (typeof dadosRaw !== 'string') {
    return NextResponse.json({ error: 'Campo "dados" (JSON) ausente' }, { status: 400 });
  }
  const dados = ingestPedidoSchema.safeParse(JSON.parse(dadosRaw));
  if (!dados.success) {
    return NextResponse.json({ error: dados.error.issues[0]?.message ?? 'dados inválidos' }, { status: 422 });
  }

  // 3) Pagamento vem do PDF (se enviado)
  let forma_pagamento: string | null = null;
  let parcelas: string | null = null;
  let buffer: Buffer | null = null;
  if (file instanceof File) {
    if (file.size > MAX_BYTES) return NextResponse.json({ error: 'PDF acima de 10 MB' }, { status: 413 });
    buffer = Buffer.from(await file.arrayBuffer());
    try {
      const { extractText, getDocumentProxy } = await import('unpdf');
      const pdf = await getDocumentProxy(new Uint8Array(buffer));
      const { text: pages } = await extractText(pdf, { mergePages: true });
      const text = Array.isArray(pages) ? pages.join('\n') : (pages ?? '');
      ({ forma_pagamento, parcelas } = extrairPagamentoDoPdfText(text));
    } catch {
      // sem pagamento — segue (vendedor preenche na revisão)
    }
  }

  const supabase = createAdminClient();

  // 4) Mapear vendedor Hiper → Franzoni
  const { data: map } = await supabase
    .from('hiper_vendedor_map')
    .select('vendedor_id')
    .eq('hiper_usuario_id', dados.data.hiper_usuario_id)
    .maybeSingle();
  const vendedorId = (map?.vendedor_id as string | undefined) ?? process.env.HIPER_DEFAULT_VENDEDOR_ID;
  if (!vendedorId) {
    return NextResponse.json(
      { error: `Vendedor Hiper ${dados.data.hiper_usuario_id} não mapeado e sem HIPER_DEFAULT_VENDEDOR_ID` },
      { status: 422 },
    );
  }

  // 5) Upload do PDF (opcional)
  let storage_pdf_path: string | null = null;
  if (buffer) {
    const path = `hiper-sync/${(dados.data.documento_erp ?? 'sem-doc')}-${Date.now()}.pdf`;
    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(path, buffer, { contentType: 'application/pdf', upsert: false });
    if (!upErr) storage_pdf_path = path;
  }

  // 6) Montar PedidoFormInput e validar
  const d = dados.data;
  const formInput: PedidoFormInput = {
    documento_erp: d.documento_erp ?? null,
    data_emissao: d.data_emissao ?? null,
    data_entrega: d.data_entrega ?? null,
    cliente_codigo: d.cliente_codigo ?? null,
    cliente_nome: d.cliente_nome,
    cliente_cnpj_cpf: d.cliente_cnpj_cpf ?? null,
    cliente_endereco: d.cliente_endereco ?? null,
    cliente_bairro: d.cliente_bairro ?? null,
    cliente_cidade: d.cliente_cidade ?? null,
    cliente_uf: d.cliente_uf ?? null,
    cliente_cep: d.cliente_cep ?? null,
    cliente_telefone: d.cliente_telefone ?? null,
    cliente_endereco_id: null,
    forma_pagamento,
    parcelas,
    valor_total: d.valor_total,
    observacoes: d.observacoes ?? null,
    storage_pdf_path,
    pontos_retirada: d.pontos_retirada,
  };
  const valid = pedidoFormSchema.safeParse(formInput);
  if (!valid.success) {
    return NextResponse.json({ error: valid.error.issues[0]?.message ?? 'pedido inválido' }, { status: 422 });
  }

  // 7) Inserir como rascunho
  const r = await inserirPedido(supabase, valid.data, { vendedorId, status: 'rascunho' });
  if ('error' in r) return NextResponse.json(r, { status: 500 });
  if ('duplicate' in r) {
    return NextResponse.json({ duplicate: true, id: r.existing_id, numero: r.existing_numero }, { status: 200 });
  }
  return NextResponse.json({ id: r.id, numero: r.numero }, { status: 201 });
}
```

- [ ] **Step 2: Verificação manual (curl)**

Com `npm run dev` rodando e os env setados, teste com o PDF de exemplo:
```bash
curl -s -X POST http://localhost:3000/api/ingest/pedido \
  -H "x-ingest-secret: $HIPER_INGEST_SECRET" \
  -F 'file=@docs/exemplos/PEDIDO_TESTE.pdf;type=application/pdf' \
  -F 'dados={"documento_erp":"L602","hiper_usuario_id":1,"cliente_nome":"Roseli rosa dos santos","cliente_cnpj_cpf":"04631573970","valor_total":1799.90,"pontos_retirada":[{"tipo":"loja","empresa_nome":"Franzoni","itens":[{"codigo":"3023","descricao":"Capa impermeável","quantidade":10,"unidade":"UN","preco_unitario":179.99,"desconto":0,"total":1799.90}]}]}'
```
Expected: `201` com `{ id, numero }`. Sem o header correto → `401`. Reenviar o mesmo `documento_erp` → `200 { duplicate: true }`.

- [ ] **Step 3: Verificar no banco**

`SELECT documento_erp, status, vendedor_id, forma_pagamento, parcelas FROM pedidos WHERE documento_erp='L602';`
Expected: 1 linha, `status='rascunho'`, `vendedor_id` = Michel, `forma_pagamento` preenchido se o PDF tinha.

- [ ] **Step 4: Commit**

```bash
git add app/api/ingest/pedido/route.ts
git commit -m "feat(ingest): endpoint /api/ingest/pedido (token + parse pagamento + inserir rascunho)"
```

---

## Task 6: `atualizarPedidoAction` + `pedidoRowsToFormInput`

**Files:**
- Create: `lib/pedidos/from-db.ts`
- Modify: `app/(app)/vendas/actions.ts`

- [ ] **Step 1: `lib/pedidos/from-db.ts`**

```ts
import type { PedidoFormInput } from '@/lib/validators/pedido';

type PedidoRow = {
  documento_erp: string | null; data_emissao: string | null; data_entrega: string | null;
  cliente_codigo: string | null; cliente_nome: string; cliente_cnpj_cpf: string | null;
  cliente_endereco: string | null; cliente_bairro: string | null; cliente_cidade: string | null;
  cliente_uf: string | null; cliente_cep: string | null; cliente_telefone: string | null;
  cliente_endereco_id: string | null; forma_pagamento: string | null; parcelas: string | null;
  valor_total: number; observacoes: string | null; storage_pdf_path: string | null;
};
type PontoRow = {
  id: string; tipo: 'loja' | 'deposito'; empresa_nome: string; endereco: string | null; ordem: number | null;
  itens: Array<{
    codigo: string; descricao: string; quantidade: number; unidade: string;
    preco_unitario: number; desconto: number; total: number; referencia: string | null; ordem: number | null;
  }>;
};

/** Converte linhas do banco (pedido + pontos + itens) em PedidoFormInput. */
export function pedidoRowsToFormInput(pedido: PedidoRow, pontos: PontoRow[]): PedidoFormInput {
  return {
    documento_erp: pedido.documento_erp,
    data_emissao: pedido.data_emissao,
    data_entrega: pedido.data_entrega,
    cliente_codigo: pedido.cliente_codigo,
    cliente_nome: pedido.cliente_nome,
    cliente_cnpj_cpf: pedido.cliente_cnpj_cpf,
    cliente_endereco: pedido.cliente_endereco,
    cliente_bairro: pedido.cliente_bairro,
    cliente_cidade: pedido.cliente_cidade,
    cliente_uf: pedido.cliente_uf,
    cliente_cep: pedido.cliente_cep,
    cliente_telefone: pedido.cliente_telefone,
    cliente_endereco_id: pedido.cliente_endereco_id,
    forma_pagamento: pedido.forma_pagamento,
    parcelas: pedido.parcelas,
    valor_total: pedido.valor_total,
    observacoes: pedido.observacoes,
    storage_pdf_path: pedido.storage_pdf_path,
    pontos_retirada: [...pontos]
      .sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0))
      .map((p) => ({
        tipo: p.tipo,
        empresa_nome: p.empresa_nome,
        endereco: p.endereco,
        itens: [...p.itens]
          .sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0))
          .map((it) => ({
            codigo: it.codigo, descricao: it.descricao, quantidade: it.quantidade,
            unidade: it.unidade, preco_unitario: it.preco_unitario, desconto: it.desconto,
            total: it.total, referencia: it.referencia,
          })),
      })),
  };
}
```

- [ ] **Step 2: Adicionar `atualizarPedidoAction` em `app/(app)/vendas/actions.ts`**

```ts
/**
 * Atualiza um pedido existente (cabeçalho + substitui pontos/itens) e define o
 * status. Usado na tela de revisão do rascunho sincronizado do Hiper.
 */
export async function atualizarPedidoAction(
  id: string,
  raw: PedidoFormInput,
  status: 'rascunho' | 'pendente',
): Promise<SavePedidoResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Não autenticado' };

  const parsed = pedidoFormSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos' };
  const d = parsed.data;

  const { data: pedido, error: upErr } = await supabase
    .from('pedidos')
    .update({
      data_emissao: d.data_emissao ?? null,
      data_entrega: d.data_entrega ?? null,
      cliente_codigo: d.cliente_codigo ?? null,
      cliente_nome: d.cliente_nome,
      cliente_cnpj_cpf: d.cliente_cnpj_cpf ?? null,
      cliente_endereco: d.cliente_endereco ?? null,
      cliente_bairro: d.cliente_bairro ?? null,
      cliente_cidade: d.cliente_cidade ?? null,
      cliente_uf: d.cliente_uf ?? null,
      cliente_cep: d.cliente_cep ?? null,
      cliente_telefone: d.cliente_telefone ?? null,
      cliente_endereco_id: d.cliente_endereco_id ?? null,
      forma_pagamento: d.forma_pagamento ?? null,
      parcelas: d.parcelas ?? null,
      valor_total: d.valor_total,
      observacoes: d.observacoes ?? null,
      status,
    })
    .eq('id', id)
    .select('id, numero_mapa')
    .single();
  if (upErr || !pedido) return { error: upErr?.message ?? 'Falha ao atualizar' };

  // Substitui pontos/itens (apaga e recria — itens não têm entrega registrada num rascunho)
  const { data: pontosAntigos } = await supabase
    .from('pedido_pontos_retirada').select('id').eq('pedido_id', id);
  const idsAntigos = (pontosAntigos ?? []).map((p) => p.id);
  if (idsAntigos.length) {
    await supabase.from('pedido_itens').delete().in('ponto_retirada_id', idsAntigos);
    await supabase.from('pedido_pontos_retirada').delete().eq('pedido_id', id);
  }
  for (let i = 0; i < d.pontos_retirada.length; i++) {
    const ponto = d.pontos_retirada[i];
    const { data: pontoRow, error: pErr } = await supabase
      .from('pedido_pontos_retirada')
      .insert({ pedido_id: id, tipo: ponto.tipo, empresa_nome: ponto.empresa_nome, endereco: ponto.endereco ?? null, ordem: i })
      .select('id').single();
    if (pErr || !pontoRow) return { error: `Falha no ponto ${i + 1}: ${pErr?.message}` };
    if (ponto.itens.length) {
      const itens = ponto.itens.map((it, idx) => ({
        ponto_retirada_id: pontoRow.id, codigo: it.codigo, descricao: it.descricao,
        quantidade: it.quantidade, unidade: it.unidade, preco_unitario: it.preco_unitario,
        desconto: it.desconto, total: it.total, referencia: it.referencia ?? null, ordem: idx,
      }));
      const { error: iErr } = await supabase.from('pedido_itens').insert(itens);
      if (iErr) return { error: `Falha nos itens do ponto ${i + 1}: ${iErr.message}` };
    }
  }

  revalidatePath('/vendas');
  revalidatePath(`/vendas/${id}`);
  revalidatePath('/logistica');
  return { id: pedido.id as string, numero: pedido.numero_mapa as number };
}
```

- [ ] **Step 3: Typecheck + commit**

Run: `npm run typecheck`
Expected: PASS.
```bash
git add lib/pedidos/from-db.ts "app/(app)/vendas/actions.ts"
git commit -m "feat(pedidos): atualizarPedidoAction + pedidoRowsToFormInput para revisão"
```

---

## Task 7: `PedidoForm` em modo edição

**Files:**
- Modify: `components/pedido-form.tsx`

- [ ] **Step 1: Adicionar props de modo**

Troque a assinatura e o `submit` do componente:
```tsx
import { criarPedidoAction, atualizarPedidoAction } from '@/app/(app)/vendas/actions';

export function PedidoForm({
  defaultValues,
  mode = 'create',
  pedidoId,
}: {
  defaultValues: PedidoFormInput;
  mode?: 'create' | 'edit';
  pedidoId?: string;
}) {
```
Dentro de `submit`, troque a chamada:
```tsx
        startTransition(async () => {
          const r =
            mode === 'edit' && pedidoId
              ? await atualizarPedidoAction(pedidoId, values, status)
              : await criarPedidoAction(values, status);
```
O resto do `submit` (toasts, redirect, duplicate) permanece igual.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (a página `/vendas/novo` continua usando `PedidoForm` sem `mode`, default `create`).

- [ ] **Step 3: Commit**

```bash
git add components/pedido-form.tsx
git commit -m "feat(pedido-form): modo edição chamando atualizarPedidoAction"
```

---

## Task 8: Tela de revisão `/vendas/[id]/revisar`

**Files:**
- Create: `app/(app)/vendas/[id]/revisar/page.tsx`
- Create: `app/(app)/vendas/[id]/revisar/revisar-client.tsx`
- Modify: `app/(app)/vendas/[id]/page.tsx` (botão "Revisar e enviar")

- [ ] **Step 1: `revisar-client.tsx`**

```tsx
'use client';
import { PageHeader } from '@/components/layout/page-header';
import { PedidoForm } from '@/components/pedido-form';
import type { PedidoFormInput } from '@/lib/validators/pedido';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

export function RevisarClient({ id, defaults }: { id: string; defaults: PedidoFormInput }) {
  return (
    <>
      <PageHeader
        title="Revisar Pedido (Hiper)"
        description="Confira os dados, escolha o endereço de entrega e ajuste a observação antes de enviar para a logística."
        actions={
          <Link href={`/vendas/${id}`}>
            <Button variant="outline"><ArrowLeft className="h-4 w-4 mr-1" /> Voltar</Button>
          </Link>
        }
      />
      <PedidoForm defaultValues={defaults} mode="edit" pedidoId={id} />
    </>
  );
}
```

- [ ] **Step 2: `page.tsx` (Server Component)**

```tsx
import { notFound, redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { pedidoRowsToFormInput } from '@/lib/pedidos/from-db';
import { RevisarClient } from './revisar-client';

export default async function RevisarPedidoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const [{ data: pedido }, { data: pontos }] = await Promise.all([
    supabase.from('pedidos').select('*').eq('id', id).single(),
    supabase.from('pedido_pontos_retirada').select('*, itens:pedido_itens(*)').eq('pedido_id', id).order('ordem'),
  ]);
  if (!pedido) notFound();
  // Só faz sentido revisar rascunho; senão manda pra visão normal.
  if (pedido.status !== 'rascunho') redirect(`/vendas/${id}`);

  const defaults = pedidoRowsToFormInput(
    pedido as Parameters<typeof pedidoRowsToFormInput>[0],
    (pontos ?? []) as Parameters<typeof pedidoRowsToFormInput>[1],
  );
  return <RevisarClient id={id} defaults={defaults} />;
}
```

- [ ] **Step 3: Botão na página de detalhe**

Em `app/(app)/vendas/[id]/page.tsx`, dentro do bloco `actions` do `PageHeader`, antes de `{podeCancelar && ...}`, adicione:
```tsx
            {pedido.status === 'rascunho' && (
              <Link
                href={`/vendas/${id}/revisar`}
                className={cn(buttonVariants({ variant: 'default' }), 'bg-franzoni-orange hover:bg-franzoni-orange-600')}
              >
                Revisar e enviar
              </Link>
            )}
```

- [ ] **Step 4: Typecheck + rodar**

Run: `npm run typecheck && npm run build`
Expected: PASS / build sem erros.

- [ ] **Step 5: Commit**

```bash
git add "app/(app)/vendas/[id]/revisar" "app/(app)/vendas/[id]/page.tsx"
git commit -m "feat(vendas): tela de revisão do rascunho sincronizado do Hiper"
```

---

## Task 9: E2E (Playwright) do fluxo de revisão

**Files:**
- Create: `qa/tests/ingest-revisar.spec.ts`

> Use os profiles/login existentes em `qa/tests/profiles.ts` (ver specs atuais como `qa/tests/upload.spec.ts`). O teste cria um rascunho direto via `/api/ingest/pedido` (com `x-ingest-secret`), depois loga como vendedor e revisa.

- [ ] **Step 1: Escrever o spec**

```ts
import { test, expect } from '@playwright/test';

const SECRET = process.env.HIPER_INGEST_SECRET!;

test('rascunho sincronizado do Hiper aparece e pode ser revisado e enviado', async ({ page, request }) => {
  const doc = `E2E-${Date.now()}`;
  const res = await request.post('/api/ingest/pedido', {
    headers: { 'x-ingest-secret': SECRET },
    multipart: {
      dados: JSON.stringify({
        documento_erp: doc, hiper_usuario_id: 1, cliente_nome: 'Cliente E2E',
        cliente_cnpj_cpf: '04631573970', valor_total: 100,
        pontos_retirada: [{ tipo: 'loja', empresa_nome: 'Franzoni', itens: [
          { codigo: '1', descricao: 'Item', quantidade: 1, unidade: 'UN', preco_unitario: 100, desconto: 0, total: 100 },
        ] }],
      }),
    },
  });
  expect(res.status()).toBe(201);
  const { id } = await res.json();

  // login vendedor (helper do projeto) e abrir revisão
  await page.goto(`/vendas/${id}/revisar`);
  await expect(page.getByText('Revisar Pedido (Hiper)')).toBeVisible();
  await page.getByPlaceholder('Instruções de entrega, referências, etc.').fill('Entregar pela manhã');
  await page.getByRole('button', { name: 'Enviar para Logística' }).click();
  await expect(page).toHaveURL(new RegExp(`/vendas/${id}$`));
});
```

- [ ] **Step 2: Rodar**

Run: `npx playwright test qa/tests/ingest-revisar.spec.ts` (com app + env up).
Expected: PASS. Ajuste o login conforme o helper real do projeto se necessário.

- [ ] **Step 3: Commit**

```bash
git add qa/tests/ingest-revisar.spec.ts
git commit -m "test(e2e): fluxo de ingestão + revisão do rascunho Hiper"
```

---

## Self-Review (cobertura do spec)

- API oficial não usada — correto (decisão: ler banco + PDF). ✓
- Pagamento do PDF (não existe no banco a nível de pedido) → Task 3 + endpoint. ✓
- Vendedor Hiper→Franzoni → Task 1 (map) + endpoint. ✓
- Entra como rascunho, vendedor enriquece observação + endereço → Tasks 6/7/8 (revisar reusa `EnderecoSelector` via `PedidoForm`). ✓
- Dedup por documento_erp → reusado em `inserirPedido`. ✓
- Trigger por PDF e leitura do SQL Server → **Plano 2** (Serviço Windows), fora deste plano. ✓

**Pendências de config (não-código) antes de produção:**
- Setar `SUPABASE_SERVICE_ROLE_KEY`, `HIPER_INGEST_SECRET`, `HIPER_DEFAULT_VENDEDOR_ID` no ambiente (Vercel).
- Rodar o seed da Task 1 com o UUID real do Michel.
- Confirmar no Hiper o significado de `situacao=5` (gatilho que o Plano 2 vai usar).
