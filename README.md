# Exped — Mapa de Carregamento

Sistema interno da **Franzoni Casa & Construção** para gerar e gerenciar o Mapa
de Carregamento a partir do PDF de pedido emitido pelo ERP. Substitui o fluxo
manual em papel/planilha entre Vendas e Logística.

## Fluxo

1. **Vendedor** faz upload do PDF do pedido → o sistema extrai os dados
   automaticamente → o vendedor revisa e envia para a logística.
2. **Logística** vê o pedido na fila (ordenada por bairro + data de entrega) →
   preenche dados de logística (motorista, veículo, kms, pesos, conferente) →
   marca como em separação → imprime o mapa → finaliza.
3. **Histórico** consulta pedidos finalizados, com filtros e KPIs.

## Stack

- **Next.js 16** (App Router, React 19, Turbopack)
- **Tailwind CSS v4** + **shadcn/ui** (preset base-nova)
- **Supabase** (Postgres + Auth + Storage + Realtime + RLS)
- **TypeScript** estrito
- **react-hook-form** + **zod** nos forms
- **vitest** para testes do parser
- **pdf-parse v2** para extrair texto do PDF do ERP
- **Vercel** (deploy)

## Rodando local

### Pré-requisitos
- Node.js ≥ 20 (testado em 24)
- Projeto Supabase criado em https://supabase.com

### Setup

```bash
git clone git@github.com:gestao-hub/franzoni.git
cd franzoni
npm install
cp .env.example .env.local
# edite .env.local com as chaves do seu projeto Supabase
```

### Aplicar o schema (uma vez)

A **fonte da verdade** do schema são as migrations em
[supabase/migrations/](supabase/migrations/) (aplicadas EM ORDEM). Use o CLI:

```bash
npx supabase login
npx supabase link --project-ref <SEU_PROJECT_REF>
npx supabase db push   # aplica todas as migrations pendentes, em ordem
```

> ⚠️ O arquivo [supabase/01-SCHEMA.sql](supabase/01-SCHEMA.sql) é um bootstrap
> ANTIGO (só as primeiras migrations) e **não reflete o schema atual** (faltam,
> p.ex., `modalidade` por item, `exige_emissao`, status `em_financeiro`/`em_transporte`).
> Não use para um setup novo — aplique as migrations.

### Gerar os tipos TypeScript do banco

Depois que o schema estiver aplicado, substitua o stub `lib/types/database.ts`
pelos tipos auto-gerados:

```bash
npx supabase login
npx supabase link --project-ref <SEU_PROJECT_REF>
npx supabase gen types typescript --linked > lib/types/database.ts
```

### Criar usuários iniciais

```bash
npx tsx scripts/seed-users.ts
# Senha padrão para todos: Franzoni@2026
# Sobrescreva com SEED_PASSWORD=… npx tsx scripts/seed-users.ts
```

Cria:
- `admin@franzoni.local` (admin)
- `vendas1..4@franzoni.local` (vendedor)
- `logistica@franzoni.local` (logistica)

### Subir o dev server

```bash
npm run dev
# http://localhost:3000
```

## Scripts

| Script | O que faz |
|---|---|
| `npm run dev` | Dev server (Turbopack) |
| `npm run build` | Build de produção |
| `npm start` | Serve o build |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Roda vitest uma vez |
| `npm run test:watch` | Vitest em watch |

## Estrutura

```
app/
  (auth)/login/        → tela de login
  (app)/
    layout.tsx         → sidebar + topbar + UserProvider
    vendas/            → meus pedidos, novo, detalhe
    logistica/         → fila, detalhe + baixa
    historico/         → pedidos finalizados
    admin/             → (stub)
  (print)/imprimir/[id]/  → view de impressão (sem sidebar)
  api/parse-pdf/       → POST: extrai dados do PDF
  auth/{signout,callback}/

components/
  ui/                  → shadcn primitives
  layout/              → Sidebar, Topbar
  providers/           → ThemeProvider, UserProvider
  mapa-carregamento.tsx → layout do mapa físico (reutilizável)
  pedido-form.tsx      → form de revisão (vendedor)
  pedidos-list.tsx     → listagem com filtros + realtime
  upload-pdf.tsx       → dropzone + POST /api/parse-pdf
  status-badge.tsx
  franzoni-logo.tsx

lib/
  supabase/{client,server,middleware}.ts
  parser/franzoni-erp.ts  → regex que parseia o PDF do ERP
  parser/to-form-input.ts → adaptador parser → defaults do form
  validators/             → zod schemas
  types/                  → tipos do banco (auto-gerados)

supabase/
  migrations/             → fonte da verdade do schema (supabase db push)
  01-SCHEMA.sql           → bootstrap ANTIGO (desatualizado; não usar)

tests/fixtures/
  pedido-L4077.txt        → texto cru do PDF de exemplo

proxy.ts                  → middleware do Next 16 (refresh JWT, redirects)
```

