# Design — Modalidade por item + "Exige emissão" no financeiro

Data: 2026-06-12
Projeto: franzoni/exped (app de pedidos → financeiro → logística/entrega)

## Contexto e problema

Duas mudanças pedidas pelo cliente:

1. **(Financeiro) "Exige emissão":** no passo de conferência do financeiro, o operador
   precisa marcar/desmarcar se o pedido **exige emissão de nota**. Hoje não existe esse
   controle. Deve ser um checkbox análogo ao "Receber na entrega" já existente.

2. **(Pedido) Modalidade por item:** hoje a forma de retirada/entrega é definida por um
   **seletor global "Modo de retirada"** (loja/depósito/híbrido) e os itens ficam **aninhados
   em "pontos de retirada"** (`pedido_itens.ponto_retirada_id`). O cliente quer que **cada item**
   tenha uma coluna **"Modalidade"** com 3 opções — **Imediato / Loja / Entrega** — que o operador
   muda item a item. Com isso, o seletor global vira redundante.

### Decisões de produto (brainstorm)

- **Imediato** = pronta-entrega no balcão. Cliente leva na hora. **Sem destino, sem logística**
  (não vai pra carregamento/entrega).
- **Loja** = retirada na loja. Precisa saber **qual loja** (empresa).
- **Entrega** = entregue no cliente. Precisa de **endereço + frete**.
- **Depósito** deixa de ser modalidade. A origem (loja/depósito) fica refletida em **qual destino
  (empresa) o item aponta** — o destino "loja" pode na prática ser uma loja **ou** um depósito,
  pelo `empresa_nome`. **Não há campo novo de origem** (YAGNI); a info de onde sai não se perde
  porque mora no destino.
- **Destino:** o cliente pode ter **vários endereços** (`cliente_enderecos`) e a entrega pode ir
  para **locais diferentes**. Logo, itens "Entrega" diferentes podem apontar para endereços
  diferentes. O vínculo item→destino é mantido (não colapsa para "1 entrega por pedido").
- **Padrão** de item recém-parseado do PDF: **Loja** (o PDF é um pedido de loja; operador ajusta).
- **Migração:** backfill automático dos pedidos existentes.

## Abordagem escolhida

**Abordagem 1 — `modalidade` vira campo do item (fonte da verdade)**, reaproveitando a estrutura
de pontos como **registro de destino** (agora multi-endereço) em vez de um seletor global.

## Modelo de dados

### `pedido_itens`
- **+ `modalidade`**: novo enum `modalidade_item` = `('imediato','loja','entrega')`, **NOT NULL,
  default `'loja'`**. É a **fonte da verdade** da modalidade do item.
- **`ponto_retirada_id`**: passa a ser **NULLABLE** e representa o **destino** do item.
  - `imediato` → `ponto_retirada_id = NULL` (sem destino).
  - `loja` → aponta para o destino "loja" (a loja de retirada).
  - `entrega` → aponta para **um** destino "entrega" (um endereço). Itens distintos podem apontar
    para destinos de entrega distintos → **entrega em locais diferentes**.

### `pontos_retirada` (repurposed → "destinos")
- Mantida como a tabela de **destinos** do pedido. Por pedido:
  - **0–1 destino `loja`** (empresa = qual loja), quando houver item Loja.
  - **0–N destinos `entrega`** (cada um = um endereço, vindo de `cliente_enderecos` ou avulso),
    quando houver itens Entrega — N > 1 quando entregar em locais diferentes.
- `tipo='deposito'` deixa de ser uma **modalidade**; um destino "loja" pode representar tanto uma
  loja quanto um depósito (via `empresa_nome`) — a origem mora aí, sem campo novo.
- Frete: continua em `pedidos.valor_frete` (nível pedido, como hoje), conferido no financeiro.

### Migração (backfill, idempotente)
1. `CREATE TYPE modalidade_item AS ENUM ('imediato','loja','entrega');`
2. `ALTER TABLE pedido_itens ADD COLUMN modalidade modalidade_item NOT NULL DEFAULT 'loja';`
3. Backfill: `UPDATE pedido_itens i SET modalidade = CASE WHEN p.tipo='entrega' THEN 'entrega'
   ELSE 'loja' END FROM pontos_retirada p WHERE i.ponto_retirada_id = p.id;`
4. `ALTER TABLE pedido_itens ALTER COLUMN ponto_retirada_id DROP NOT NULL;`
5. Validação de sanidade pós-migração (contagem de itens por modalidade != 0; nenhum item órfão).

