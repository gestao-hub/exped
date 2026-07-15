# Histórico completo e sincronismo resiliente

**Data:** 2026-07-14
**Base:** `v0.3.20` (`origin/main`)
**Estado:** aprovado pelo usuário em 2026-07-14

## Contexto

O pedido de mapa 4079 existia no banco local da Franzoni, mas não aparecia na
nuvem. A investigação encontrou uma cadeia de falhas:

1. O Hub estava sem `deviceToken` e operava em modo ilha.
2. Depois do provisionamento, o pull de `auth.users` encontrou o mesmo e-mail em
   IDs diferentes no banco local e na nuvem.
3. Pedidos locais ainda apontavam para o ID antigo do vendedor. O push desses
   pedidos falhava por chave estrangeira e um registro problemático bloqueava os
   registros posteriores do lote.
4. O indicador `pendingPush` voltava para zero após um ciclo bem-sucedido mesmo
   quando ainda havia páginas posteriores ao cursor.
5. A tela Histórico iniciava com o filtro `finalizado`, embora os perfis
   administrativo e caixa precisem consultar pedidos em qualquer status.

O incidente foi destravado operacionalmente e o mapa 4079 chegou à nuvem. Este
trabalho transforma a correção manual em comportamento permanente e observável.

## Objetivos

- Abrir o Histórico exibindo pedidos ativos de todos os status.
- Permitir busca por número do mapa, inclusive entradas como `#4079`.
- Manter os indicadores financeiros restritos a pedidos finalizados.
- Impedir que colisões locais de identidade por e-mail bloqueiem o sync.
- Impedir que um vendedor inexistente na nuvem bloqueie pedidos e OS.
- Drenar backlog em múltiplas páginas e reportar a fila restante com precisão.
- Expor diagnóstico suficiente no `/status` sem incluir tokens ou dados pessoais.
- Corrigir os achados de segurança diretamente relacionados e de baixo risco.
- Publicar aplicação, migration e Hub com canário e rollback definidos.

## Não objetivos

- Reescrever o sincronizador como uma fila distribuída ou criar dead-letter queue.
- Exibir pedidos removidos por `deleted_at`.
- Inventar ou inferir datas de entrega ausentes.
- Alterar a regra de negócio dos KPIs de faturamento.
- Mover extensões PostgreSQL já instaladas no schema `public` neste ciclo.
- Remover índices apenas porque o advisor ainda não registrou uso.
- Executar `npm audit fix --force` ou aceitar downgrade do Next.js.

## Experiência do Histórico

### Lista

- `HistoricoPage` passa `initialStatus="todos"` para `PedidosList`.
- A lista continua oferecendo todos os filtros de status já existentes:
  `rascunho`, `em_financeiro`, `pendente`, `em_separacao`, `em_transporte`,
  `parcialmente_entregue`, `finalizado` e `cancelado`.
- Toda consulta de lista e exportação exclui explicitamente `deleted_at` não nulo.
- A busca reconhece um número puro ou prefixado por `#` como `numero_mapa` e
  mantém a busca textual por cliente, documento ERP e bairro.
- Os filtros de período continuam usando `data_entrega`, com rótulo explícito.
  Pedidos sem data permanecem visíveis quando nenhum período estiver aplicado.

### Cabeçalho, KPIs e exportação

- O texto da página passa a indicar consulta de todos os pedidos.
- Os três KPIs continuam sendo calculados por `historico_kpis` somente sobre
  `status = 'finalizado'` e `deleted_at is null`.
- O botão passa a se chamar `Exportar finalizados`, deixando claro que não segue
  o filtro corrente da lista.
- A exportação continua paginada e protegida por RLS.

### Detalhe

- A rota `/historico/[id]` continua somente leitura.
- O texto do detalhe usa o status real do pedido e não afirma que todo registro
  consultado está finalizado.
- As permissões continuam sendo determinadas pela RLS: admin, logística e caixa
  veem os pedidos da empresa; vendedor vê os seus e os ainda sem responsável.

## Reconciliação de identidade local

### Regra canônica

A identidade da nuvem vence quando o Hub recebe um `auth.users` com e-mail
normalizado igual ao de um usuário local, mas com UUID diferente. A igualdade é
por `lower(trim(email))`; IDs diferentes com e-mails diferentes nunca são unidos.

### Registro interno

O Hub cria `exped_internal.identity_aliases`, fora do schema exposto pelo
PostgREST, com:

