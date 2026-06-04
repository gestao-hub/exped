# Gestão de Colaboradores (self-service do admin de empresa) — Design

**Data:** 2026-06-04
**Status:** Aprovado pelo usuário (aguardando spec review → writing-plans)

## Objetivo

Permitir que o **admin de uma empresa** (ex.: o admin da Franzoni, `role='admin'`,
`is_platform_admin=false`) gerencie sozinho os colaboradores que **usam o Exped** —
adicionar, desativar/reativar e mudar cargo — sem depender do operador da plataforma
(`gestao@excluvia`). Escopo restrito aos 3 cargos atuais: `admin`, `vendedor`, `logistica`.

## Contexto / Restrição arquitetural (a decisão central)

Arquitetura híbrida: **nuvem** (Vercel + Supabase, fonte da verdade) + **hub local**
(Postgres + GoTrue + PostgREST + app Next, espelho offline) ligados por sync.

A identidade **só desce** da nuvem pro hub, nunca sobe:
- `auth.users` (login) — pull-only, via RPC `public.sync_auth_users` (já inclui
  `banned_until` e `deleted_at`: ver `supabase/migrations/20260601000005_sync_auth_users_rpc.sql:19`).
- `profiles`, `empresas`, `hiper_vendedor_map`, `dispositivos` — `dir: 'down'`
  (`hub/sync-tables.mjs:19-22`; o hub recusa push dessas com 403).

**Consequência:** todo cadastro/alteração de identidade tem que ocorrer **na nuvem**
(fonte da verdade) e descer pelo sync. Criar um colaborador direto no hub o deixaria
ilhado e seria sobrescrito no próximo pull. Isso também expõe um **bug latente atual**:
`updateUserRoleAction` (`app/(app)/admin/usuarios/actions.ts`) grava em `profiles` com a
sessão do usuário; rodando no hub, a mudança é local e **revertida no próximo sync**.

### Abordagem escolhida: gestão na nuvem, atalho no hub
- As ações de escrita (criar/desativar/reativar/mudar cargo) rodam **apenas contra a
  fonte da verdade (nuvem)**. O admin gerencia a equipe abrindo o app **na nuvem**.
- No **hub**, a tela de equipe fica **read-only** com um botão "Gerenciar equipe na
  nuvem" (link pro app nuvem). As mudanças descem sozinhas via sync (sem plumbing novo).
- Bônus: fecha o bug latente de mudança de cargo no hub.

**Alternativas descartadas:** (a) hub chama a nuvem por baixo (proxy) — aumenta a
superfície de segurança por ganho pequeno numa tarefa rara; (b) tornar `profiles`/
`auth.users` two-way (criar offline e empurrar) — risco alto (hash de senha, internals
do GoTrue, resolução de conflito de identidade).

## Escopo

**Dentro:**
- Adicionar colaborador (login: nome, email, cargo, senha inicial). Para `vendedor`,
  campo **opcional** "ID do vendedor no Hiper" (cria/atualiza `hiper_vendedor_map`).
- Desativar (soft, reversível) e Reativar colaborador.
- Mudar cargo (já existe; passa a ser só-nuvem).
- Listar equipe com status Ativo/Inativo.
- Escopo por empresa: o admin só mexe na própria empresa.
- Gate nuvem/hub: ações só-nuvem; hub read-only + link.

**Fora (YAGNI / próximas iterações):**
- Cargo `financeiro` (não existe; precisa de área/permissões próprias → projeto à parte).
- Criação de usuário offline / no hub.
- Convite por email (o hub não tem SMTP; usamos senha inicial definida pelo admin).
- Recuperação de senha / troca de senha pelo próprio usuário (fora do escopo desta feature).

## Modelo de dados

**Migration nova** (`supabase/migrations/20260604HHMMSS_profiles_ativo.sql`, aditiva,
idempotente, ≤100 linhas):
```sql
alter table public.profiles
  add column if not exists ativo boolean not null default true;
```
- `ativo` é exibido na lista (Ativo/Inativo) e desce no sync (profiles é `down`; o pull
  seleciona todas as colunas, e o `upsert` do hub copia todas — sem mudança no sync).
- "Desativar" = `ativo=false` **+** ban no GoTrue (`banned_until`), que bloqueia o login
  e já desce pro hub via `sync_auth_users`. "Reativar" = `ativo=true` + remove o ban.
- Não há coluna a remover; `hiper_vendedor_map.vendedor_id` é `on delete restrict`, por
  isso desativamos (soft) em vez de apagar — preserva histórico e mapeamento.

## Componentes

### 1. Helper de runtime (nuvem vs hub)
- `lib/runtime.ts` (novo): `export function isHub(): boolean` — true se rodando no hub.
  Detecção: `process.env.EXPED_HUB === '1'` (definido pelo maestro) **ou** a URL do
  Supabase apontar pra `127.0.0.1`/`localhost` (fallback).
- `hub/maestro.mjs` `appSupervisor`: adicionar `EXPED_HUB: '1'` ao `env` do app
  (vale no próximo reinstall/update do hub).

### 2. Server actions (`app/(app)/admin/usuarios/actions.ts`, estender)
Todas: 1) checam autenticação; 2) `if (isHub()) return { error: 'A gestão de equipe é
feita na nuvem.' }` (defesa em profundidade); 3) checam `role==='admin'`; 4) usam
`createAdminClient()` (service_role) pras operações de auth/profile; 5) **forçam o
escopo de empresa** = `empresa_id` do próprio chamador (lido do profile dele), e validam
que o alvo pertence a essa empresa antes de mutar.

