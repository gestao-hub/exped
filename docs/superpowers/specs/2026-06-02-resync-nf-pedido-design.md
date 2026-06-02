# Re-sync de NF/pagamento (pedido 2→5) — Design

> Data: 2026-06-02 · Projeto: Exped (agente .NET + API Next.js)

## 1. Problema

O agente do Exped lê o Hiper e ingere pedidos **uma vez só**, por marca d'água de
`id_pedido_venda` ([`agent/ExpedAgent/Worker.cs`](../../../agent/ExpedAgent/Worker.cs)). NF-e e
pagamento estruturado só existem no Hiper **depois do faturamento** (situação 5). Como a Franzoni
quer ver pedidos de entrega já no "pendente" (situação 2), esses entram **sem NF** — e, quando
viram faturados (5), o agente **não os re-busca**, então a NF nunca aparece no Exped.

## 2. Objetivo e escopo

Quando um pedido já ingerido ganha NF no Hiper, o agente **re-sincroniza só a NF + pagamento
estruturado**, preenchendo o pedido existente no Exped **sem tocar em nada que a equipe editou**
(itens, cliente, status, pontos de retirada). Cirúrgico e idempotente.

**Inclui:** detecção (agente) + endpoint de atualização parcial (servidor).
**NÃO inclui (YAGNI):** re-sync de itens/cliente/valores; re-sync de OS; mudança no modelo de
marca d'água principal; reemissão/cancelamento de NF.

## 3. Decisões firmadas

- **Só preencher campos vazios:** `nf_numero`, `nf_chave`, `nf_emitida_em`, `nf_valor` e — se ainda
  estiverem nulos — `forma_pagamento`, `parcelas`. Campos já preenchidos (por edição humana, PDF
  ou ingestão anterior) **não são sobrescritos**. NF nunca é editada por humano, então na prática
  ela sempre preenche.
- **TTL de 7 dias** na lista de pendentes (pedido que nunca fatura sai da lista).
- **Detecção por lista local** no agente (abordagem aprovada), não por marca d'água de alteração
  nem por re-varredura de janela.

## 4. Servidor (Next.js)

### 4.1 Função `lib/pedidos/atualizar-nf.ts`
`atualizarNfPedido(supabase, { empresaId, documentoErp, nf, pagamento })` → resultado
`{ updated: true } | { nochange: true } | { notfound: true }`. (nomes finais no plano)

- Busca em `pedidos` por `documento_erp = documentoErp AND empresa_id = empresaId AND status <> 'cancelado'`.
- Não achou → `notfound`.
- Monta um patch só com os campos **atualmente nulos** no registro:
  - `nf_numero`/`nf_chave`/`nf_emitida_em`/`nf_valor` ← do payload, se a coluna está nula.
  - `forma_pagamento`/`parcelas` ← do payload, se a coluna está nula.
- Patch vazio → `nochange`. Senão `update(...).eq('id', existente.id)` → `updated`.
- **Nunca** inclui status, itens, pontos, cliente.

### 4.2 Endpoint `app/api/ingest/pedido/nf/route.ts` (`POST`, runtime nodejs)
- Mesma auth do ingest: `Authorization: Bearer <token>` → `dispositivos.token_hash` → `empresa_id`
  (reaproveitar o trecho de [`app/api/ingest/pedido/route.ts`](../../../app/api/ingest/pedido/route.ts)).
- Corpo JSON validado por um schema novo (`ingestNfSchema`): `documento_erp` (obrigatório) +
  `nf_numero?`, `nf_chave?`, `nf_emitida_em?`, `nf_valor?`, `forma_pagamento?` (texto livre),
  `parcelas?` (texto livre).
- Converte pagamento com os helpers existentes `mapFormaPagamento` / `parseParcelas`
  ([`lib/parser/forma-pagamento`](../../../lib/parser/forma-pagamento.ts)).
- Chama `atualizarNfPedido`. Respostas: `updated`/`nochange` → 200; `notfound` → 404; erro → 500.

## 5. Agente (.NET)