- `old_user_id uuid primary key`
- `canonical_user_id uuid not null`
- `normalized_email text not null`
- `created_at timestamptz not null`
- `resolved_at timestamptz null`
- `last_error text null`

### Fluxo

1. Antes do upsert de `auth.users`, o Hub procura conflito de e-mail.
2. Sem conflito, mantém o upsert atual por `id`.
3. Com conflito, registra o alias, troca o e-mail do usuário antigo por um alias
   interno único e insere o usuário canônico.
4. O pull aplica `profiles`, incluindo o profile canônico.
5. Ao fim da página de pull, o Hub reconcilia aliases cujo profile canônico já
   exista, atualizando referências nas tabelas locais:
   `pedidos.vendedor_id`, `ordens_servico.vendedor_id`,
   `hiper_vendedor_map.vendedor_id`, `pedido_comentarios.autor_id`,
   `pedido_eventos.usuario_id` e `pedido_logistica.updated_by`.
6. Alterações em `pedidos` e `ordens_servico` recebem carimbo normal de mudança
   para subir no ciclo seguinte. Tabelas somente-down são atualizadas com a flag
   interna de sync para não criar mudanças artificiais.
7. Depois de todas as referências migrarem, o profile e o auth user antigos são
   removidos e o alias recebe `resolved_at`.
8. Se o profile canônico ainda não existir, o alias permanece pendente e é
   tentado novamente no próximo ciclo.

Cada etapa local que altera identidade roda em transação. Falha parcial faz
rollback e aparece no estado do sync; não deixa metade das referências migradas.

## Defesa na nuvem para vendedor ausente

Uma migration adiciona triggers `before insert or update` em `pedidos` e
`ordens_servico`. Quando `vendedor_id` não existe em `profiles`, o vínculo vira
`null` antes da validação da chave estrangeira. Os demais dados do registro são
preservados.

Essa é uma última defesa: a reconciliação local deve manter a autoria quando há
correspondência por e-mail. O fallback para `null` só evita que uma referência
irrecuperável bloqueie toda a fila. A RLS atual já torna pedidos sem vendedor
visíveis para reconhecimento e atribuição posterior.

## Backlog e estado do sincronismo

### Push paginado

- Cada tabela two-way envia páginas ordenadas de até `SYNC_LIMIT`.
- Após confirmar uma página, o cursor avança e a próxima página é enviada no
  mesmo ciclo.
- O ciclo respeita um limite de páginas e um orçamento de tempo para não manter
  o processo ocupado indefinidamente.
- Ao atingir o limite, o ciclo termina saudável, mas `caughtUp` fica falso e o
  próximo tick continua do cursor confirmado.
- Falhas HTTP, rejeições de escopo e erros de aplicação nunca avançam o cursor
  da página não confirmada.

### Contagem real

O adaptador local ganha uma operação de contagem por tabela após o cursor. No fim
de cada ciclo, o estado contém:

- `pendingPush`: soma exata das linhas ainda acima de cada `push_at`.
- `pendingByTable`: mapa de tabela para quantidade pendente.
- `caughtUp`: verdadeiro somente quando todas as tabelas têm zero pendências.
- `phase`: `idle`, `pushing`, `pulling` ou `error`.
- `runningSince`: início do ciclo em andamento, ou `null` quando ocioso.
- `lastSyncAt`: término da última tentativa.
- `lastSuccessAt`: término do último ciclo sem erro.
- `consecutiveFailures`: tentativas consecutivas com erro.
- `lastError`: mensagem sanitizada da primeira falha do ciclo.
- `lastBlockedRow`: tabela e chave primária quando identificáveis.
- `lastSkipped`: linhas de pull que não puderam ser aplicadas.

O `/status` publica esses campos, mas nunca e-mail, token, payload ou SQL.

### Diagnóstico de linha

O engine da nuvem envolve falhas de escrita com contexto sanitizado de tabela e
PK. O Hub registra esse contexto em `lastBlockedRow`. A fila continua conservadora:
uma linha desconhecida não é descartada silenciosamente, e o cursor permanece
antes dela para permitir correção e reprocessamento.

## Paridade do registro de tabelas

Um teste compara integralmente os registros de sync da nuvem e do Hub: nome,
direção, PK e parentesco. A PK de `hiper_vendedor_map` é normalizada para a chave
composta real `(empresa_id, hiper_usuario_id)`, eliminando a divergência hoje não
coberta pelo teste que verifica apenas a quantidade de tabelas.

## Segurança e dependências

### Supabase

A migration de hardening:

