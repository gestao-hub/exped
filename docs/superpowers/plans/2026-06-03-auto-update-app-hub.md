# Auto-update do app local (hub) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer o auto-update do app local do hub funcionar de ponta a ponta (rodar a release apontada + aplicar migrations aditivas) e criar o pipeline que publica releases num bucket público.

**Architecture:** Duas metades. (A) **Consumidor (hub)**: `resolveAppEntrypoint` passa a ler o ponteiro `current`; `getCurrentVersion` lê o ponteiro; `checkAndUpdate` ganha um callback `migrate(releaseDir)` que reusa o runner idempotente do bootstrap. (B) **Publicador**: `scripts/release-hub.mjs` empacota app+migrations num zip versionado e sobe pro Supabase Storage, disparado por CI em `git tag v*`.

**Tech Stack:** Node ESM (hub `.mjs`), Vitest (`hub/test/*.test.mjs`), Supabase Storage REST, GitHub Actions.

**Spec:** [docs/superpowers/specs/2026-06-03-auto-update-app-hub-design.md](../specs/2026-06-03-auto-update-app-hub-design.md)

---

## File Structure

| Arquivo | Responsabilidade |
|---|---|
| `hub/bootstrap.mjs` | Parametrizar o dir das migrations (`applyPendingMigrations(cfg, db, dir)`, `listMigrations(dir)`), exportar. |
| `hub/maestro.mjs` | `resolveAppEntrypoint` lê ponteiro; `readPointerSync`; `currentAppVersion`; `appSupervisor` usa o ponteiro; wiring do `migrate`/`getCurrentVersion`. |
| `hub/config.mjs` | Defaults `version`, `paths.releasesDir`, `paths.releasesPtr`. |
| `hub/updater.mjs` | `checkAndUpdate` chama `cb.migrate(releaseDir)` após extrair, antes do restart. |
| `scripts/release-hub.mjs` | Empacota app+migrations → zip+sha → sobe pro bucket; partes puras testáveis. |
| `.github/workflows/release-hub.yml` | CI: em tag `v*`, build + publish. |
| `hub/win/config.example.json` | `manifestUrl` default = bucket. |
| Testes | `hub/test/{bootstrap,maestro,updater}.test.mjs` + `scripts/__tests__/release-hub.test.mjs` |

---

## Task 1: Parametrizar o dir das migrations (bootstrap)

**Files:**
- Modify: `hub/bootstrap.mjs`
- Test: `hub/test/bootstrap-listmigrations.test.mjs` (novo, evita o teste de integração que precisa de psql)

- [ ] **Step 1: Write the failing test**

```js
// hub/test/bootstrap-listmigrations.test.mjs
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listMigrations } from '../bootstrap.mjs';

let dir;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'mig-'));
  writeFileSync(path.join(dir, '20260102_b.sql'), 'select 1');
  writeFileSync(path.join(dir, '20260101_a.sql'), 'select 1');
  writeFileSync(path.join(dir, 'readme.txt'), 'nope');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('listMigrations(dir)', () => {
  it('lê do dir passado, só .sql, ordenado', () => {
    const ms = listMigrations(dir);
    expect(ms.map((m) => m.name)).toEqual(['20260101_a.sql', '20260102_b.sql']);
    expect(ms[0].file).toBe(path.join(dir, '20260101_a.sql'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- hub/test/bootstrap-listmigrations.test.mjs`
Expected: FAIL — `listMigrations` não é exportada / assinatura antiga `(cfg)`.

- [ ] **Step 3: Modify `hub/bootstrap.mjs`**

Trocar `listMigrations` e `applyPendingMigrations` por versões parametrizadas e **exportá-las**.
Localize:
```js
/** lista as migrations do app em ordem alfabética (= cronológica) */
function listMigrations(cfg) {
  const dir = resolveRoot(cfg.paths.migrationsDir);
  return readdirSync(dir)
```
Troque por:
```js
/** lista as migrations (.sql) de um diretório, em ordem alfabética (= cronológica) */
export function listMigrations(dir) {
  return readdirSync(dir)
```
(o corpo seguinte — `.filter(...).sort().map(...)` — fica igual, mas usando `dir` direto.)

