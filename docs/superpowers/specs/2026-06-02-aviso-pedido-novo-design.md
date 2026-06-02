# Aviso de Pedido Novo (do Hiper) — Design

> Data: 2026-06-02 · Projeto: Exped · Abordagem: **A (avisos no navegador / web)**

## 1. Problema

O operador trabalha o dia todo **dentro do Hiper** (app desktop). Quando um pedido sai do
Hiper e cai no Exped, o Exped está aberto **atrás** do Hiper, num navegador em segundo plano.
Hoje o pedido até aparece sozinho na lista (realtime já existe), mas **não chama o operador** —
ele só vê se voltar pro Exped. Queremos que a chegada de um pedido **fure o Hiper** com som e
notificação, pra agilizar o trabalho.

## 2. Escopo

**Inclui:** avisar (som + notificação do Windows + piscar a aba) quando chega um pedido **vindo
do Hiper**, com um painel onde cada usuário escolhe **como** quer ser avisado, e um botão de
**testar**. Tudo no front (web). Sem mudança de infra.

**NÃO inclui (YAGNI / fora de escopo):**
- Aviso nativo pelo Hub local (.NET) — fica para uma fase futura, se o aviso web não bastar.
- Painel/kiosk dedicado para 2º monitor ou TV.
- Trazer o Exped para frente automaticamente (o Windows não permite a uma página web roubar
  foco de outro app — limitação aceita).
- Avisar sobre pedidos criados **à mão** no Exped (só os que vêm do Hiper).

## 3. O que dispara o aviso

Reaproveita o realtime **já ligado** na tabela `pedidos` (hoje usado em
[`components/pedidos-list.tsx`](../../../components/pedidos-list.tsx)).

Gatilho: evento **INSERT** em `public.pedidos` cujo registro tem **`documento_erp` preenchido**
(≠ null/vazio). Esse campo só vem preenchido quando o pedido foi ingerido do ERP/Hiper via
`/api/ingest/pedido`; pedidos criados manualmente no Exped não o têm — então o alarme **não toca
à toa**. (`status` típico de chegada é `pendente`, mas o discriminador é `documento_erp`.)

Cada usuário só recebe INSERTs que o RLS já deixa ele ver (filtro por `empresa_id` no banco) —
nenhuma mudança de RLS necessária.

## 4. Os três sinais

Quando dispara, e conforme as preferências do usuário (seção 5), tocam **juntos**:

1. **Notificação do Windows** (Web Notifications API): título "Novo pedido — \<cliente\>",
   corpo "Nº \<numero_mapa\> · R$ \<valor_total\>". Ao clicar: foca a janela do Exped e navega
   para o pedido (`/logistica/<id>` ou `/vendas/<id>` conforme o papel). Requer **contexto
   seguro** (ver seção 6).
2. **Som**, tocando **repetidamente** (a cada ~3 s) até o operador **reconhecer** (seção 7).
   O usuário escolhe o som (seção 5).
3. **Piscar a aba**: `document.title` alterna entre "🔴 N novo(s) pedido(s)" e o título normal,
   até o reconhecimento. `N` é a contagem de pedidos não vistos.

## 5. Preferências (o "escolher a forma que quer")

Um **sino** no chrome do app (Sidebar no desktop, MobileHeader no mobile) abre um **popover de
preferências**, por usuário, salvo em `localStorage` (chave inclui o id do usuário). Campos:

| Preferência | Tipo | Default |
|---|---|---|
| **Avisos ativados** (master) | on/off | off (precisa do gesto de ativar — seção 6) |
| **Tocar som** | on/off | on |
| **Som** | escolha: Sino · Bipe · Alarme | Sino |
| **Repetir som até eu ver** | on/off | on |
| **Notificação do Windows** | on/off | on |

Além disso, no popover:
- Botão **"Testar aviso"** — dispara um aviso de demonstração (mesma notificação + som +
  piscar) usando um pedido fictício, pro usuário ver/ouvir e ajustar antes de valer pra valer.
- Indicador de **status**: "✅ Avisos ativos" / "⚠️ Clique para ativar" / "⚠️ Abra por
  localhost para liberar notificação do Windows" (quando em contexto inseguro).

## 6. Ativação e contexto seguro