- habilita RLS em `public.provision_redeem_attempts`;
- revoga acesso de `anon`, `authenticated` e `PUBLIC` à tabela;
- preserva o uso server-side por `service_role`;
- revoga `EXECUTE` público das funções de trigger
  `log_pedido_status_change`, `pedido_reconcilia_cliente` e
  `prevent_vendedor_qtd_entregue`;
- fixa `search_path = public` nas funções apontadas pelo advisor quando isso não
  altera sua semântica.

Helpers deliberadamente usados por políticas RLS, como `current_empresa_id`,
`current_user_role` e `is_platform_admin`, mantêm o grant necessário para
`authenticated`.

### Dependências Node

- Atualizações transitivas sem quebra para `@babel/core`, `hono` e `js-yaml`
  podem entrar somente se `npm audit`, testes e build confirmarem a correção.
- O alerta de `postcss` aninhado no Next.js não será corrigido com `--force`, pois
  a sugestão atual do npm faria downgrade incompatível do Next.
- Qualquer alerta residual será documentado com pacote, caminho transitivo e
  motivo da postergação.

## Testes

Toda mudança comportamental segue red-green-refactor.

### Histórico

- página inicia em `todos`;
- KPIs e exportação permanecem finalizados;
- busca `4079` e `#4079` gera filtro por `numero_mapa`;
- busca textual mantém os campos atuais;
- lista e export ignoram soft-deletados;
- detalhe renderiza status real.

### Sync

- conflito de mesmo e-mail e UUID diferente cria alias;
- referências das seis tabelas migram para o UUID canônico;
- falha durante a migração faz rollback;
- alias aguarda profile canônico e tenta novamente;
- vendedor inexistente não bloqueia pedido nem OS na nuvem;
- push com 500 + 500 + 30 linhas envia três páginas e zera backlog;
- limite de tempo mantém backlog não zero e continua no ciclo seguinte;
- erro não avança cursor e identifica tabela/PK;
- `/status` diferencia tentativa, sucesso, backlog e falhas consecutivas;
- registros de tabelas local e cloud permanecem idênticos.

### Segurança

- `anon` e `authenticated` não acessam `provision_redeem_attempts`;
- funções de trigger não podem ser chamadas como RPC por usuários;
- admin e caixa continuam lendo todos os pedidos da própria empresa;
- vendedor continua restrito ao escopo previsto.

### Verificação completa

Antes de publicar:

1. `npm test`
2. `npm run typecheck`
3. `npm run lint`
4. `npm run build`
5. testes SQL de RLS e triggers numa branch/banco de teste
6. advisors de segurança e performance do Supabase
7. smoke test autenticado dos perfis admin, caixa, logística e vendedor

## Publicação e rollback

1. Criar migration idempotente e validar em ambiente isolado.
2. Registrar contagens pré-deploy de pedidos, perfis e aliases relevantes.
3. Aplicar a migration na nuvem e repetir testes SQL/RLS.
4. Publicar a aplicação na Vercel e executar smoke tests.
5. Gerar release `0.3.21` do Hub com checksum validado.
6. Atualizar o manifest somente depois de aplicação e banco estarem saudáveis.
7. Usar a Franzoni como canário e confirmar `/status`, backlog e pedido recente.
8. Observar sincronismo e erros antes de considerar a publicação concluída.

Rollback da aplicação usa o deployment anterior da Vercel. Rollback do Hub restaura
o manifest anterior e força atualização para o pacote conhecido. As migrations são
aditivas; o fallback de vendedor pode ser removido pelos nomes dos triggers, e os
grants/RLS podem ser restaurados por migration reversa explícita. Nenhum rollback
apaga pedidos ou aliases.

## Critérios de aceite

- Histórico abre em Todos para administrativo e caixa.
- Mapa 4079 é encontrado por `4079`, `#4079` e documento ERP.
- Alternar entre todos os oito status produz resultados coerentes.
- KPIs continuam iguais à contagem de finalizados da empresa.
- Um conflito de e-mail equivalente ao incidente não exige SQL manual.
- Um vendedor órfão não bloqueia pedidos posteriores.
- Backlog acima de 500 é drenado em páginas e nunca aparece falsamente como zero.
- `/status` permite distinguir offline, bloqueado, processando e sincronizado.
- Nenhum token, hash de senha ou payload aparece no status ou erro de cliente.
- Advisors não reportam RLS desabilitada em tabela pública.
- Testes, typecheck, lint e build terminam sem falhas.
