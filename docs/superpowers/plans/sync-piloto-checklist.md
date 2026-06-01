# Checklist de piloto — Sincronizador (hub ↔ nuvem), 1 cliente real

Roteiro pra validar o sincronizador no Windows com **1 cliente real** (1 ou 2 lojas).
Cada passo tem o **o que fazer** e o **que observar**. Os critérios de aprovação estão
no fim — só "aprova" o piloto quem bate todos.

Contexto: a nuvem é a autoridade de merge (campo-a-campo). O hub faz push (local→nuvem)
e pull (nuvem→local) num ciclo periódico, com cursores por tabela no Postgres local
(`public._sync_cursors`). Tabelas `two-way`: clientes, pedidos (+ filhas), ordens_servico
(+ filhas), os_notificacoes. Tabelas `down` (só descem): empresas, profiles,
hiper_vendedor_map, dispositivos. `auth.users` (login offline) desce escopado por empresa.

---

## 0. Pré-requisitos

- [ ] **Hub instalado** (sub-projeto 2 — runtime local Windows: Postgres + GoTrue +
      PostgREST + maestro, via NSSM). `/status` do maestro responde.
- [ ] **Variáveis de ambiente do sync** configuradas pro serviço do hub:
  - [ ] `EXPED_CLOUD_API` = base da API de sync da nuvem (ex.: `https://app.exped...`,
        **sem** barra no fim; o cliente concatena `/api/sync/push` e `/api/sync/pull`).
  - [ ] `EXPED_DEVICE_TOKEN` = token de **um dispositivo** desta empresa (linha em
        `dispositivos`, com o `empresa_id` certo). É esse token que define o **escopo de
        empresa** server-side — o payload do hub nunca escolhe a empresa.
- [ ] Confirmar que o `empresa_id` do dispositivo do token = a empresa que se quer
      sincronizar (senão o pull volta vazio / push é rejeitado 403).

### 0.1 CAVEAT OBRIGATÓRIO — PostgREST local precisa expor o schema `auth`

O sync de `auth.users` (login offline) só funciona se o **PostgREST local** expuser o
schema `auth`, senão os usuários novos baixados não aparecem pro GoTrue local e **o login
offline não enxerga usuários criados depois da instalação**.

- [ ] No env do PostgREST local, garantir:
      ```
      PGRST_DB_SCHEMAS=public,auth
      ```
      (e reiniciar o serviço do PostgREST). Default costuma vir só `public` — **tem que
      incluir `auth`**.
- [ ] Validar: `psql ... -c "select count(*) from auth.users;"` retorna número e, após o
      primeiro pull, cresce com os usuários da empresa.

---

## 1. Cold start (primeira carga)

- [ ] Ligar o sync (subir o serviço do hub / reiniciar o maestro com as envs acima).
- [ ] Acompanhar `/status` do maestro até `lastSyncOk = true` e `lastError` vazio.
- [ ] **Conferir que os dados reais da empresa apareceram no hub.** Contar linhas
      local vs nuvem (devem bater pro escopo da empresa):

  No Postgres **local** (psql do hub):
  ```sql
  select 'clientes' t, count(*) from public.clientes
  union all select 'pedidos', count(*) from public.pedidos
  union all select 'ordens_servico', count(*) from public.ordens_servico
  union all select 'auth.users', count(*) from auth.users;
  ```

  Na **nuvem** (mesma empresa — filtrar por `empresa_id`):
  ```sql
  select 'clientes' t, count(*) from public.clientes where empresa_id = '<EMPRESA_ID>'
  union all select 'pedidos', count(*) from public.pedidos where empresa_id = '<EMPRESA_ID>'
  union all select 'ordens_servico', count(*) from public.ordens_servico where empresa_id = '<EMPRESA_ID>';
  ```

  - [ ] Contagens batem (clientes, pedidos, OS).
  - [ ] `auth.users` local tem os usuários da empresa (login offline vai funcionar).
- [ ] Conferir os cursores avançaram: `select * from public._sync_cursors;` (pull_at já
      não é `epoch` pras tabelas que tinham dados).

---

## 2. Login offline funciona

- [ ] **Derrubar a internet** do hub (desconectar a WAN / bloquear o acesso à nuvem).
- [ ] Fazer **login no app local** (GoTrue local) com um usuário real da empresa.
  - [ ] Login entra (não dá "Database error querying schema" nem "invalid credentials").
