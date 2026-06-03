# Auto-update do app local (hub) — Design

> Data: 2026-06-03 · Projeto: Exped · **Sub-projeto 1 de 2** (o 2 = auto-update do agente .NET, spec próprio depois).

## 1. Problema

O hub local roda uma cópia do app Next na LAN do cliente. Hoje, mudança de código no app
**não chega** ao hub do cliente: o auto-update existe ([hub/updater.mjs](../../../hub/updater.mjs))
mas está **quebrado e incompleto**:
- `appSupervisor` resolve o entrypoint por caminho fixo (`app/server.js`) e **ignora o ponteiro
  `current`** ([maestro.mjs:196](../../../hub/maestro.mjs#L196), [resolveAppEntrypoint:96](../../../hub/maestro.mjs#L96)) → baixa a versão nova mas continua rodando a antiga.
- `getCurrentVersion` é `cfg.version || '0.0.0'` e `cfg.version` **nem existe** no config
  ([config.mjs](../../../hub/config.mjs)) → re-baixaria pra sempre.
- **Não há pipeline** que empacote/publique uma release, nem feed hospedado.

Resultado: pra atualizar o app no cliente, hoje seria preciso reinstalar — não escala.

## 2. Objetivo

"Muda código → publica uma vez → todo hub local se atualiza sozinho", incluindo **migrations
aditivas**, com a rede de segurança que já existe (sha256 + health-check + rollback).

## 3. Decisões firmadas

- **Hospedagem:** bucket **público** no Supabase Storage (`hub-releases`) guarda `manifest.json` +
  `<versao>.zip`. Hub lê por HTTP; sem token no cliente. Upload só com service_role (no publish).
- **Migrations:** **incluídas** no update (opção B), **restritas a aditivas** (add coluna/tabela,
  nunca drop/alter destrutivo — protocolo do CLAUDE.md). Reusa o aplicador idempotente do bootstrap
  (`public._hub_migrations`, [bootstrap.mjs:141-159](../../../hub/bootstrap.mjs#L141-L159)).
- **Publish:** **CI no `git tag`** (`v*`), gating pelos testes que já rodam no CI. Build reproduzível.
- **Rollout escalonado (canary):** **fora de escopo agora** (1 cliente). Feed é global (todos pegam
  a última). Anotar como upgrade quando houver vários clientes (exigirá ponto de controle, ex.: rota Vercel).
- **Versão:** fonte única = `package.json` `version` (a tag `vX.Y.Z` deve casar). É a versão baked no
  install e a que o publish carimba no manifest.

## 4. Arquitetura

Duas metades independentes:
- **Consumidor (hub):** conserta o auto-update pra rodar a release apontada + aplicar migrations.
- **Publicador (CI + script):** empacota e sobe a release pro bucket.

## 5. Consumidor — mudanças no hub

### 5.1 `resolveAppEntrypoint` lê o ponteiro ([maestro.mjs:96](../../../hub/maestro.mjs#L96))
Nova ordem: se `releasesPtr` (`current`) aponta `<versao>` e `releases/<versao>/server.js` existe →
usa ele; senão `app/server.js` (base instalada); senão `.next/standalone/server.js` (dev).
**Resolvido a cada `.start()`** do `appSupervisor` (boot e restart leem o ponteiro fresco), não fixado em boot.

### 5.2 `getCurrentVersion` lê o ponteiro
No wiring do update ([maestro.mjs:365](../../../hub/maestro.mjs#L365)):
`getCurrentVersion = () => (pointer atual) ?? cfg.version ?? '0.0.0'`. Pós-update o ponteiro tem a
versão nova → `isNewer` para de disparar.

### 5.3 `config.mjs` ganha defaults
- `version`: versão base instalada (carimbada de `package.json` no build/install).
- `paths.releasesDir` (Win `C:\Exped\releases`), `paths.releasesPtr` (Win `C:\Exped\current`).
- `manifestUrl`: passa a ter default = URL pública do `manifest.json` no bucket (antes era `null`)
  — via `config.example.json` no instalador, então **todo install nasce se-atualizando**.

### 5.4 Migrations no fluxo de update ([updater.mjs:139](../../../hub/updater.mjs#L139))
`checkAndUpdate` ganha um callback opcional **`migrate(releaseDir)`**, chamado **depois de extrair,
antes de `restart()`**. O maestro fornece esse callback: ele aplica as migrations de
`releases/<versao>/supabase/migrations/` no Postgres local, reusando o aplicador do bootstrap
(idempotente, registra em `_hub_migrations`). Aplica só as novas.
- O **release zip inclui `supabase/migrations/`** (além do app standalone).
- **Rollback:** se o health falhar, reverte o ponteiro do app; as migrations (aditivas) **ficam** —
  app antigo + schema aditivo = seguro. Não há rollback de SQL.
- Refator necessário: extrair de `bootstrap.mjs` uma função exportável
  `applyAppMigrations(cfg, targetDb, migrationsDir)` (hoje a lógica usa `cfg.paths.migrationsDir`
  fixo; parametrizar o dir). O bootstrap normal passa a chamá-la com seu dir; o updater passa o dir da release.

## 6. Publicador — pipeline de release

### 6.1 Script `scripts/release-hub.mjs`
1. Lê `version` do `package.json` (ou arg).
2. `npm run build` (ou assume buildado em CI).
3. Monta `releases/<versao>/`: `.next/standalone/*` + `.next/static` (em `.next/static`) + `public/`
   + **`supabase/migrations/`**.
4. Zipa → `<versao>.zip`; calcula **sha256**.
5. Sobe `<versao>.zip` + `manifest.json` (`{ versao, url, sha256 }`) pro bucket `hub-releases`
   (Supabase Storage REST, `Authorization: Bearer <service_role>`), `url` = URL pública do zip.
6. Imprime a `manifestUrl` final.

Partes puras (testáveis): montar o objeto `manifest`, validar `version` (semver limpo), calcular sha.
O upload é I/O (verificação manual / e2e no CI).

### 6.2 Workflow CI (`.github/workflows/release-hub.yml`)
- Dispara em `push` de **tag `v*`**.
- Job: `npm ci` → (typecheck/lint/test reaproveitando o ci.yml ou rodando antes) → `npm run build`
  → `node scripts/release-hub.mjs`.
- Secrets do GitHub: `SUPABASE_SERVICE_ROLE`, `SUPABASE_PROJECT_REF` (ou URL do bucket).
- A versão vem da tag (`v1.3.0` → `1.3.0`); job **falha** se a tag ≠ `package.json` version (guarda de consistência).

### 6.3 Bucket
Criar bucket público `hub-releases` no Supabase (uma vez). Leitura pública (download do manifest+zip);
escrita só service_role. `manifestUrl` = `https://<ref>.supabase.co/storage/v1/object/public/hub-releases/manifest.json`.

## 7. Fluxo completo

```
[dev] muda código → bump package.json version → git tag vX.Y.Z → push
        ↓ (CI)
testes passam → build → release-hub.mjs → sobe <versao>.zip + manifest.json no bucket
        ↓ (cada hub, a cada updateIntervalMs ~1h)
checkAndUpdate: manifest tem versão nova → baixa zip → valida sha256 →
  migrate(releaseDir) [migrations novas, aditivas] → setPointer(versao) → restart app →
  health /login 200 → ok  | falhou → rollback do ponteiro + restart (migrations ficam)
```

## 8. Erros / segurança

- **Integridade:** sha256 do zip (já existe). Versão semver limpa antes de virar path/arg (já existe).
- **Disponibilidade:** health-check `/login` 200 em 60s + rollback automático (já existe).
- **Schema:** migrations aditivas + `_hub_migrations` → rollback do app seguro; sem SQL destrutivo.
- **Publish:** testes gating no CI; service_role só em secret de CI (nunca no cliente).
- **Chicken-and-egg:** essas correções vão **dentro do `ExpedSetup.exe`** — Franzoni (e futuros)
  já instalam com o auto-update funcionando. (Não há instalações antigas em produção pra migrar.)

## 9. Testes

- **Unit (vitest, padrão `hub/test/*.mjs`):**
  - `resolveAppEntrypoint`: ponteiro presente+release existe → `releases/<v>/server.js`; ausente → `app/server.js`; dev → standalone.
  - `getCurrentVersion`: lê ponteiro; fallback `cfg.version`; fallback `'0.0.0'`.
  - `checkAndUpdate`: chama `migrate(releaseDir)` **depois de extract, antes de restart**; no rollback **não** chama nada que desfaça migration (reusa deps injetáveis existentes).
  - `applyAppMigrations`: aplica só as não-registradas (mock do psql), registra em `_hub_migrations`.
  - `release-hub` (partes puras): shape do manifest, sha256, validação de versão, guarda tag==package.json.
- **Manual/e2e:** publicar uma release de teste no bucket e ver um hub adotá-la (no go-live/staging).

## 10. Fora de escopo (anotado)

- **Canary / rollout por empresa** — exigirá ponto de controle (rota Vercel decidindo versão por
  empresa) em vez do manifest global. Fazer quando houver vários clientes.
- **Auto-update do hub Node** (maestro/updater em si) e dos binários (Postgres/PostgREST/GoTrue) —
  fora; só o **processo do app** se atualiza. Mudança no hub Node ainda exige reinstalar.
- **Auto-update do agente .NET** — é o **sub-projeto 2** (spec próprio).
