# Modalidade por item + "Exige emissão" — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar a cada item do pedido uma **Modalidade** (Imediato/Loja/Entrega) como fonte da verdade, com destino derivado e suporte a multi-endereço; e adicionar um checkbox **"Exige emissão"** no financeiro.

**Architecture:** `pedido_itens` ganha `modalidade` (enum). `ponto_retirada_id` vira nullable e passa a ser o **destino** do item (null p/ Imediato; loja/endereço p/ os outros). A tabela `pedido_pontos_retirada` continua sendo o registro de destinos (multi-endereço via `cliente_enderecos`). O seletor global "Modo de retirada" some; o card de destino é derivado. Persistência via `persistirFilhosPedido`/`reconcileChildren` (já existente) + `modalidade` no item.

**Tech Stack:** Next.js (App Router, server actions), React Hook Form + Zod, Supabase (Postgres + migrations em `supabase/migrations/*.sql`), Vitest.

**Spec:** `docs/superpowers/specs/2026-06-12-pedido-modalidade-e-exige-emissao-design.md`

---

## File structure (o que cada arquivo faz)

| Arquivo | Mudança |
|---|---|
| `supabase/migrations/2026..._exige_emissao.sql` | **Criar** — coluna `pedidos.exige_emissao` |
| `supabase/migrations/2026..._modalidade_item.sql` | **Criar** — enum `modalidade_item`, coluna `pedido_itens.modalidade`, backfill, `ponto_retirada_id` nullable |
| `lib/types/database.ts` | **Modificar** — regen dos tipos (novas colunas/enum) |
| `lib/validators/financeiro.ts` | **Modificar** — `exige_emissao` no schema |
| `lib/validators/pedido.ts` | **Modificar** — `modalidade` no `itemSchema`; afrouxar `superRefine` |
| `app/(app)/financeiro/[id]/financeiro-form.tsx` | **Modificar** — checkbox "Exige emissão" |
| `app/(app)/financeiro/[id]/page.tsx` + `actions.ts` | **Modificar** — carregar/gravar `exige_emissao` |
| `app/(app)/vendas/actions.ts` | **Modificar** — gravar `modalidade` no insert/update do item |
| `lib/parser/to-form-input.ts` | **Modificar** — item nasce `modalidade: 'loja'` |
| `components/pedido-form.tsx` | **Modificar** — coluna Modalidade, card Destino derivado, remove seletor global, multi-endereço, atalho "aplicar a todos" |
| `lib/parser/hiper-erp.test.ts` / novos testes | **Modificar/Criar** — cobrir modalidade |

> **Convenção de migração (regra do ecossistema):** inventariar schema real → dry-run `BEGIN/ROLLBACK` → aplicar (≤100 linhas) → query de sanidade → só commitar após validar. Nome do arquivo no padrão `YYYYMMDDHHMMSS_descricao.sql` (ver migrations existentes).

---

# FASE 0 — Request 1: "Exige emissão" (aquecimento, independente)

### Task 1: Migração — `pedidos.exige_emissao`

**Files:**
- Create: `supabase/migrations/20260612000001_exige_emissao.sql`

- [ ] **Step 1: Inventariar a tabela `pedidos`** (confirmar que `exige_emissao` não existe)

Run:
```bash
grep -n "exige_emissao\|receber_na_entrega" lib/types/database.ts | head
```
Expected: só `receber_na_entrega` aparece; `exige_emissao` não.

- [ ] **Step 2: Escrever a migração**

```sql
-- 20260612000001_exige_emissao.sql
-- Flag conferida no financeiro: se o pedido exige emissão de nota.
ALTER TABLE public.pedidos
  ADD COLUMN IF NOT EXISTS exige_emissao boolean NOT NULL DEFAULT false;
```

- [ ] **Step 3: Dry-run no banco** (BEGIN/ROLLBACK via supabase MCP `execute_sql` ou `psql`)

```sql
BEGIN;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS exige_emissao boolean NOT NULL DEFAULT false;
SELECT count(*) FILTER (WHERE exige_emissao = false) AS todos_false, count(*) AS total FROM public.pedidos;
ROLLBACK;
```
Expected: `todos_false = total` (a coluna nasce false em todos), sem erro.

- [ ] **Step 4: Aplicar a migração** (no ambiente real, via o fluxo de migração do projeto)