> Protocolo: inventariar schema real, dry-run `BEGIN/ROLLBACK`, aplicar via migração ≤100 linhas,
> validar, e só commitar após funcionar. (Regra do ecossistema.)

### `pedidos` (request 1)
- **+ `exige_emissao`**: `boolean NOT NULL DEFAULT false`. Análogo a `receber_na_entrega`.

## UX

### `components/pedido-form.tsx`
- **Remove** o seletor global **"Modo de retirada"** e o conceito de "Pontos de Retirada" como
  seletor manual.
- **Tabela de itens** ganha a coluna **"Modalidade"** (dropdown Imediato/Loja/Entrega) por linha.
  - Item novo / parseado nasce **Loja**.
  - Para item **Entrega**: aparece um **seletor de endereço** (rótulo do `cliente_enderecos`;
    default = `is_padrao`) — escolhe para qual destino de entrega o item vai.
- **Card "Destino"** (deriva dos itens):
  - Bloco **Loja** (empresa/loja) só aparece se houver item Loja.
  - Bloco(s) **Entrega** (endereço + indicação de frete) aparece(m) conforme os endereços em uso;
    botão **"Adicionar endereço de entrega"** puxa de `cliente_enderecos` (ou cria avulso).
  - Só Imediato → nenhum bloco de destino.
- **Atalho "Aplicar a todos os itens"**: define a mesma modalidade (e, para Entrega, o mesmo
  endereço) em todos os itens de uma vez — conveniência, já que o parse vem homogêneo.

### `app/(app)/financeiro/[id]/financeiro-form.tsx` (request 1)
- Adicionar um checkbox **"Exige emissão"** ao lado do "Receber na entrega".

## Validação (zod)

### `lib/validators/pedido.ts`
- `itemSchema` **+ `modalidade: z.enum(['imediato','loja','entrega'])`** (default tratado no form).
- `pontoRetiradaSchema`/`pontos_retirada`: vira **destinos derivados** (opcionais); afrouxar o
  `superRefine` "ponto sem item" (itens não vivem mais dentro do ponto — o vínculo é item→destino).
- Regra nova: item `entrega` exige `ponto_retirada_id` (destino) preenchido; item `imediato` exige
  `ponto_retirada_id` nulo; item `loja` aponta para o destino loja.

### `lib/validators/financeiro.ts`
- `financeiroFormSchema` **+ `exige_emissao: z.boolean().optional()`**.

## Actions / persistência
- A action de salvar o pedido passa a gravar `modalidade` por item e o `ponto_retirada_id`
  (destino) derivado das escolhas; cria/atualiza/remove destinos conforme as modalidades em uso.
- `salvarFinanceiroAction` passa a gravar `exige_emissao` no `pedidos`.

## Parser
- `lib/parser/hiper-erp.ts` / `to-form-input.ts`: itens parseados nascem `modalidade='loja'`
  (mantém o destino loja que já é criado). Sem inferência de Imediato/Entrega no parse.

## Casos de borda
- Cliente sem endereço cadastrado e item marcado Entrega → permitir endereço avulso no card Destino.
- Mudar item de Entrega→Imediato/Loja → desvincula do endereço (limpa `ponto_retirada_id` p/ imediato).
- Remover o último item de um destino de entrega → o bloco daquele endereço some do card.
- Pedido só com itens Imediato → sem destino, sem frete; ainda passa pelo financeiro normalmente.
- Híbrido legado (pedido já dividido em pontos retirada+entrega) → backfill cobre (cada item herda
  a modalidade do seu ponto).

## Testes
- Parser: itens nascem `modalidade='loja'` (ajustar/expandir `hiper-erp.test.ts`).
- Validator: item entrega sem destino falha; imediato com destino falha; mix válido passa.
- Form (comportamento): coluna Modalidade muda item; bloco de destino aparece/some; "aplicar a
  todos"; multi-endereço (2 itens Entrega em endereços diferentes).
- Migração: dry-run de backfill confirma contagens.

## Fora de escopo
- Lógica avançada de origem (de qual depósito sai cada item) além do detalhe display-only.
- Roteirização/otimização de entregas multi-endereço.
- Mudanças no fluxo de carregamento/logística além do que o destino já alimenta.

## Request 1 e 2: independência
São independentes e podem ser entregues em PRs separados. Sugestão: request 1 (checkbox, pequeno)
primeiro como aquecimento; request 2 (modalidade) como o trabalho principal com migração.