## Deploy (Vercel)

```bash
npx vercel link
npx vercel env add NEXT_PUBLIC_SUPABASE_URL production
npx vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY production
npx vercel env add SUPABASE_SERVICE_ROLE_KEY production
npx vercel deploy --prod
```

Depois, no **Supabase Dashboard → Authentication → URL Configuration**:
adicionar a URL de produção em **Site URL** e **Redirect URLs**.

## Permissões (RBAC)

A app tem defesa em duas camadas:
1. **Layouts gate** (`app/(app)/{vendas,logistica,admin}/layout.tsx`) chamam
   `requireRole()` no servidor. Quem não tem o role é redirecionado pro home
   do role real (admin→/admin, logistica→/logistica, vendedor→/vendas).
2. **RLS no Supabase** filtra linhas por `auth.uid()` e `current_user_role()`
   — defesa em profundidade caso o gate seja contornado.

### Matriz oficial

| Rota | admin | vendedor | logistica |
|---|:---:|:---:|:---:|
| `/vendas`, `/vendas/novo`, `/vendas/[id]` | ✅ todos | ✅ próprios | ❌ redirect /logistica |
| `/logistica`, `/logistica/[id]` | ✅ | ❌ redirect /vendas | ✅ |
| `/historico`, `/historico/[id]` | ✅ | ✅ próprios | ✅ todos |
| `/admin`, `/admin/usuarios` | ✅ | ❌ redirect /vendas | ❌ redirect /logistica |
| `/imprimir/[id]` | ✅ | ✅ próprios | ✅ |
| `POST /api/parse-pdf` | ✅ | ✅ | ❌ |
| Alterar role de outro usuário | ✅ | ❌ | ❌ |
| Cancelar pedido | ✅ (qualquer) | ✅ (próprio rascunho/pendente) | ❌ |
| Iniciar separação / finalizar | ✅ | ❌ | ✅ |

Pra adicionar uma rota nova com gate por role, basta envolver com:
```ts
// app/(app)/<nova-area>/layout.tsx
import { requireRole } from '@/lib/auth/require-role';
export default async function Layout({ children }) {
  await requireRole(['admin', 'logistica']); // etc.
  return <>{children}</>;
}
```

## QA automatizado (Playwright)

Pasta [qa/](qa/) tem suite completa: smoke + RBAC + upload CRUD + visual em 5 viewports.

```bash
cd qa && npm install && npm run qa:install   # 1ª vez
npm run qa:full     # tudo (~6min, 148 testes)
npm run qa:rbac     # só RBAC
npm run qa:report   # abre HTML da última run
```

## Decisões de design

- **Multi-tenant não é objetivo** — uma instalação por empresa.
- **PDF do ERP é a entrada autoritativa**; o usuário só revisa, não digita do zero
  (existe um fallback "preencher manualmente" mas é exceção).
- **RLS é a única camada de autorização**. Vendedor só vê os próprios pedidos
  (`vendedor_id = auth.uid()`). Logística vê todos. Admin vê tudo.
- **Realtime** escuta `pedidos` (insert/update) para que a fila de logística e
  a listagem do vendedor atualizem sem refresh.
- **Storage** privado: `pedidos-pdfs/{user_id}/{ts}-{nome}.pdf`. RLS no objeto
  garante que só o dono (e admin/logística) lê.
- **Impressão**: rota separada (`/imprimir/[id]`) sem sidebar, com `window.print()`
  automático. CSS `@media print` cuida do A4 + quebra de página entre múltiplos
  pontos de retirada.

## Roadmap conhecido

- Auto-save no form da logística (debounce 1s)
- Export PDF da listagem do histórico
- Suporte real a múltiplos pontos de retirada (LOJA + DEPÓSITO) — hoje sempre
  retorna 1 ponto; precisa de PDFs de exemplo com 2 blocos para calibrar o parser
- Notificações por email/Slack quando o pedido troca de status
- Painel admin (atualmente é só um stub)