- [ ] **Step 5: Regenerar tipos** (ver Task 4 — pode agrupar com a regen da Fase 1) ou adicionar manualmente `exige_emissao: boolean` no Row/Insert/Update de `pedidos` em `lib/types/database.ts`.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260612000001_exige_emissao.sql lib/types/database.ts
git commit -m "feat(financeiro): coluna exige_emissao em pedidos"
```

---

### Task 2: Financeiro — validator + checkbox + action

**Files:**
- Modify: `lib/validators/financeiro.ts`
- Modify: `app/(app)/financeiro/[id]/financeiro-form.tsx:191-199`
- Modify: `app/(app)/financeiro/actions.ts` (a `salvarFinanceiroAction`) e `app/(app)/financeiro/[id]/page.tsx` (defaultValues)

- [ ] **Step 1: Teste do validator** (Vitest)

Create `lib/validators/__tests__/financeiro.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { financeiroFormSchema } from '@/lib/validators/financeiro';

describe('financeiroFormSchema', () => {
  it('aceita exige_emissao boolean', () => {
    const r = financeiroFormSchema.safeParse({ valor_total: 10, exige_emissao: true });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.exige_emissao).toBe(true);
  });
  it('exige_emissao é opcional', () => {
    const r = financeiroFormSchema.safeParse({ valor_total: 10 });
    expect(r.success).toBe(true);
  });
});
```

- [ ] **Step 2: Rodar — deve falhar** (campo ainda não existe no schema)

Run: `npx vitest run lib/validators/__tests__/financeiro.test.ts`
Expected: FAIL (o parse ignora `exige_emissao` ou o acesso a `r.data.exige_emissao` é `undefined`).

- [ ] **Step 3: Adicionar ao schema**

Em `lib/validators/financeiro.ts`, dentro do `z.object({...})`, após `receber_na_entrega`:
```ts
  exige_emissao:      z.boolean().optional(),
```

- [ ] **Step 4: Rodar — deve passar**

Run: `npx vitest run lib/validators/__tests__/financeiro.test.ts`
Expected: PASS.

- [ ] **Step 5: Checkbox no form**

Em `app/(app)/financeiro/[id]/financeiro-form.tsx`, logo após o `<label>` do "Receber na entrega" (linha ~199), adicionar:
```tsx
        <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
          <input
            type="checkbox"
            disabled={!editavel}
            {...register('exige_emissao')}
            className="h-4 w-4"
          />
          Exige emissão
        </label>
```

- [ ] **Step 6: Persistir + carregar** — em `app/(app)/financeiro/actions.ts` (`salvarFinanceiroAction`/`liberarParaLogisticaAction`), incluir `exige_emissao: values.exige_emissao ?? false` no `.update({...})` de `pedidos`. Em `app/(app)/financeiro/[id]/page.tsx`, incluir `exige_emissao: pedido.exige_emissao` nos `defaultValues`.

- [ ] **Step 7: Verificar build + tipos**

Run: `npx tsc --noEmit` (Expected: 0 erros novos) e `npm run build` (Expected: sucesso).

- [ ] **Step 8: Commit**

```bash
git add lib/validators/financeiro.ts lib/validators/__tests__/financeiro.test.ts "app/(app)/financeiro"
git commit -m "feat(financeiro): checkbox 'Exige emissão' na conferência"
```

---

# FASE 1 — Request 2: camada de dados (modalidade)

### Task 3: Migração — enum `modalidade_item` + coluna + backfill

**Files:**
- Create: `supabase/migrations/20260612000002_modalidade_item.sql`

- [ ] **Step 1: Inventariar** (confirmar tipos/colunas reais)

```sql
SELECT column_name, is_nullable FROM information_schema.columns
 WHERE table_schema='public' AND table_name='pedido_itens' AND column_name IN ('ponto_retirada_id','modalidade');
SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='ponto_retirada_destino';
```
Expected: `ponto_retirada_id` = NOT NULL, sem `modalidade`; enum destino = loja/deposito/entrega.

- [ ] **Step 2: Escrever a migração**

```sql
-- 20260612000002_modalidade_item.sql
-- Modalidade por item (fonte da verdade) + ponto_retirada_id (destino) nullable.
CREATE TYPE public.modalidade_item AS ENUM ('imediato', 'loja', 'entrega');

ALTER TABLE public.pedido_itens
  ADD COLUMN modalidade public.modalidade_item NOT NULL DEFAULT 'loja';

