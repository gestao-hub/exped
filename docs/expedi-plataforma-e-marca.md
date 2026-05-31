# Expedi — Visão geral da plataforma & guia de marca

Documento de referência: **o que é o Expedi**, como funciona, o que usamos de UI/UX hoje, e
as **especificações pra criar a logo própria** (favicon incluído). Serve de brief pra design.

---

## 1. O que é o Expedi

O Expedi é uma **plataforma SaaS multi-empresa** que conecta o ERP **Hiper** dos clientes a um
sistema de **logística, vendas e ordens de serviço** moderno, acessível de qualquer lugar.

A ideia central: o cliente já lança vendas/OS no Hiper. O Expedi **lê esses dados automaticamente**
e transforma em **mapas de carregamento**, **fila de logística**, **acompanhamento de OS** e
**notificações ao cliente final** — sem ninguém redigitar nada.

**Antes:** o operador arrastava PDFs do pedido na mão.
**Agora:** um agente lê o Hiper e tudo aparece pronto no Expedi.

## 2. Para quem é (multi-nicho)

O Hiper atende muitos ramos, então o Expedi é **genérico por design**. Exemplos de clientes:
- **Comércio/distribuição** (ex.: Franzoni — casa & construção): foco em **mapa de carregamento** e entrega.
- **Automecânica / oficina**: foco em **Ordem de Serviço** — autorização, "serviço pronto", lembrete de próxima manutenção.
- **Assistência técnica de eletrônicos**: OS com defeito/diagnóstico/garantia.

Cada cliente é uma **empresa (tenant)** isolada, com seus dados, usuários e **marca própria** (white-label).

## 3. Como funciona (em linguagem simples)

- **Hiper (no PC do cliente):** onde nascem os pedidos/OS.
- **Agente Expedi (no PC do cliente):** lê o Hiper e envia pro Expedi.
- **Expedi (nuvem):** as telas que a equipe usa (mapa, logística, OS, notificações).
- **Operador (você):** painel central que cria/gerencia os clientes (cross-tenant).

**Em evolução (aprovado):** versão **híbrida offline** — uma cópia do Expedi roda **no PC do
cliente** e funciona **com ou sem internet**, sincronizando com a nuvem quando a conexão volta
(ver `docs/superpowers/specs/2026-05-31-expedi-local-offline-design.md`).

## 4. Módulos atuais

- **Vendas / Mapa de Carregamento:** pedidos vindos do Hiper viram mapa de carregamento (cliente,
  endereço, itens, pontos de retirada, frete, janela de entrega, NF-e, saldo de estoque, pagamento).
- **Logística:** fila de separação/entrega, registro de entrega, status.
- **Ordem de Serviço (OS):** peças, serviços, técnico, objeto, defeito/diagnóstico, garantia.
- **Notificações & Retenção (OS):** WhatsApp/e-mail — pedir autorização, avisar "pronto",
  lembrete de próxima manutenção. Conexão de WhatsApp por QR (self-service do cliente).
- **Plataforma (operador):** cadastro de empresas, agentes, mapeamento de vendedores, white-label,
  configuração de notificações.

## 5. UI/UX que usamos hoje (importante pra logo combinar)

**Stack técnico:**
- **Next.js 16 + React 19** (App Router)
- **Tailwind CSS v4** (tokens via `@theme` / variáveis CSS)
- **shadcn/ui** (componentes em `components/ui/`) sobre **Radix UI** + **Base UI** (`@base-ui/react`),
  com `class-variance-authority` + `clsx` + `tailwind-merge`
- **lucide-react** (ícones, traço fino) · **sonner** (avisos/toasts) · **next-themes** (dark/light)
- **react-hook-form** (formulários) · **recharts** (gráficos) · **react-day-picker** (datas)

**Design system — "VibeUX":**
- **Fontes:** **Inter** (texto) + **Outfit** (títulos). Mono: Geist Mono.
- **Princípios:** sombras suaves (5–12% opacidade), **sem gradientes**, **sem emojis**,
  skeleton loading no lugar de spinner, cantos arredondados, layout limpo e espaçado.
- **Dark + Light mode** (respeita preferência do sistema).
- **Acessibilidade:** contraste adequado, mínimo 12px.