### 5.1 StateStore
- Novo tipo `NfPendente { int IdPedidoVenda; string DocumentoErp; DateTime AddedAtUtc }`.
- `State` ganha `List<NfPendente> NfPendentes`.
- Métodos: `GetNfPendentes()`, `AddNfPendente(id, doc, agoraUtc)` (no-op se já existe o id),
  `RemoveNfPendente(id)`, `PruneNfPendentes(agoraUtc, ttlDias)` (remove > TTL).
- Mantém o JSON em `state.json` (mesmo arquivo).

### 5.2 Worker
- **`TickAsync`:** depois de sincronizar um pedido (Created/Duplicate) cujo `h.NfNumero` ficou
  **nulo/vazio**, chamar `state.AddNfPendente(h.IdPedidoVenda, h.Codigo, DateTime.UtcNow)`.
  (Se já veio com NF — balcão — não adiciona.)
- **`TickNfPendentesAsync(ct)`** (novo, chamado a cada loop após `TickAsync`, em try/catch próprio):
  1. `state.PruneNfPendentes(DateTime.UtcNow, 7)`.
  2. Para cada pendente: `repo.NfDoPedidoAsync(id)`. Se nulo → segue (tenta no próximo poll).
  3. Se NF presente: `repo.PagamentoDoPedidoAsync(id)` (best-effort) e
     `client.EnviarNfAsync(documentoErp, nf, pagamento, ct)`.
  4. Resposta `Updated`/`NoChange`/`NotFound` → `state.RemoveNfPendente(id)`. Outro erro → mantém.

### 5.3 IngestClient
- `EnviarNfAsync(string documentoErp, NfInfo nf, PagamentoInfo? pg, ct)` → `POST /api/ingest/pedido/nf`
  com `Authorization: Bearer <DeviceToken>`, corpo JSON. Devolve um enum simples
  (`Updated`/`NoChange`/`NotFound`/`Erro`) a partir do status HTTP (200/404/outros).

> Confirmar no plano: `PayloadBuilder` mapeia `Codigo` → `documento_erp` (o `documento_erp` do
> Exped é o `pv.codigo` do Hiper). Se for outro campo, ajustar a chave guardada em `NfPendente`.

## 6. Fluxo de dados

1. Pedido nasce no Hiper (situação 2) → `TickAsync` ingere (rascunho, NF nula) → `AddNfPendente`.
2. Equipe revisa/edita no Exped (status, itens) — irrelevante para a lista do agente.
3. Pedido é faturado (situação 5, NF emitida).
4. Próximo poll: `TickNfPendentesAsync` vê a NF → `EnviarNfAsync` → `atualizarNfPedido` preenche só
   `nf_*` (+ pagamento se vazio) → remove da lista.
5. O pedido no Exped mostra a NF, com as edições da equipe intactas.

## 7. Tratamento de erro

- `TickNfPendentesAsync` em try/catch próprio no `ExecuteAsync` — nunca quebra o sync principal.
- `NotFound` (pedido cancelado/removido no Exped) → remove da lista (não insiste).
- TTL 7 dias → remove pendentes antigos que nunca faturaram.
- Idempotência: o endpoint só preenche vazio; reenviar o mesmo update não muda nada (`nochange`).
- Lista é pequena (só pedidos sem NF, normalmente os em situação 2).

## 8. Testes

- **Servidor (vitest):** `atualizarNfPedido` —
  (a) preenche NF/pagamento quando os campos estão nulos;
  (b) **não** sobrescreve campos já preenchidos;
  (c) escopa por `empresa_id`;
  (d) ignora pedido `cancelado`;
  (e) `notfound` quando não existe. Seguir o padrão dos testes de rota em
  `lib/provisioning/__tests__` (mock do supabase admin).
- **Agente:** sem projeto de teste C# no repo → validar com `dotnet build` e verificação manual da
  lista (add ao ingerir sem NF; remove ao faturar; prune por TTL). Descrever os passos manuais no plano.

## 9. Riscos / observações

- O re-sync depende do agente ter o pedido na lista — se o agente for reinstalado/limpo, a lista
  some e pedidos antigos sem NF não serão recuperados. Aceitável (TTL é 7 dias; raro). Anotar.
- Endpoint usa `service_role` (admin client), igual ao ingest — escopo por `empresa_id` é
  obrigatório na query (já previsto).
