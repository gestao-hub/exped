# Credenciais de release do Hub

O pipeline de release usa duas credenciais JWT dedicadas e nunca usa
`service_role`:

- `exped_hub_release_stage`: cria apenas artefatos imutaveis
  `windows/<versao>.zip` e `windows/<versao>.json`.
- `exped_hub_release_promote`: cria ou atualiza apenas `manifest.json`.

As duas roles sao `NOLOGIN`, nao ignoram RLS e nao podem apagar objetos. A
migration `hub_release_storage_roles` cria as roles e as policies do bucket
`hub-releases`.

## Segredos e variaveis do GitHub

Configure ambientes separados no GitHub:

| Ambiente | Variaveis | Segredo |
| --- | --- | --- |
| `hub-stage` | `HUB_STAGE_SUPABASE_PROJECT_REF`, `HUB_STAGE_SUPABASE_ANON_KEY` | `HUB_STAGE_ACCESS_TOKEN` |
| `hub-promotion` | `HUB_PROMOTION_SUPABASE_PROJECT_REF`, `HUB_PROMOTION_SUPABASE_ANON_KEY` | `HUB_PROMOTION_ACCESS_TOKEN` |

Proteja `hub-promotion` com aprovacao manual e restrinja os dois ambientes a
branch `main`. O workflow de build de codigo-fonte nao recebe nenhuma dessas
credenciais; um job separado e confiavel faz stage ou promocao.

## Emissao e rotacao

Emita cada token fora do repositorio e do GitHub Actions, usando o JWT secret do
projeto. Use um UUID dedicado e estavel em `sub` para cada credencial e uma
janela de validade curta o bastante para ter rotacao operacional. Exemplo de
claims para montar antes de assinar com `HS256`:

```js
const now = Math.floor(Date.now() / 1000);
const claims = {
  role: 'exped_hub_release_stage',
  sub: '<uuid-dedicado-ao-stage>',
  iat: now,
  nbf: now - 60,
  exp: now + (30 * 24 * 60 * 60),
};
```

Para o segundo token, troque `role` por `exped_hub_release_promote`. Use uma
expiracao definida, registre a data de rotacao e substitua o segredo do ambiente
antes do vencimento. O script rejeita token expirado, token ainda nao valido,
role divergente e `service_role`.

Nunca armazene o JWT secret no repositorio ou nos ambientes de release. Esse
segredo permite emitir tokens para qualquer role. Gere os dois tokens em uma
estacao administrativa segura, armazene somente os JWTs resultantes nos
ambientes do GitHub e revogue-os por rotacao do JWT secret em caso de vazamento.