-- Backfill: deriva do tipo do ponto atual (entrega→entrega; loja/deposito→loja).
UPDATE public.pedido_itens i
   SET modalidade = CASE WHEN p.tipo = 'entrega' THEN 'entrega'::public.modalidade_item
                         ELSE 'loja'::public.modalidade_item END
  FROM public.pedido_pontos_retirada p
 WHERE i.ponto_retirada_id = p.id;

ALTER TABLE public.pedido_itens
  ALTER COLUMN ponto_retirada_id DROP NOT NULL;
```

- [ ] **Step 3: Dry-run (BEGIN/ROLLBACK)** com query de sanidade

```sql
BEGIN;
-- (colar a migração acima)
SELECT modalidade, count(*) FROM public.pedido_itens GROUP BY 1;
SELECT count(*) AS itens_sem_destino FROM public.pedido_itens WHERE ponto_retirada_id IS NULL;
ROLLBACK;
```
Expected: distribuição loja/entrega coerente; `itens_sem_destino = 0` (nada virou null no backfill).

- [ ] **Step 4: Aplicar a migração** (fluxo real do projeto).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260612000002_modalidade_item.sql
git commit -m "feat(pedido): enum modalidade_item + coluna + backfill; ponto_retirada_id nullable"
```

---

### Task 4: Regenerar tipos do banco

**Files:**
- Modify: `lib/types/database.ts`

- [ ] **Step 1: Regenerar** (comando do projeto; ex.)

Run: `npx supabase gen types typescript --linked > lib/types/database.ts`
(ou o script equivalente — checar `package.json`/README do projeto)

- [ ] **Step 2: Conferir** que `pedido_itens.modalidade` (enum `modalidade_item`), `pedido_itens.ponto_retirada_id: string | null` e `pedidos.exige_emissao: boolean` aparecem.

Run: `grep -n "modalidade\|exige_emissao" lib/types/database.ts | head`

- [ ] **Step 3: Commit**

```bash
git add lib/types/database.ts
git commit -m "chore(types): regen após modalidade_item e exige_emissao"
```

---

### Task 5: Validator do pedido — `modalidade` no item

**Files:**
- Modify: `lib/validators/pedido.ts`
- Test: `lib/validators/__tests__/pedido.test.ts`

- [ ] **Step 1: Teste**

Create `lib/validators/__tests__/pedido.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { itemSchema } from '@/lib/validators/pedido';

const base = { codigo: 'X', descricao: 'D', quantidade: 1, unidade: 'UN', preco_unitario: 1, desconto: 0, total: 1 };

describe('itemSchema.modalidade', () => {
  it('aceita imediato/loja/entrega', () => {
    for (const m of ['imediato', 'loja', 'entrega'] as const) {
      expect(itemSchema.safeParse({ ...base, modalidade: m }).success).toBe(true);
    }
  });
  it('rejeita modalidade inválida', () => {
    expect(itemSchema.safeParse({ ...base, modalidade: 'xpto' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar — falha**

Run: `npx vitest run lib/validators/__tests__/pedido.test.ts`
Expected: FAIL.

- [ ] **Step 3: Adicionar ao `itemSchema`**

Em `lib/validators/pedido.ts`, dentro de `itemSchema = z.object({...})`, adicionar:
```ts
  modalidade:     z.enum(['imediato', 'loja', 'entrega']),