**Paleta da marca (atual, Expedi):**
- Laranja principal: **`#F37021`** (tokens `--color-brand-*`)
  - `brand-50 #FEF3EC` · `brand-100 #FCE1CC` · `brand-500 #F37021` · `brand-600 #D85A0F` · `brand-700 #B14709`
- Base neutra (VibeUX): fundo `#F9FAFB` · texto `#1D2939` · cinza `#667085` · sucesso `#039855` · erro `#D92D20`

> Observação: a cor laranja `#F37021` foi herdada e pode ser **revista** se a nova marca pedir.
> Se você definir uma cor nova pra logo, a gente ajusta os tokens `--color-brand-*` junto.

## 6. Guia pra criar a logo do Expedi

### Por que precisamos
Hoje a logo e o favicon **ainda são da Franzoni** (a casinha laranja + "Casa & Construção"). Como o
Expedi é um **produto multi-empresa**, a marca **padrão** (login, painel do operador, e-mails,
favicon) tem que ser **do Expedi** — a Franzoni passa a ser só um cliente, com a logo dela no
white-label dela.

### Onde a logo aparece
| Local | Fundo | Variação usada |
|------|-------|----------------|
| Sidebar (menu lateral) | **escuro** | logo **clara** (branca/clara) |
| Tela de login | claro | logo **escura/colorida** |
| Impressão (mapa, PDF) | branco | logo **escura/colorida** |
| Favicon (aba do navegador) | — | só o **símbolo** (quadrado) |
| Ícone no celular (PWA/atalho) | — | símbolo em quadrado |

### Arquivos que preciso receber (substituem os atuais)
Caminhos exatos no projeto:
- `public/logo-light.png` — logo **clara** (pra fundo escuro / sidebar). **SVG também é bem-vindo.**
- `public/logo-dark.png` — logo **escura/colorida** (pra fundo claro / login / impressão).
- `app/icon.png` — favicon, **só o símbolo**, quadrado (recomendado **512×512**).
- `app/apple-icon.png` — ícone Apple, quadrado (**180×180**).
- `app/favicon.ico` — favicon clássico (pode gerar do símbolo).
- **Ideal:** mandar os **SVGs mestres** (logo horizontal + símbolo isolado) — SVG fica nítido em
  qualquer tamanho e é perfeito pra favicon e impressão. A partir do SVG eu gero os PNGs.

### Formato/proporção
- A logo **horizontal** (símbolo + "Expedi") é renderizada **pela altura** (a largura se ajusta sozinha).
  Mande com **fundo transparente** (PNG/SVG). Boa altura de referência: 80–160px de export.
- O **símbolo isolado** precisa funcionar **dentro de um quadrado** (favicon/app) — deixe margem.

### Direção criativa (sugestões, fique à vontade)
- Fonte do wordmark combinando com **Outfit** (títulos) dá unidade visual.
- Conceitos de símbolo que conversam com o produto: **movimento/seta** (despacho, fluxo),
  **expedição** (caixa/pacote saindo), **pin de mapa** (amarra com "Mapa de Carregamento"),
  ou um **monograma "E"** geométrico. Tudo no laranja da marca (ou a cor nova que você definir).
- Evitar: casinha/telhado (é a pegada da Franzoni), gradientes, excesso de detalhe (não lê em favicon).

## 7. Estado atual & próximos passos

**Pronto e no ar:** Vendas (frete/janela/NF/estoque/pagamento), OS completo, camada de
notificações (WhatsApp/e-mail + lembrete de manutenção), self-service de WhatsApp por QR,
painel do operador com white-label (logo/cor por empresa) e interruptor de OS.

**Aprovado e a fazer:** versão **híbrida offline** (Expedi local no PC do cliente, sincronizando
com a nuvem) — começando pelo sub-projeto fundação ("desacoplar a camada de dados/auth").

**Aguardando você:** a **logo do Expedi** (arquivos da seção 6). Assim que chegar, eu:
1. troco os arquivos, ajusto o `AppLogo` e os tokens de cor (se a cor mudar);
2. atualizo favicon/apple-icon;
3. garanto que a Franzoni use a logo dela via white-label (não a do produto);
4. seguimos o desenvolvimento (plano do 1º sub-projeto offline).
