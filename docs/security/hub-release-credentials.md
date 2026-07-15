# Credenciais de release do Hub

O pipeline usa duas chaves secretas opacas do Supabase, cada uma vinculada a
uma role PostgreSQL minima. Ele nunca usa `service_role`:

- `exped_hub_release_stage`: cria apenas artefatos imutaveis
  `windows/<versao>.zip` e `windows/<versao>.json`.
- `exped_hub_release_promote`: promove apenas um artefato previamente aprovado
  para `manifest.json`.

As duas roles sao `NOLOGIN`, nao ignoram RLS e nao podem apagar objetos. Antes
de qualquer acesso autenticado ao Storage, o script chama
`assert_hub_release_access` e exige que a role e o `sub` UUID da chave sejam
comprovados pelo banco.

## Pre-requisitos no Supabase

Antes de criar ou usar as chaves, aplique e verifique estas migrations, nesta
ordem:

1. `20260714202311_hub_release_storage_roles.sql`
2. `20260714223000_hub_release_promotion_rpc.sql`
3. `20260715115548_hub_release_api_key_auth.sql`

Sem a terceira migration, o primeiro stage falha fechado antes de tocar o
Storage.

## Segredos e variaveis do GitHub

Configure ambientes separados no GitHub:

| Ambiente | Variavel | Segredo |
| --- | --- | --- |
| `hub-stage` | `HUB_STAGE_SUPABASE_PROJECT_REF` | `HUB_STAGE_SUPABASE_RELEASE_KEY` |
| `hub-promotion` | `HUB_PROMOTION_SUPABASE_PROJECT_REF` | `HUB_PROMOTION_SUPABASE_RELEASE_KEY` |

Proteja `hub-promotion` com aprovacao manual e restrinja os dois ambientes a
branch `main`. O job que compila o ZIP nao recebe nenhuma credencial; jobs
separados e confiaveis fazem stage e promocao.

Nao configure `SUPABASE_ANON_KEY`, JWT assinado manualmente ou o JWT secret do
projeto nesses ambientes. Esses valores pertencem ao fluxo legado e nao sao
necessarios para a release.

## Emissao

Crie uma chave Supabase do tipo `secret` para cada ambiente pela Management
API, com nomes distintos e `secret_jwt_template` dedicado:

```json
{
  "type": "secret",
  "name": "hub-release-stage",
  "secret_jwt_template": {
    "role": "exped_hub_release_stage",
    "sub": "<uuid-exclusivo-do-stage>"
  }
}
```

Para promocao, use outro UUID, o nome `hub-release-promote` e a role
`exped_hub_release_promote`. Solicite `reveal=true` somente durante a criacao,
grave a resposta em arquivo temporario com permissao restrita e envie a chave
ao GitHub por entrada padrao. Nunca imprima a chave, passe-a na linha de comando
ou a armazene no repositorio.

Depois de configurar os ambientes, prove as duas chaves contra
`assert_hub_release_access` antes da primeira release. Valide tambem que:

- a chave de stage e rejeitada ao pedir a role de promocao;
- a chave de promocao e rejeitada ao pedir a role de stage;
- uma chave `service_role` e rejeitada;
- somente a chave de stage cria objetos imutaveis;
- somente a chave de promocao altera o manifesto canonico.

## Rotacao e revogacao

Para rotacionar, crie uma nova chave com outro `sub`, valide a RPC, substitua o
segredo do ambiente e execute um preflight. Exclua a chave antiga somente apos
confirmar o novo fluxo. A exclusao de uma chave secreta opaca a revoga sem
rotacionar o JWT secret do projeto e sem afetar a outra etapa do pipeline.

Em caso de suspeita de vazamento, desative a release afetada, exclua a chave no
Supabase, emita outra com novo `sub` e revise os logs de auditoria antes de
reativar o ambiente.