- **Gesto único:** Web Audio e a permissão de Notificação exigem uma interação do usuário.
  O master "Avisos ativados" (ou o "Testar aviso") serve de gesto: ao ligar, pede permissão de
  notificação e inicializa o áudio. A escolha fica salva; em cargas seguintes os avisos religam
  sozinhos (a permissão do navegador persiste).
- **Contexto seguro:** notificação do Windows + autoplay de som só funcionam em `https://` ou
  `http://localhost`. No PC do operador (mesmo PC do Hiper) o Exped deve ser aberto por
  **`http://localhost:3000`** → vira passo do checklist de instalação do operador
  ([`docs/onboarding-cliente.md`](../../onboarding-cliente.md)).
- **Degradação graciosa:** se aberto por IP da LAN (contexto inseguro), o popover mostra o aviso
  de "abra por localhost"; a notificação do Windows fica indisponível, mas **som + piscar a aba**
  ainda funcionam após o gesto. Nada quebra.

## 7. Reconhecimento (parar o som repetido)

O som repetido e o piscar param quando o operador **reconhece** a chegada, por qualquer um de:
- a janela/aba do Exped recebe **foco** (`visibilitychange` → visível, ou `window.focus`);
- clique na **notificação** do Windows;
- clique no **sino** ou em um pedido da lista.

Ao reconhecer: zera a contagem de "não vistos", para o loop de som, restaura `document.title`.

## 8. Componentes (isolados, uma responsabilidade cada)

- **`lib/alertas/preferencias.ts`** — tipo `PreferenciasAviso` + `carregar(userId)` /
  `salvar(userId, prefs)` (localStorage). Sem dependência de React.
- **`lib/alertas/som.ts`** — `PlayerSom`: toca um som (Web Audio), com `iniciarLoop()` /
  `parar()`; catálogo de sons (Sino/Bipe/Alarme). Sem React.
- **`lib/alertas/titulo.ts`** — `piscarTitulo(n)` / `restaurarTitulo()`. Sem React.
- **`components/alertas/use-alertas-pedido.ts`** — hook: assina o realtime (canal próprio,
  ex. `pedidos-alertas`), filtra INSERT com `documento_erp`, orquestra os 3 sinais conforme as
  preferências, e cuida do reconhecimento. Recebe `userId` e `role` (pra montar o link do clique).
- **`components/alertas/alertas-center.tsx`** (client) — o sino + popover de preferências +
  "Testar aviso"; monta o hook. **Montado globalmente** em
  [`app/(app)/layout.tsx`](../../../app/(app)/layout.tsx), então funciona em qualquer página.

**Dedup com o toast atual:** a lista ([`pedidos-list.tsx`](../../../components/pedidos-list.tsx))
hoje dá um `toast` próprio em INSERT na logística. Para não duplicar aviso, esse toast sai (a
AlertasCenter passa a ser a fonte única do aviso); a lista continua só **inserindo o item** na
tela via seu realtime, como já faz.

## 9. Casos de borda

- **Múltiplas abas do Exped abertas:** cada aba tocaria o som. Aceitável para o go-live (1 PC,
  geralmente 1 aba). Coordenação entre abas (eleição de líder via BroadcastChannel) fica fora de
  escopo; anotar como melhoria futura se incomodar.
- **Permissão de notificação negada:** popover mostra como reativar; som + piscar seguem.
- **Pedido reingerido / UPDATE:** só **INSERT** dispara; updates de status não tocam alarme.
- **Aba já em foco quando chega:** sem som repetido nem piscar (já está vendo); mostra só um
  toast leve. (Reconhecimento imediato.)

## 10. Testes

- **Unit:** `preferencias` (load/save, defaults), `som` (loop inicia/para), `titulo` (pisca/restaura).
- **Integração (Playwright):** simular INSERT em `pedidos` com `documento_erp` e verificar:
  (a) `document.title` piscou; (b) o loop de som iniciou (espia no `PlayerSom`); (c) ao focar a
  aba, parou. Testar o **fallback** em contexto inseguro (sem Notification). Testar o botão
  **"Testar aviso"**.
- **Manual (no go-live):** abrir por `localhost`, ativar avisos, criar/ingerir 1 pedido real do
  Hiper, confirmar que fura o Hiper.