```

- [ ] **Step 4: Afrouxar o `superRefine`** — remover a regra "ponto com >1 ponto exige itens" (itens deixam de viver dentro do ponto). Substituir o bloco do `superRefine` por uma checagem nova: para cada ponto, ele é apenas um destino; não exigir itens nele. (Manter `pontos_retirada.min(1)` enquanto a UI ainda monta destinos; ver Task 9.)

- [ ] **Step 5: Rodar — passa**

Run: `npx vitest run lib/validators/__tests__/pedido.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/validators/pedido.ts lib/validators/__tests__/pedido.test.ts
git commit -m "feat(pedido): modalidade no itemSchema"
```

---

### Task 6: Persistência — gravar `modalidade` no item

**Files:**
- Modify: `app/(app)/vendas/actions.ts:99-130` (update e insert do item dentro de `persistirFilhosPedido`)

- [ ] **Step 1: Adicionar `modalidade` no UPDATE do item** (linha ~101)

No objeto do `.update({...})` do `pedido_itens`, adicionar `modalidade: it.data.modalidade,`.

- [ ] **Step 2: Adicionar `modalidade` no INSERT do item** (linha ~116)

No objeto do `.insert({...})` do `pedido_itens`, adicionar `modalidade: it.data.modalidade,`.

> `it.data` é o item validado (Task 5), então `modalidade` já existe no tipo.

- [ ] **Step 3: Build/tipos**

Run: `npx tsc --noEmit`
Expected: 0 erros novos.

- [ ] **Step 4: Commit**

```bash
git add "app/(app)/vendas/actions.ts"
git commit -m "feat(pedido): persistir modalidade do item"
```

---

### Task 7: Parser — item nasce `modalidade: 'loja'`

**Files:**
- Modify: `lib/parser/to-form-input.ts` (onde os itens do form são montados)
- Test: `lib/parser/hiper-erp.test.ts` (ou um teste de `to-form-input`)

- [ ] **Step 1: Teste** — adicionar ao teste de parse uma asserção: `expect(item.modalidade).toBe('loja')` para um item parseado.

- [ ] **Step 2: Rodar — falha.**

Run: `npx vitest run lib/parser`
Expected: FAIL (modalidade undefined).

- [ ] **Step 3: Setar default** em `to-form-input.ts`: ao mapear cada item para o form, incluir `modalidade: 'loja'`.

- [ ] **Step 4: Rodar — passa.**

Run: `npx vitest run lib/parser`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/parser/to-form-input.ts lib/parser/hiper-erp.test.ts
git commit -m "feat(parser): item parseado nasce modalidade 'loja'"
```

---

# FASE 2 — Request 2: UX do pedido-form

> Esta fase é o maior trabalho: refatorar `components/pedido-form.tsx` (868 linhas). Hoje os itens vivem aninhados em `pontos_retirada[].itens` (um `<ItensTable>` por ponto, ~linha 687) e há um seletor global "Modo de retirada" (~linha 354-373). Alvo: **uma tabela de itens com coluna Modalidade**, **card Destino derivado**, **sem seletor global**, **multi-endereço**, **atalho aplicar-a-todos**. Como a persistência (Task 6) ainda espera `pontos_retirada[].itens`, o form mantém essa estrutura internamente e a coluna Modalidade + os destinos derivam dela (ver abaixo). Trabalhar incrementalmente, com `npm run build` verde a cada task.

### Task 8: Coluna "Modalidade" na tabela de itens

**Files:**
- Modify: `components/pedido-form.tsx` (componente da tabela de itens, ~linha 724-790)

- [ ] **Step 1: Adicionar o cabeçalho** "Modalidade" na `<thead>` da tabela de itens (linha ~725), entre "DESCRIÇÃO" e "QTD".

- [ ] **Step 2: Adicionar a célula** com um `<select>` por linha, registrado no campo do item:
```tsx
<td className="px-2 py-1">
  <Controller
    control={control}
    name={`pontos_retirada.${pontoIndex}.itens.${i}.modalidade`}
    render={({ field }) => (
      <select value={field.value ?? 'loja'} onChange={field.onChange}
        className="h-8 rounded-md border border-input bg-transparent px-2 text-sm">
        <option value="imediato">Imediato</option>
        <option value="loja">Loja</option>
        <option value="entrega">Entrega</option>
      </select>
    )}
  />
</td>
```
> `control` precisa ser passado/estar em escopo no componente da tabela (já há `register`; adicionar `control` às props se necessário).

- [ ] **Step 3: Default em item novo** — onde itens são adicionados (`append(...)` no "Adicionar item", ~linha 687-714), incluir `modalidade: 'loja'` no objeto.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: sucesso.

- [ ] **Step 5: Commit**

```bash
git add components/pedido-form.tsx
git commit -m "feat(pedido-form): coluna Modalidade por item"
```

---

### Task 9: Card "Destino" derivado + remover seletor global

**Files:**
- Modify: `components/pedido-form.tsx` (seletor global ~354-373; card de pontos)

- [ ] **Step 1: Remover** o `<select>` "Modo de retirada" (linha ~360-372) e a lógica `modoRetirada`/`setModoRetirada` que só servia ao seletor (manter o que for usado pra montar destinos).

- [ ] **Step 2: Derivar destinos das modalidades** — calcular, a partir dos itens (todas as modalidades presentes via `watch('pontos_retirada')` → flatten dos itens), quais blocos mostrar: bloco **Loja** se houver item `loja`; bloco(s) **Entrega** se houver item `entrega`. Renderizar o card "Destino" com esses blocos (empresa p/ loja; endereço p/ entrega).