Localize:
```js
/** aplica as migrations do app ainda não registradas e registra cada uma */
async function applyPendingMigrations(cfg, targetDb) {
  await ensureHubMigrationsTable(cfg, targetDb);
  const done = await appliedMigrations(cfg, targetDb);
  for (const m of listMigrations(cfg)) {
```
Troque por:
```js
/**
 * Aplica as migrations do app ainda não registradas (em `_hub_migrations`) e registra cada uma.
 * `migrationsDir` default = o dir do install (cfg.paths.migrationsDir); o auto-update passa o dir da release.
 */
export async function applyPendingMigrations(cfg, targetDb, migrationsDir = resolveRoot(cfg.paths.migrationsDir)) {
  await ensureHubMigrationsTable(cfg, targetDb);
  const done = await appliedMigrations(cfg, targetDb);
  for (const m of listMigrations(migrationsDir)) {
```
(o restante do corpo fica igual.) A chamada em `bootstrap()` (`await applyPendingMigrations(cfg, db)`) **não muda** (usa o default).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- hub/test/bootstrap-listmigrations.test.mjs`
Expected: PASS (1 teste).

- [ ] **Step 5: Commit**

```bash
git add hub/bootstrap.mjs hub/test/bootstrap-listmigrations.test.mjs
git commit -m "refactor(hub): applyPendingMigrations/listMigrations aceitam dir explicito (p/ auto-update)"
```

---

## Task 2: `resolveAppEntrypoint` lê o ponteiro

**Files:**
- Modify: `hub/maestro.mjs`
- Test: `hub/test/maestro.test.mjs` (adicionar casos)

- [ ] **Step 1: Write the failing test** (adicionar ao `hub/test/maestro.test.mjs`)

```js
import { resolveAppEntrypoint, readPointerSync } from '../maestro.mjs';
import path from 'node:path';

describe('resolveAppEntrypoint com ponteiro', () => {
  const root = '/srv';
  const rel = '/srv/releases';
  it('ponteiro presente + release existe → releases/<v>/server.js', () => {
    const exists = (p) => p === path.join(rel, '1.2.0', 'server.js');
    expect(resolveAppEntrypoint(root, rel, '1.2.0', exists)).toBe(path.join(rel, '1.2.0', 'server.js'));
  });
  it('ponteiro presente mas release não existe → app/server.js', () => {
    const exists = (p) => p === path.join(root, 'app', 'server.js');
    expect(resolveAppEntrypoint(root, rel, '1.2.0', exists)).toBe(path.join(root, 'app', 'server.js'));
  });
  it('sem ponteiro → app/server.js quando existe', () => {
    const exists = (p) => p === path.join(root, 'app', 'server.js');
    expect(resolveAppEntrypoint(root, rel, null, exists)).toBe(path.join(root, 'app', 'server.js'));
  });
  it('sem ponteiro e sem app → dev standalone', () => {
    const exists = () => false;
    expect(resolveAppEntrypoint(root, rel, null, exists)).toBe(path.join(root, '.next', 'standalone', 'server.js'));
  });
});