- `criarColaboradorAction(input)`:
  - `input`: `{ full_name, email, password, role, hiper_usuario_id? , hiper_usuario_nome? }`
    (zod: email válido, password ≥8, role enum, full_name não-vazio, hiper id int>0 opcional).
  - `admin.auth.admin.createUser({ email, password, email_confirm: true,
    user_metadata: { full_name } })` → trigger `handle_new_user` cria o profile
    (`role='vendedor'`, `empresa_id=null`, `ativo=true`).
  - `admin.from('profiles').update({ empresa_id: callerEmpresaId, role, full_name,
    ativo: true }).eq('id', novoId)`.
  - Se `role==='vendedor'` e `hiper_usuario_id` informado: upsert em `hiper_vendedor_map`
    (`empresa_id=callerEmpresaId, hiper_usuario_id, vendedor_id=novoId, hiper_usuario_nome`).
  - O novo `auth.users` (com `encrypted_password`) e o `profiles` descem no sync → login
    funciona na nuvem e offline no hub.
- `desativarColaboradorAction({ id })`:
  - Bloqueia auto-desativação (`id === caller.id` → erro).
  - Valida que o alvo é `empresa_id = callerEmpresaId`.
  - `admin.auth.admin.updateUserById(id, { ban_duration: '876000h' })` (~100 anos) +
    `admin.from('profiles').update({ ativo: false }).eq('id', id).eq('empresa_id', callerEmpresaId)`.
- `reativarColaboradorAction({ id })`:
  - `admin.auth.admin.updateUserById(id, { ban_duration: 'none' })` +
    `update({ ativo: true })` com o mesmo escopo.
- `updateUserRoleAction` (existente): adicionar o gate `isHub()` no topo (fecha o bug
  latente). Comportamento restante inalterado.

### 3. UI (`app/(app)/admin/usuarios/`)
- `page.tsx`: incluir `ativo` na query; calcular `const hub = isHub()`; corrigir o texto
  desatualizado do header ("Para criar novos, rode scripts/..."); renderizar:
  - **nuvem:** botão "Adicionar colaborador" (abre `components/colaborador-form.tsx`).
  - **hub:** aviso read-only + botão/link "Gerenciar equipe na nuvem" (URL do app nuvem,
    de env `NEXT_PUBLIC_APP_URL`/manifest; texto curto explicando que cadastro é na nuvem).
- `components/usuarios-table.tsx`: coluna/badge Ativo/Inativo; por linha, botão
  "Desativar"/"Reativar" (com confirmação) — escondidos no hub. Inativos podem aparecer
  ao fim da lista, esmaecidos.
- `components/colaborador-form.tsx` (novo): formulário (dialog seguindo o padrão de UI
  existente — shadcn) com nome, email, senha inicial, cargo e — quando cargo=vendedor —
  o campo opcional "ID no Hiper". Mostra a senha definida pro admin repassar.

## Segurança
- Escopo de empresa **sempre** derivado no servidor (`callerEmpresaId` do profile do
  chamador), nunca do input — um admin da Franzoni não cria/mexe em outra empresa.
- service_role bypassa RLS: por isso toda mutação filtra `.eq('empresa_id', callerEmpresaId)`
  e valida o alvo antes. RLS `profiles_admin_all` continua como segunda barreira.
- Trigger `prevent_self_role_change`: em contexto service_role (`auth.uid()` null) as
  mudanças são permitidas — mesmo padrão de `criarEmpresaComAdminAction`.
- Ban via GoTrue é a trava de login canônica e desce no sync (bloqueia login no hub também).
- Emails `@franzoni.local` são aceitos pelo GoTrue (já usados no seed atual).

## Tratamento de erro
- Email já existente → erro claro ("Já existe um colaborador com esse email").
- Falha no createUser → não faz o update de profile (aborta com a mensagem do GoTrue).
- Falha no update de profile após createUser → reporta; usuário fica como vendedor/sem
  empresa (fail-closed: RLS nega tudo); admin pode reenviar (o create é idempotente por
  email — tratar conflito como "já existe").
- Offline na nuvem não se aplica (a ação só roda na nuvem, que tem o banco).

## Testes (vitest)
- Validação dos inputs (zod) de cada action.
- Permissão: não-admin é rejeitado; `isHub()` → ações recusadas.
- Escopo de empresa: admin de E1 não cria/desativa em E2 (alvo de outra empresa rejeitado).
- Auto-desativação bloqueada.
- Fluxo criar: chama createUser, depois update de profile com empresa/role corretos;
  vendedor com hiper id → upsert no map; sem hiper id → sem upsert.
- Desativar/reativar: chama updateUserById com ban/none e atualiza `ativo`.
- `isHub()`: true com `EXPED_HUB=1` ou URL localhost; false caso contrário.

## Decisões registradas
- "Desativar" é **soft** (ban + `ativo=false`), reversível — nunca apaga (preserva
  histórico + FK do `hiper_vendedor_map`).
- Campo Hiper no vendedor é **opcional** (sugestão aceita pelo usuário) — evita pedido
  "sem dono", mas não obriga.
- Cargo `financeiro` fica **fora** desta feature (projeto à parte).
- Gestão é **só-nuvem**; o hub é read-only com link.
