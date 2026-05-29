# Opção B — Arquitetura: Serviço Windows lê banco Hiper → plataforma Franzoni

> Decisão (2026-05-29): integrar **Hiper → Franzoni** via **leitura direta do SQL Server local**,
> empacotada como **Serviço do Windows** na máquina do cliente. Dado estruturado, sem PDF.

## Visão geral do fluxo

```
[Máquina do cliente — Windows]                          [Nuvem — Vercel + Supabase]
 SQL Server .\HIPER (Hiper.mdf)
        │ (SELECT, READ UNCOMMITTED)
        ▼
 Serviço Windows "Franzoni Sync"  ──HTTPS POST (token)──►  POST /api/ingest/pedido
   - polling por novos/alterados                              - valida token do dispositivo
   - high-water mark local                                    - valida payload (pedidoFormSchema)
   - monta PedidoFormInput                                    - dedup por documento_erp
   - retry/backoff                                            - upsertCliente + insert pedido/itens
                                                              - status inicial = "pendente"
```

## Componente local (Serviço Windows)

- **Linguagem:** Node.js + TypeScript (mantém consistência com o ecossistema do time),
  empacotado como serviço via **NSSM** ou `node-windows`. Alternativa nativa: .NET worker service.
- **Driver SQL:** `msnodesqlv8` (suporta Windows Integrated Auth / `Trusted_Connection=yes`,
  que já confirmamos funcionar). Connection string: `Server=.\HIPER;Database=Hiper;Trusted_Connection=yes;`.
- **Detecção de novos pedidos:** polling (ex.: a cada 30–60s) na `pedido_venda` filtrando por
  `situacao` (só confirmados) e `data_hora_geracao`/`id_pedido_venda` > high-water mark salvo localmente
  (arquivo JSON ou SQLite). Leitura com `WITH (NOLOCK)` pra não travar o Hiper.
- **Idempotência:** o POST é seguro de repetir — o endpoint deduplica por `documento_erp`
  (`pedido_venda.codigo`, ex. "L602"). Se cair conexão, reenvia sem duplicar.
- **Segurança:** só conexões de SAÍDA (HTTPS). Token do dispositivo num config local.
  Ideal: usar login SQL **somente-leitura** (ou Windows Auth com permissão de leitura).

## Componente nuvem (novo endpoint)

- **`POST /api/ingest/pedido`** (Next.js route, runtime nodejs).
  - Autentica por **token de dispositivo** (header `Authorization: Bearer <device_token>`),
    NÃO por sessão de usuário (o Serviço não tem cookie de login).
  - Valida o corpo com `pedidoFormSchema` (reaproveitado de `lib/validators/pedido.ts`).
  - Reusa a lógica de `criarPedidoAction`: dedup por `documento_erp`, `upsertCliente`,
    insert em `pedidos` + `pedido_pontos_retirada` + `pedido_itens`.
  - **Refactor necessário:** extrair o miolo de `criarPedidoAction` numa função pura
    `inserirPedido(supabase, input, { vendedorId, status })` que tanto a server action
    (sessão) quanto o endpoint de ingestão (token) chamam. Hoje a action lê `auth.getUser()`
    inline; o endpoint vai passar o `vendedor_id` explicitamente.
  - Usa client Supabase com **service_role** (server-side) já que não há sessão de usuário —
    com validação de token própria antes.

## Mapeamento PedidoFormInput ← banco Hiper

| Campo alvo (PedidoFormInput) | Origem no Hiper | Status |
|---|---|---|
| documento_erp | `pedido_venda.codigo` | ✅ |
| data_emissao | `pedido_venda.data_hora_geracao` | ✅ |
| data_entrega | **(2ª rodada)** | ❌ |
| valor_total | **(2ª rodada — coluna ou soma)** | ❌ |
| observacoes | `pedido_venda.observacao` | ✅ |
| forma_pagamento / parcelas | **(2ª rodada — tabela pagamento)** | ❌ |
| cliente_* (nome, cnpj, endereço, bairro, cidade, uf, cep, telefone) | **(2ª rodada — tabela entidade via `id_entidade_cliente`)** | ❌ |
| cliente_codigo | entidade/cliente (código) | ❌ |
| pontos_retirada[0].itens[] (codigo, descricao, quantidade, unidade, preco_unitario, desconto, total) | `item_pedido_venda` + `grade_pedido_venda.quantidade` + `produto.nome`/`codigo` | ✅ |
| vendedor_id (RLS) | **(2ª rodada — vendedor/usuário do pedido)** → mapear p/ user Franzoni | ❌ |

> JOIN itens: `item_pedido_venda` ↔ `grade_pedido_venda` por (`id_pedido_venda`,`sequencia_item`); filtrar `excluido=0`, `cancelado=0`. Schema completo em memória `hiper-schema-local`.

## 2ª rodada de mapeamento — RESULTADOS (2026-05-29)

- **Cliente:** `pedido_venda.id_entidade_cliente` → `entidade` (+ `pessoa_fisica`/`pessoa_juridica` p/ nome e CPF/CNPJ). Endereço (logradouro, número, complemento, bairro, CEP) embutido na `entidade`. Cidade/UF via tabela `cidade`. (L602: Roseli rosa dos santos, CPF 04631573970, Sítio São Sebastião 10, Apucarana/PR, 86800000.)
- **Data de entrega:** `data_previsao_entrega_inicial` / `data_previsao_entrega_final`.
- **Valor total:** NÃO há coluna. Calcular = Σ(`grade_pedido_venda.quantidade` × `item_pedido_venda.valor_unitario_com_desconto`). Desconto é por item (não há desconto de cabeçalho). Frete em `valor_frete` (separado do total dos itens). L602 = R$ 1.799,90.
- **Vendedor:** `pedido_venda.id_usuario_vendedor` → `usuario` (L602 = Michel, id 1).
- **Endereço de entrega:** NÃO há tabela de múltiplos endereços. Só principal + cobrança, ambos na `entidade`. Tabelas `entrega`/`controle_entrega` são logística pós-NF (não usar). → Mapear o endereço principal da entidade; `cliente_endereco_id` da plataforma fica null (feature de múltiplos endereços é enriquecimento do lado Franzoni).

### ⚠️ RISCOS / DECISÕES PENDENTES

1. **PAGAMENTO (furo principal):** `forma_pagamento`/`parcelas` ("ENTREGA A RECEBER, 10x") NÃO são persistidos no banco enquanto é só pedido — só ao FINALIZAR a venda (`negociacao` → `negociacao_finalizador` → `finalizador_pdv`). `data_pagamento_pedido_venda` guarda só vencimentos. Logo, B puro PERDE o pagamento que o PDF mostra. Pagamento importa (atalho "Receber na entrega"). Opções: (a) **híbrido** — correlacionar `%TEMP%\PedidoVenda_{id_pedido_venda}.pdf` pelo id e parsear só a linha de pagamento; (b) tratar pagamento como opcional/vazio; (c) confirmar com pedido realista se persiste antes de decidir.
2. **`situacao` (gatilho do sync):** sem enum no banco. Observado (inferência): 5=aberto (pedidos de hoje L601/L602), 2=faturado, 6=cancelado. CONFIRMAR no Hiper qual valor = "pronto pra logística" antes de usar como filtro de polling.
3. **vendedor_id:** precisa de mapa `usuario.id` (Hiper) → `profiles.id` (Franzoni UUID). Definir tabela de mapeamento + fallback (conta de serviço se não mapeado).
```