describe('readPointerSync', () => {
  it('lê e trima o ponteiro; ausente → null', () => {
    expect(readPointerSync('/x', () => '  1.2.0\n')).toBe('1.2.0');
    expect(readPointerSync('/x', () => { throw new Error('enoent'); })).toBe(null);
    expect(readPointerSync('/x', () => '   ')).toBe(null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- hub/test/maestro.test.mjs`
Expected: FAIL — `resolveAppEntrypoint` tem assinatura `(root, exists)`; `readPointerSync` não existe.

- [ ] **Step 3: Modify `hub/maestro.mjs`**

(a) No import de `node:fs`, garantir `readFileSync`. Localize o import de `existsSync` (ex.: `import { existsSync } from 'node:fs';`) e troque por:
```js
import { existsSync, readFileSync } from 'node:fs';
```

(b) Trocar `resolveAppEntrypoint`:
```js
export function resolveAppEntrypoint(root, exists = existsSync) {
  const installer = path.join(root, 'app', 'server.js');
  const dev = path.join(root, '.next', 'standalone', 'server.js');
  if (exists(installer)) return installer;
  return dev;
}
```
por:
```js
/**
 * Resolve o entrypoint do app testando, em ordem:
 *   1. <releasesDir>/<pointer>/server.js  (release adotada pelo auto-update)
 *   2. <root>/app/server.js               (base instalada)
 *   3. <root>/.next/standalone/server.js  (dev)
 */
export function resolveAppEntrypoint(root, releasesDir, pointer, exists = existsSync) {
  if (pointer && releasesDir) {
    const rel = path.join(releasesDir, pointer, 'server.js');
    if (exists(rel)) return rel;
  }
  const installer = path.join(root, 'app', 'server.js');
  const dev = path.join(root, '.next', 'standalone', 'server.js');
  if (exists(installer)) return installer;
  return dev;
}

/** Lê o ponteiro `current` (versão adotada). Ausente/vazio → null. Síncrono. */
export function readPointerSync(ptrPath, read = readFileSync) {
  try {
    return String(read(ptrPath, 'utf8')).trim() || null;
  } catch {
    return null;
  }
}
```

(c) No `appSupervisor`, resolver o entrypoint pelo ponteiro a cada start. Localize:
```js
function appSupervisor(cfg, logDir, keys) {
  const gatewayUrl = `http://127.0.0.1:${cfg.ports.gateway}`;
  return new Supervisor({
    name: 'app',
    cmd: process.execPath,
    // Entrypoint resolvido: app/server.js (instalador) ou .next/standalone/server.js
    // (dev). Remove a necessidade do junction usado como workaround no Windows.
    args: [resolveAppEntrypoint(ROOT)],
```
Troque por:
```js
function appSupervisor(cfg, logDir, keys) {
  const gatewayUrl = `http://127.0.0.1:${cfg.ports.gateway}`;
  const releasesDir = cfg.paths.releasesDir || path.join(ROOT, 'releases');
  const ptrPath = cfg.paths.releasesPtr || path.join(releasesDir, 'current');
  return new Supervisor({
    name: 'app',
    cmd: process.execPath,
    // Entrypoint: a release apontada por `current` (auto-update) > app/server.js > dev.
    // Lido a cada start, então o restart pós-update já sobe a versão nova.
    args: [resolveAppEntrypoint(ROOT, releasesDir, readPointerSync(ptrPath))],
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- hub/test/maestro.test.mjs`
Expected: PASS (os novos casos + os já existentes).

- [ ] **Step 5: Commit**

```bash
git add hub/maestro.mjs hub/test/maestro.test.mjs
git commit -m "fix(hub): app roda a release apontada pelo ponteiro current (auto-update)"
```

---

## Task 3: `currentAppVersion` + defaults de config + wiring do getCurrentVersion

**Files:**
- Modify: `hub/maestro.mjs`, `hub/config.mjs`
- Test: `hub/test/maestro.test.mjs`, `hub/test/config.test.mjs`

- [ ] **Step 1: Write the failing tests**

Em `hub/test/maestro.test.mjs`:
```js
import { currentAppVersion } from '../maestro.mjs';
describe('currentAppVersion', () => {
  it('ponteiro tem precedência; senão cfg.version; senão 0.0.0', () => {
    expect(currentAppVersion('1.3.0', '1.0.0')).toBe('1.3.0');
    expect(currentAppVersion(null, '1.0.0')).toBe('1.0.0');
    expect(currentAppVersion(null, undefined)).toBe('0.0.0');
  });
});
```
Em `hub/test/config.test.mjs` (adicionar):
```js
import { loadConfig } from '../config.mjs';
it('config tem defaults de release (version, releasesDir, releasesPtr)', () => {
  const cfg = loadConfig({ jwtSecret: 'x'.repeat(40) });
  expect(typeof cfg.version).toBe('string');
  expect(cfg.paths.releasesDir).toBeTruthy();
  expect(cfg.paths.releasesPtr).toBeTruthy();
});
```
> Confirme o nome real do loader em `config.mjs` (ex.: `loadConfig`/`resolveConfig`) e ajuste o import + a chamada (com um jwtSecret válido ≥32 chars, como os testes de config já fazem).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- hub/test/maestro.test.mjs hub/test/config.test.mjs`
Expected: FAIL — `currentAppVersion` não existe; `cfg.version`/`releasesDir`/`releasesPtr` indefinidos.

- [ ] **Step 3: Implement**

(a) `hub/maestro.mjs` — adicionar a função pura (perto de `resolveAppEntrypoint`):
```js
/** Versão atual do app: ponteiro adotado > cfg.version baked no install > 0.0.0. */
export function currentAppVersion(pointer, cfgVersion) {
  return pointer || cfgVersion || '0.0.0';
}
```
(b) `hub/maestro.mjs` — no wiring do auto-update, trocar:
```js
    updateTimer = setInterval(() => {
      checkAndUpdate(cfg, {
        getCurrentVersion: () => cfg.version || '0.0.0',
```
por (ler o ponteiro fresco a cada checagem):
```js
    const releasesDir = cfg.paths.releasesDir || path.join(ROOT, 'releases');
    const ptrPath = cfg.paths.releasesPtr || path.join(releasesDir, 'current');
    updateTimer = setInterval(() => {
      checkAndUpdate(cfg, {
        getCurrentVersion: () => currentAppVersion(readPointerSync(ptrPath), cfg.version),
```
(c) `hub/config.mjs` — no objeto `DEFAULTS`, dentro de `paths`, adicionar (após `authBin`):
```js
    releasesDir: 'releases',
    releasesPtr: 'releases/current',
```
e no nível de `DEFAULTS` (junto de `manifestUrl`), adicionar:
```js
  version: '0.0.0', // versão base instalada; o instalador carimba a real (de package.json) no config.json
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- hub/test/maestro.test.mjs hub/test/config.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hub/maestro.mjs hub/config.mjs hub/test/maestro.test.mjs hub/test/config.test.mjs
git commit -m "feat(hub): getCurrentVersion le o ponteiro + defaults de release no config"
```

---

## Task 4: callback `migrate(releaseDir)` no updater + wiring no maestro

**Files:**
- Modify: `hub/updater.mjs`, `hub/maestro.mjs`
- Test: `hub/test/updater.test.mjs`

- [ ] **Step 1: Write the failing test** (adicionar ao `hub/test/updater.test.mjs`)

```js
describe('updater.checkAndUpdate migrate', () => {
  const baseDeps = {
    fetchManifest: async () => ({ versao: '1.1.0', url: 'http://x/a.zip', sha256: 'ok' }),
    download: async () => {},
    verifySha: async () => 'ok',
    extract: async () => {},
  };
  it('chama migrate(releaseDir) depois de extrair e antes de restart; sucesso', async () => {
    const order = [];
    let pointer = '1.0.0';
    const res = await checkAndUpdate(
      { manifestUrl: 'http://x/m.json', paths: { releasesDir: '/r' } },
      {
        getCurrentVersion: () => '1.0.0',
        migrate: async (dir) => { order.push(`migrate:${dir}`); },
        restart: async () => { order.push('restart'); },
        health: async () => {},
        logger: { info() {}, error() {} },
      },
      {
        ...baseDeps,
        extract: async () => { order.push('extract'); },
        setPointer: async (v) => { pointer = v; },
        getPointer: async () => pointer,
      },
    );
    expect(res).toEqual({ updated: true, versao: '1.1.0' });
    // migrate roda depois de extract e antes de restart, com o dir da release
    const iMig = order.findIndex((s) => s.startsWith('migrate:'));
    const iRes = order.indexOf('restart');
    expect(iMig).toBeGreaterThan(order.indexOf('extract'));
    expect(iMig).toBeLessThan(iRes);
    expect(order[iMig]).toBe('migrate:/r/1.1.0');
  });
  it('rollback no health-fail NÃO chama migrate de novo', async () => {
    let migrates = 0;
    let pointer = '1.0.0';
    const res = await checkAndUpdate(
      { manifestUrl: 'http://x/m.json', paths: { releasesDir: '/r' } },
      {
        getCurrentVersion: () => '1.0.0',
        migrate: async () => { migrates++; },
        restart: async () => {},
        health: async () => { throw new Error('health falhou'); },
        logger: { info() {}, error() {} },
      },
      { ...baseDeps, setPointer: async (v) => { pointer = v; }, getPointer: async () => pointer },
    );
    expect(res).toEqual({ updated: false, rolledBack: true });
    expect(migrates).toBe(1); // só na ida, não no rollback
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- hub/test/updater.test.mjs`
Expected: FAIL — `migrate` não é chamado (ainda não existe no fluxo).

- [ ] **Step 3: Modify `hub/updater.mjs`**

No `checkAndUpdate`, localize o bloco (5):
```js
  // (5) extrai + troca ponteiro
  const previous = await getPointer();
  await extract(zipPath, path.join(releasesDir, versao));
  await setPointer(versao);
  await restart();
```
Troque por:
```js
  // (5) extrai + (migrate aditivo) + troca ponteiro + restart
  const previous = await getPointer();
  const releaseDir = path.join(releasesDir, versao);
  await extract(zipPath, releaseDir);
  if (cb.migrate) await cb.migrate(releaseDir); // migrations da release (aditivas, idempotentes)
  await setPointer(versao);
  await restart();
```
(o bloco (6) health/rollback fica igual — no rollback **não** chamamos `migrate` de novo; migrations aditivas ficam.)

Atualize o JSDoc do `cb` no topo de `checkAndUpdate` para incluir `migrate?(releaseDir)`.

- [ ] **Step 4: Wire no `hub/maestro.mjs`**

No wiring do auto-update (onde está `restart`/`health`), adicionar o `migrate` ao objeto `cb`.
Importar `applyPendingMigrations` no topo do maestro (junto do import do bootstrap, ex.:
`import { bootstrap } from './bootstrap.mjs';` → `import { bootstrap, applyPendingMigrations } from './bootstrap.mjs';`).
Depois, no objeto passado ao `checkAndUpdate`:
```js
      checkAndUpdate(cfg, {
        getCurrentVersion: () => currentAppVersion(readPointerSync(ptrPath), cfg.version),
        migrate: async (releaseDir) =>
          applyPendingMigrations(cfg, cfg.paths.db, path.join(releaseDir, 'supabase', 'migrations')),
        restart,
        health,
        logger,
      })
```

- [ ] **Step 5: Run test + commit**

Run: `npm run test -- hub/test/updater.test.mjs` (PASS)
```bash
git add hub/updater.mjs hub/maestro.mjs hub/test/updater.test.mjs
git commit -m "feat(hub): auto-update aplica migrations da release (aditivas) antes do restart"
```

---

## Task 5: pipeline de release — `scripts/release-hub.mjs`

**Files:**
- Create: `scripts/release-hub.mjs`
- Test: `scripts/__tests__/release-hub.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// scripts/__tests__/release-hub.test.mjs
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { buildManifest, sha256Buffer, versaoValida } from '../release-hub.mjs';

describe('release-hub (partes puras)', () => {
  it('buildManifest monta {versao,url,sha256}', () => {
    expect(buildManifest('1.2.0', 'https://x/h/1.2.0.zip', 'abc')).toEqual({
      versao: '1.2.0', url: 'https://x/h/1.2.0.zip', sha256: 'abc',
    });
  });
  it('sha256Buffer = hash hex do buffer', () => {
    const buf = Buffer.from('hello');
    expect(sha256Buffer(buf)).toBe(createHash('sha256').update(buf).digest('hex'));
  });
  it('versaoValida aceita semver limpo, rejeita lixo', () => {
    expect(versaoValida('1.2.0')).toBe(true);
    expect(versaoValida('v1.2.0')).toBe(false);
    expect(versaoValida('1.2.0; rm')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- scripts/__tests__/release-hub.test.mjs`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implement `scripts/release-hub.mjs`**

```js
// Empacota o app Next standalone + migrations num <versao>.zip e publica no bucket
// público `hub-releases` do Supabase Storage, com manifest.json {versao,url,sha256}.
//
// Uso (CI ou local):
//   SR=<service_role> PROJECT_REF=louaguxcohfeicxxqggw node scripts/release-hub.mjs [versao]
// Sem `versao`, usa a do package.json. Pré-requisito: `npm run build` já rodado.

import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, rmSync, cpSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function buildManifest(versao, url, sha256) {
  return { versao, url, sha256 };
}
export function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}
export function versaoValida(v) {
  return typeof v === 'string' && /^[0-9]+(\.[0-9]+){0,2}$/.test(v);
}

/** Monta releases/<versao>/ com o app standalone + static + public + migrations. */
function montarRelease(versao) {
  const out = path.join(ROOT, 'releases', versao);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(path.join(ROOT, '.next', 'standalone'), out, { recursive: true });
  mkdirSync(path.join(out, '.next'), { recursive: true });
  cpSync(path.join(ROOT, '.next', 'static'), path.join(out, '.next', 'static'), { recursive: true });
  if (existsSync(path.join(ROOT, 'public')))
    cpSync(path.join(ROOT, 'public'), path.join(out, 'public'), { recursive: true });
  cpSync(path.join(ROOT, 'supabase', 'migrations'), path.join(out, 'supabase', 'migrations'), { recursive: true });
  return out;
}

async function uploadStorage(ref, sr, objectPath, buf, contentType) {
  const url = `https://${ref}.supabase.co/storage/v1/object/hub-releases/${objectPath}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { apikey: sr, Authorization: `Bearer ${sr}`, 'Content-Type': contentType, 'x-upsert': 'true' },
    body: buf,
  });
  if (!res.ok) throw new Error(`upload ${objectPath} HTTP ${res.status}: ${await res.text()}`);
}

async function main() {
  const ref = process.env.PROJECT_REF;
  const sr = process.env.SR;
  if (!ref || !sr) throw new Error('defina PROJECT_REF e SR (service_role)');
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const versao = process.argv[2] || pkg.version;
  if (!versaoValida(versao)) throw new Error(`versão inválida: ${versao}`);

  const releaseDir = montarRelease(versao);
  const zipPath = path.join(ROOT, 'releases', `${versao}.zip`);
  rmSync(zipPath, { force: true });
  // tar -a -c -f cria .zip no Windows10+/Linux com libarchive; no Linux CI usar zip -r.
  execFileSync('bash', ['-c', `cd "${releaseDir}" && zip -qr "${zipPath}" .`], { stdio: 'inherit' });

  const zipBuf = readFileSync(zipPath);
  const sha = sha256Buffer(zipBuf);
  const zipUrl = `https://${ref}.supabase.co/storage/v1/object/public/hub-releases/${versao}.zip`;
  const manifest = buildManifest(versao, zipUrl, sha);

  await uploadStorage(ref, sr, `${versao}.zip`, zipBuf, 'application/zip');
  await uploadStorage(ref, sr, 'manifest.json', Buffer.from(JSON.stringify(manifest)), 'application/json');

  console.log('Publicado:', JSON.stringify(manifest));
  console.log('manifestUrl:', `https://${ref}.supabase.co/storage/v1/object/public/hub-releases/manifest.json`);
}

// só roda main() quando executado direto (não no import dos testes)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
}
```

- [ ] **Step 4: Run test + lint + commit**

Run: `npm run test -- scripts/__tests__/release-hub.test.mjs` (PASS, 3 testes)
Run: `npm run lint` (sem novos erros nesse arquivo)
```bash
git add scripts/release-hub.mjs scripts/__tests__/release-hub.test.mjs
git commit -m "feat(release): script de publish do app no bucket hub-releases"
```

---

## Task 6: CI de release + manifestUrl default no instalador

**Files:**
- Create: `.github/workflows/release-hub.yml`
- Modify: `hub/win/config.example.json`

- [ ] **Step 1: Create the workflow**

```yaml
# .github/workflows/release-hub.yml
name: release-hub
on:
  push:
    tags: ['v*']
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '24' }
      - run: npm ci
      - name: Guard tag == package.json version
        run: |
          TAG="${GITHUB_REF_NAME#v}"
          PKG=$(node -p "require('./package.json').version")
          test "$TAG" = "$PKG" || { echo "tag $TAG != package.json $PKG"; exit 1; }
      - run: npm run typecheck
      - run: npm run test
      - name: Build app (standalone)
        run: npm run build
        env:
          NEXT_PUBLIC_SUPABASE_URL: ${{ secrets.NEXT_PUBLIC_SUPABASE_URL }}
          NEXT_PUBLIC_SUPABASE_ANON_KEY: ${{ secrets.NEXT_PUBLIC_SUPABASE_ANON_KEY }}
      - name: Publish release
        run: node scripts/release-hub.mjs
        env:
          SR: ${{ secrets.SUPABASE_SERVICE_ROLE }}
          PROJECT_REF: ${{ secrets.SUPABASE_PROJECT_REF }}
```

- [ ] **Step 2: manifestUrl default no instalador**

Em `hub/win/config.example.json`, setar `manifestUrl` (hoje `null`) para a URL pública do bucket:
```json
  "manifestUrl": "https://louaguxcohfeicxxqggw.supabase.co/storage/v1/object/public/hub-releases/manifest.json",
```
> Conferir a chave exata no arquivo (`manifestUrl` no nível raiz) e manter o resto intacto.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release-hub.yml hub/win/config.example.json
git commit -m "ci(release): publica release em tag v*; manifestUrl default no instalador"
```

---

## Task 7: Bucket + verificação

**Files:** nenhum (setup + verificação).

- [ ] **Step 1: Criar o bucket público `hub-releases`** (uma vez, no Supabase)

No painel Supabase → Storage → New bucket → nome `hub-releases`, **Public** marcado. (Ou via API
com service_role.) Leitura pública; escrita só service_role.

- [ ] **Step 2: Gates locais**

Run: `npm run test -- hub/test/ scripts/__tests__/release-hub.test.mjs`
Expected: os testes novos passam (o `bootstrap.test.mjs` de integração pode falhar por falta de psql local — pré-existente, não é regressão).
Run: `npm run typecheck` (exit 0)
Run: `npm run lint` (sem novos erros nos arquivos tocados)

- [ ] **Step 3: Configurar secrets do GitHub** (uma vez)

`SUPABASE_SERVICE_ROLE`, `SUPABASE_PROJECT_REF` (=`louaguxcohfeicxxqggw`),
`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` nas Actions secrets do repo.

- [ ] **Step 4: Smoke e2e (no go-live/staging, manual)**

Bumpar `package.json` version → `git tag vX.Y.Z` → push → CI publica → conferir
`manifest.json` + `<versao>.zip` no bucket (URL pública abre). Num hub instalado, ver o
`/status` / logs registrarem o update na próxima checagem.

---

## Self-Review (autor do plano)

- **Cobertura do spec:** resolveAppEntrypoint lê ponteiro (T2) ✓; getCurrentVersion lê ponteiro (T3) ✓;
  config `version`/`releasesDir`/`releasesPtr` (T3) ✓; migrations no update via `migrate(releaseDir)` +
  `applyPendingMigrations` parametrizado (T1+T4) ✓; rollback não desfaz migration (T4 teste) ✓;
  pipeline `release-hub.mjs` (T5) ✓; CI em tag + guard tag==version (T6) ✓; manifestUrl default (T6) ✓;
  bucket público (T7) ✓; sha/health/rollback reaproveitados (updater atual, sem mudança) ✓.
- **Placeholders:** nenhum — todo código escrito. (T3 pede confirmar o nome do loader do config e a
  chave manifestUrl no .json — são verificações pontuais, não placeholders de conteúdo.)
- **Consistência de tipos:** `resolveAppEntrypoint(root, releasesDir, pointer, exists)` e
  `readPointerSync(ptrPath, read)` e `currentAppVersion(pointer, cfgVersion)` usados igual em T2/T3;
  `applyPendingMigrations(cfg, db, dir)` definido em T1 e chamado em T4; `migrate(releaseDir)` definido
  no updater (T4) e provido pelo maestro (T4); `buildManifest/sha256Buffer/versaoValida` definidos e
  testados em T5.
- **Fora de escopo (do spec):** canary, auto-update do hub Node/binários, auto-update do agente — não há tasks (correto).