- [ ] (Sanidade) Se um usuário foi criado/alterado na nuvem **antes** de derrubar a
      internet, ele consegue logar offline (confirma que o pull de `auth.users` chegou —
      depende do caveat 0.1).

---

## 3. Trabalhar OFFLINE → acumular → religar → subir

- [ ] Ainda **sem internet**, no app/hub local:
  - [ ] Criar uma **OS** nova.
  - [ ] Criar um **pedido** novo (com ponto de retirada + itens).
  - [ ] Editar um cliente existente.
- [ ] Ver a fila **acumular** (nada sobe, e nada quebra):
  - [ ] `/status`: `lastSyncOk = false` (ou `pendingPush > 0`) enquanto offline — é o
        esperado, o hub está re-tentando sem derrubar nada.
  - [ ] Os registros existem no Postgres local (consulta os novos ids).
- [ ] **Religar a internet.** Aguardar 1–2 ciclos de sync.
  - [ ] `/status`: `lastSyncOk = true`, `lastError` vazio, `pendingPush = 0`.
  - [ ] **Conferir na nuvem** (app web / SQL) que a OS, o pedido (+ filhas) e a edição do
        cliente subiram, com o `empresa_id` correto.
  - [ ] Conferir que **pai e filhas chegaram juntos** (pedido com seus itens; OS com seus
        itens/serviços) — nunca pai sem filhos.

---

## 4. Conflito por campo (o teste de confiança)

- [ ] Escolher **um registro** (ex.: um cliente) que existe nos dois lados sincronizado.
- [ ] **Ao mesmo tempo / sem sync no meio:**
  - [ ] Editar o campo **A** (ex.: `endereco`) **no hub local**.
  - [ ] Editar o campo **B** (ex.: `telefone`) do **mesmo registro na nuvem** (app web).
- [ ] Deixar o sync rodar (1–2 ciclos completos).
  - [ ] **Os dois valores coexistem**: no fim, tanto na nuvem quanto no hub o registro tem
        o `endereco` editado no hub **E** o `telefone` editado na nuvem. Nenhuma edição
        sobrescreveu a outra.
- [ ] (Mesmo campo, opcional) Editar o **mesmo campo** nos dois lados → vence a edição
      mais recente (maior `field_updated_at`); os dois lados convergem pra esse valor.

---

## 5. Soft-delete propaga

- [ ] No hub (ou na nuvem) marcar um registro como deletado (`deleted_at`).
- [ ] Após sync: o outro lado vê o registro como deletado.
- [ ] Editar **outro campo** do mesmo registro do outro lado e sincronizar → o registro
      **não ressuscita** (o `deleted_at` permanece).

---

## 6. (Se houver 2ª loja) Convergência multi-site

- [ ] Repetir o passo 4 com **dois hubs** (loja 1 e loja 2) + a nuvem, editando **campos
      diferentes** do mesmo registro em cada loja.
- [ ] Após todos sincronizarem (2 ciclos): **as 2 lojas e a nuvem ficam idênticas**, com
      todas as edições preservadas.

---

## 7. Saúde final do `/status`

- [ ] `lastSyncOk = true`
- [ ] `lastError` vazio / null
- [ ] `pendingPush = 0` (fila zerada)
- [ ] `lastSyncAt` recente (último ciclo rodou agora há pouco)

---

## Critérios de aprovação (todos obrigatórios)

- [ ] **Nada some** — nenhum registro real desaparece após sync (cold start nem ciclos).
- [ ] **Nada duplica** — reenvio/queda no meio não cria linha repetida (PK estável,
      contagens batem).
- [ ] **Login offline funciona** — usuário real loga sem internet (caveat 0.1 aplicado).
- [ ] **Conflito por campo coexiste** — edições em campos diferentes do mesmo registro
      sobrevivem ambas; mesmo campo resolve por última-edição-vence.
- [ ] **Agregados atômicos** — pai sempre com suas filhas na nuvem.
- [ ] **Escopo de empresa respeitado** — só dados da empresa do token sobem/descem;
      nenhum vazamento entre empresas.

> Se qualquer critério falhar: **NÃO aprovar o piloto**. Capturar `/status`, logs do
> maestro/sync e o estado dos cursores (`select * from public._sync_cursors`) antes de
> mexer, e reportar.