- [ ] **Step 3: Mapear modalidade→ponto na hora de salvar** — garantir que cada item esteja no `ponto_retirada` correspondente à sua modalidade (loja→ponto loja; entrega→ponto entrega do endereço escolhido; imediato→sem ponto/`ponto_retirada_id` null). Implementar uma função `sincronizarDestinos(form)` chamada no `submit()` (linha ~209) que reorganiza `pontos_retirada` a partir das modalidades+endereços dos itens antes de validar/enviar.

- [ ] **Step 4: Build + smoke manual** (rodar `npm run dev`, abrir um pedido, trocar modalidade de um item, ver o bloco de destino aparecer/sumir).

- [ ] **Step 5: Commit**

```bash
git add components/pedido-form.tsx
git commit -m "feat(pedido-form): card Destino derivado; remove seletor global Modo de retirada"
```

---

### Task 10: Multi-endereço (entrega em locais diferentes)

**Files:**
- Modify: `components/pedido-form.tsx`
- Ler: `cliente_enderecos` (rotulo/endereco/is_padrao) via uma query/action

- [ ] **Step 1: Carregar endereços do cliente** — buscar `cliente_enderecos` do cliente do pedido (server action ou já carregado na page) para popular um seletor.

- [ ] **Step 2: Seletor de endereço na linha do item Entrega** — quando `modalidade === 'entrega'`, mostrar ao lado um `<select>` do endereço (rótulos do cliente; default `is_padrao`). Guardar a escolha de forma que o `sincronizarDestinos` (Task 9 step 3) mande o item pro ponto de entrega daquele endereço (criando 1 destino entrega por endereço usado).

- [ ] **Step 3: Botão "Adicionar endereço de entrega"** no card Destino — abre os endereços do cliente (ou cria um avulso) e cria um destino entrega disponível.

- [ ] **Step 4: Build + smoke** (2 itens Entrega em endereços diferentes → 2 destinos entrega ao salvar).

- [ ] **Step 5: Commit**

```bash
git add components/pedido-form.tsx
git commit -m "feat(pedido-form): multi-endereço de entrega via cliente_enderecos"
```

---

### Task 11: Atalho "Aplicar a todos"

**Files:**
- Modify: `components/pedido-form.tsx`

- [ ] **Step 1: Botão/menu "Aplicar a todos"** perto da tabela de itens: define a mesma `modalidade` (e, p/ entrega, o mesmo endereço) em todos os itens via `setValue` em cada `pontos_retirada.*.itens.*.modalidade`.

- [ ] **Step 2: Build + smoke.**

- [ ] **Step 3: Commit**

```bash
git add components/pedido-form.tsx
git commit -m "feat(pedido-form): atalho 'aplicar modalidade a todos'"
```

---

# FASE 3 — Testes de comportamento e fechamento

### Task 12: Testes do form/sincronização + verificação final

**Files:**
- Test: `components/__tests__/sincronizar-destinos.test.ts` (testar a função pura `sincronizarDestinos`)

- [ ] **Step 1: Extrair `sincronizarDestinos` como função pura** (recebe os itens com modalidade+endereço, devolve `pontos_retirada`) — facilita teste sem render.

- [ ] **Step 2: Testes**: (a) só imediato → itens sem destino; (b) loja → 1 ponto loja; (c) 2 entregas em endereços diferentes → 2 pontos entrega; (d) mix.

- [ ] **Step 3: Rodar toda a suíte**

Run: `npx vitest run`
Expected: tudo PASS.

- [ ] **Step 4: Verificação final**

Run: `npx tsc --noEmit` (0 erros) e `npm run build` (sucesso).

- [ ] **Step 5: Commit**

```bash
git add components/__tests__/sincronizar-destinos.test.ts components/pedido-form.tsx
git commit -m "test(pedido): sincronização modalidade→destinos"
```

---

## Notas para o executor
- Trabalhar com `npm run build` verde a cada task; a Fase 2 é a mais delicada (refactor de form grande) — fazer incremental.
- Migrações: seguir o protocolo (dry-run BEGIN/ROLLBACK antes de aplicar; commitar o `.sql` só após validar em banco).
- Não tocar no fluxo de carregamento/logística além do que o destino já alimenta (fora de escopo).
- Request 1 (Fase 0) é independente — pode virar PR próprio.
