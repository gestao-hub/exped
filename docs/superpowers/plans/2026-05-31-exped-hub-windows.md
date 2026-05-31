# Exped Hub Windows — Empacotamento Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) ou superpowers:executing-plans pra implementar tarefa-a-tarefa. Steps usam checkbox (`- [ ]`).

**Goal:** Empacotar o hub local (Postgres+PostgREST+GoTrue+app+gateway+storage) num **instalador Windows único**, gerenciado por **um serviço (o maestro)**, com storage local de PDFs e auto-update com rollback.

**Architecture:** Jeito A + Jeito 2 (maestro). Código novo é **Node multiplataforma** (maestro, storage-local) — desenvolvido e testado aqui no Linux com vitest. Binários nativos (Postgres/PostgREST/GoTrue win-x64) + instalador (Inno Setup) são **validados no Windows** pelo usuário (ele roda, reporta). Reaproveita o que o spike (sub-projeto 1) provou: `scripts/local-stack/` (ordem de bootstrap, gateway, prelúdio).

**Tech Stack:** Node 20 (ESM .mjs), vitest, Postgres 16 win-x64 (zip oficial), PostgREST win-x64, GoTrue (Go; cross-compilar win-x64 se preciso), Inno Setup 6, NSSM ou `sc.exe`.

**Depende de:** sub-projeto 1 (PR #19). **Spec:** `docs/superpowers/specs/2026-05-31-exped-hub-windows-design.md`.

**Convenção de pastas no Windows:** raiz `C:\Exped\`; binários em `C:\Exped\bin\`; app em `C:\Exped\app\`; dados em `C:\Exped\data\` (cluster PG, storage, estado); logs em `C:\Exped\logs\`; releases em `C:\Exped\releases\<versao>\` com ponteiro `C:\Exped\current`.

---

## File Structure

- `hub/` (Create) — todo o código novo do hub (multiplataforma, testável aqui):
  - `hub/maestro.mjs` — orquestrador (boot order, supervisão, health, logs, dispara auto-update).
  - `hub/supervisor.mjs` — primitiva: inicia/vigia/reinicia um processo filho (com backoff). Testável.
  - `hub/health.mjs` — checks HTTP/TCP de prontidão de cada peça. Testável.
  - `hub/storage-local.mjs` — servidor HTTP que implementa o subconjunto de `/storage/v1` usado pelo app, backed por filesystem.
  - `hub/updater.mjs` — auto-update: compara versão, baixa, valida sha256, troca atômica, rollback.
  - `hub/config.mjs` — lê config do hub (portas, paths, secret, manifest URL) de um JSON + env.
  - `hub/bootstrap.mjs` — roda a ordem do banco (reusa SQL do spike) de forma idempotente.
- `hub/test/` (Create) — testes vitest de supervisor/health/storage-local/updater.
- `hub/win/` (Create) — artefatos Windows:
  - `hub/win/download-binaries.ps1` — baixa Postgres/PostgREST/GoTrue win-x64 pra `bin/`.
  - `hub/win/exped-hub.iss` — script Inno Setup (instalador).
  - `hub/win/install-service.ps1` / `uninstall-service.ps1` — registra/remove o serviço do maestro (NSSM ou sc).
  - `hub/win/README.md` — passo a passo de build/teste no Windows + resultados.
- Reaproveitar de `scripts/local-stack/`: `00-roles-ext.sql`, `00-prelude-helpers.sql`, `gateway.mjs`, ordem do `apply-schema.sh` (o `bootstrap.mjs` porta isso pra Node).

---

## Task 1: Spike de binários nativos no Windows (o maior risco primeiro)

**Files:**
- Create: `hub/win/download-binaries.ps1`, `hub/win/README.md`

- [ ] **Step 1: Script PowerShell que baixa os 3 binários win-x64**

`hub/win/download-binaries.ps1` (baixa pra `C:\Exped\bin\`):
```powershell
$ErrorActionPreference = "Stop"
$bin = "C:\Exped\bin"; New-Item -ItemType Directory -Force -Path $bin | Out-Null
# Postgres portátil (zip oficial EDB)
$pg = "https://get.enterprisedb.com/postgresql/postgresql-16.4-1-windows-x64-binaries.zip"
Invoke-WebRequest $pg -OutFile "$bin\pg.zip"; Expand-Archive "$bin\pg.zip" -DestinationPath $bin -Force
# PostgREST win-x64
$prest = "https://github.com/PostgREST/postgrest/releases/download/v12.2.8/postgrest-v12.2.8-windows-x64.zip"
Invoke-WebRequest $prest -OutFile "$bin\postgrest.zip"; Expand-Archive "$bin\postgrest.zip" -DestinationPath $bin -Force
Write-Host "Postgres + PostgREST baixados. GoTrue: ver Step 3."
```
(Se alguma URL/versão 404, listar releases e ajustar — anotar a versão usada no README.)

- [ ] **Step 2: (no Windows) Provar Postgres + PostgREST nativos sobem**

Rodar no Windows (PowerShell):
```powershell
powershell -ExecutionPolicy Bypass -File hub\win\download-binaries.ps1
C:\Exped\bin\pgsql\bin\initdb.exe -D C:\Exped\data\pg -U postgres
C:\Exped\bin\pgsql\bin\pg_ctl.exe -D C:\Exped\data\pg -o "-p 54329" -l C:\Exped\data\pg\log start
C:\Exped\bin\pgsql\bin\psql.exe -p 54329 -U postgres -c "select version();"
C:\Exped\bin\postgrest.exe --help
```
Expected: psql imprime versão; postgrest imprime ajuda. (Usuário roda e reporta.)

- [ ] **Step 3: Resolver o GoTrue no Windows (o risco real)**

Tentar binário pronto; se não houver win-x64 oficial, cross-compilar do Go (pode ser feito AQUI no Linux, gerando o .exe):
```bash
# AQUI (Linux), gera o binário Windows do GoTrue:
git clone --depth 1 https://github.com/supabase/auth /tmp/auth && cd /tmp/auth
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -o auth.exe .
file auth.exe   # deve dizer "PE32+ executable ... x86-64, for MS Windows"
```
Copiar `auth.exe` + a pasta `migrations/` pro pacote (`bin/`). No Windows, provar:
```powershell
C:\Exped\bin\auth.exe --version
```
Expected: roda no Windows. Documentar no README a origem (versão + se foi cross-compilado).
BLOCKED-criteria: se o GoTrue não rodar no Windows nem cross-compilado, PARAR e reportar (é o achado que pode forçar reavaliar auth local).

- [ ] **Step 4: Commit**
```bash
git add hub/win/download-binaries.ps1 hub/win/README.md
git commit -m "feat(hub-win): script de binários win-x64 + GoTrue cross-compilado + spike doc"
```

---

## Task 2: Supervisor + Health (primitivas testáveis aqui)

**Files:**
- Create: `hub/supervisor.mjs`, `hub/health.mjs`, `hub/test/supervisor.test.mjs`, `hub/test/health.test.mjs`

- [ ] **Step 1: Teste do health check (HTTP + TCP) — falha primeiro**

`hub/test/health.test.mjs`:
```javascript
import { describe, it, expect } from 'vitest';
import { waitForHttp, waitForTcp } from '../health.mjs';
import http from 'node:http';

describe('health', () => {
  it('waitForHttp resolve quando o endpoint responde 2xx/4xx', async () => {
    const srv = http.createServer((_, res) => { res.statusCode = 200; res.end('ok'); }).listen(0);
    const port = srv.address().port;
    await expect(waitForHttp(`http://127.0.0.1:${port}/`, 2000)).resolves.toBe(true);
    srv.close();
  });
  it('waitForHttp rejeita se nunca responde', async () => {
    await expect(waitForHttp('http://127.0.0.1:1/', 800)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar** — `npx vitest run hub/test/health.test.mjs` → FAIL (módulo não existe).

- [ ] **Step 3: Implementar `hub/health.mjs`**
```javascript
import net from 'node:net';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function waitForHttp(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.status < 500) return true;
    } catch { /* ainda subindo */ }
    await sleep(500);
  }
  throw new Error(`health timeout: ${url}`);
}

export async function waitForTcp(host, port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const s = net.connect({ host, port }, () => { s.end(); resolve(true); });
      s.on('error', () => resolve(false)); s.setTimeout(1500, () => { s.destroy(); resolve(false); });
    });
    if (ok) return true;
    await sleep(500);
  }
  throw new Error(`tcp timeout: ${host}:${port}`);
}
```

- [ ] **Step 4: Rodar teste** → PASS.

- [ ] **Step 5: Teste do supervisor (reinicia processo que morre) — falha primeiro**

`hub/test/supervisor.test.mjs`:
```javascript
import { describe, it, expect } from 'vitest';
import { Supervisor } from '../supervisor.mjs';

describe('Supervisor', () => {
  it('reinicia um processo que sai, respeitando maxRestarts', async () => {
    const sup = new Supervisor({ name: 'eco', cmd: process.execPath,
      args: ['-e', 'process.exit(1)'], maxRestarts: 2, backoffMs: 50 });
    sup.start();
    await new Promise(r => setTimeout(r, 600));
    expect(sup.restarts).toBeGreaterThanOrEqual(1);
    expect(sup.restarts).toBeLessThanOrEqual(2);
    sup.stop();
  });
});
```

- [ ] **Step 6: Rodar e ver falhar.**

- [ ] **Step 7: Implementar `hub/supervisor.mjs`**
```javascript
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';

export class Supervisor {
  constructor({ name, cmd, args = [], env = {}, cwd, logPath, maxRestarts = Infinity, backoffMs = 1000 }) {
    Object.assign(this, { name, cmd, args, env, cwd, logPath, maxRestarts, backoffMs });
    this.restarts = 0; this.child = null; this.stopped = false;
  }
  start() {
    this.stopped = false; this._spawn(); return this;
  }
  _spawn() {
    const out = this.logPath ? createWriteStream(this.logPath, { flags: 'a' }) : 'inherit';
    this.child = spawn(this.cmd, this.args, { env: { ...process.env, ...this.env }, cwd: this.cwd,
      stdio: ['ignore', out || 'inherit', out || 'inherit'] });
    this.child.on('exit', (code) => {
      if (this.stopped) return;
      if (this.restarts >= this.maxRestarts) return;
      this.restarts++;
      setTimeout(() => { if (!this.stopped) this._spawn(); }, this.backoffMs);
    });
  }
  stop() { this.stopped = true; if (this.child) this.child.kill(); }
}
```

- [ ] **Step 8: Rodar teste** → PASS.

- [ ] **Step 9: Commit**
```bash
git add hub/supervisor.mjs hub/health.mjs hub/test/
git commit -m "feat(hub): supervisor (restart+backoff) + health checks (HTTP/TCP) + testes"
```

---

## Task 3: Storage local (PDFs offline) + roteamento no gateway

**Files:**
- Create: `hub/storage-local.mjs`, `hub/test/storage-local.test.mjs`
- Modify: `scripts/local-stack/gateway.mjs` (rotear `/storage/v1` pro storage local em vez do stub 501)

- [ ] **Step 1: Auditar o uso real de storage do app**

Run: `git grep -n "\.storage\.from(\|/storage/v1\|createSignedUrl\|getPublicUrl\|\.upload(\|\.download(" -- '*.ts' '*.tsx' | grep -v node_modules`
Expected: lista as chamadas reais (upload de PDF no bucket `pedidos-pdfs`, geração de URL, download). Implementar SÓ o que aparecer (YAGNI). Anotar a lista no topo do `storage-local.mjs`.

- [ ] **Step 2: Teste do storage local (upload → download grava/serve do disco) — falha primeiro**

`hub/test/storage-local.test.mjs`:
```javascript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startStorage } from '../storage-local.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';

let srv, base, dir;
beforeAll(async () => { dir = mkdtempSync(join(tmpdir(),'stg-')); srv = await startStorage({ port: 0, root: dir }); base = `http://127.0.0.1:${srv.port}`; });
afterAll(() => { srv.close(); rmSync(dir, { recursive: true, force: true }); });

describe('storage-local', () => {
  it('upload grava e download devolve o mesmo conteúdo', async () => {
    const body = Buffer.from('%PDF-1.4 teste');
    const up = await fetch(`${base}/storage/v1/object/pedidos-pdfs/x/y.pdf`, { method: 'POST', body });
    expect(up.status).toBeLessThan(300);
    const down = await fetch(`${base}/storage/v1/object/pedidos-pdfs/x/y.pdf`);
    expect(Buffer.from(await down.arrayBuffer()).equals(body)).toBe(true);
  });
});
```

- [ ] **Step 3: Rodar e ver falhar.**

- [ ] **Step 4: Implementar `hub/storage-local.mjs`** (HTTP puro, sem deps; cobre upload/download; signed URL = devolve a própria URL local)
```javascript
import http from 'node:http';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';

export async function startStorage({ port = 5402, root }) {
  const server = http.createServer(async (req, res) => {
    const m = req.url.match(/^\/storage\/v1\/object\/(?:sign\/|public\/)?([^?]+)/);
    if (!m) { res.statusCode = 404; return res.end('{}'); }
    const rel = normalize(m[1]).replace(/^(\.\.[/\\])+/, '');
    const abs = join(root, rel);
    try {
      if (req.method === 'POST' || req.method === 'PUT') {
        const chunks = []; for await (const c of req) chunks.push(c);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, Buffer.concat(chunks));
        res.statusCode = 200; return res.end(JSON.stringify({ Key: rel }));
      }
      if (req.method === 'GET') {
        const data = await readFile(abs);
        res.statusCode = 200; res.setHeader('Content-Type', 'application/pdf'); return res.end(data);
      }
      res.statusCode = 405; res.end('{}');
    } catch (e) { res.statusCode = 404; res.end(JSON.stringify({ error: String(e) })); }
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return { port: server.address().port, close: () => server.close() };
}
```
(Ajustar as rotas exatamente pro que a auditoria da Step 1 mostrar — ex.: se o app usa `createSignedUrl`, adicionar `POST /storage/v1/object/sign/...` devolvendo `{ signedURL: "/storage/v1/object/<...>" }`.)

- [ ] **Step 5: Rodar teste** → PASS.

- [ ] **Step 6: Rotear no gateway**: em `scripts/local-stack/gateway.mjs`, trocar o stub 501 de `/storage/v1` por proxy pra `127.0.0.1:<porta storage>`. Rodar o e2e do spike (`node scripts/local-stack/e2e-test.mjs`) + um upload/download via supabase-js pra confirmar que passa pelo gateway.

- [ ] **Step 7: Commit**
```bash
git add hub/storage-local.mjs hub/test/storage-local.test.mjs scripts/local-stack/gateway.mjs
git commit -m "feat(hub): storage local (PDFs no filesystem) + roteamento /storage/v1 no gateway"
```

---

## Task 4: Bootstrap em Node + App standalone

**Files:**
- Create: `hub/bootstrap.mjs`, `hub/config.mjs`
- Modify: `next.config.ts` (garantir `output: 'standalone'`)

- [ ] **Step 1: `next.config.ts` com output standalone** — conferir/adicionar `output: 'standalone'` (gera `.next/standalone/server.js` que roda com Node puro, sem `next start`). Rodar `npm run build` e confirmar que `.next/standalone/server.js` existe.

- [ ] **Step 2: `hub/config.mjs`** — lê `C:\Exped\config.json` (+ env) com: portas (pg 54329, postgrest 54331, gotrue 9999, gateway 54320, storage 5402, app 3000), paths, `jwtSecret`, `manifestUrl`. Defaults sensatos.

- [ ] **Step 3: `hub/bootstrap.mjs`** — porta a ordem validada no spike (idempotente): se o DB `exped` não existe → cria → aplica `scripts/local-stack/00-roles-ext.sql` → `auth.exe migrate` (ou `--migrate-only`) → `00-prelude-helpers.sql` → todas as `supabase/migrations/*.sql`. Se já existe, aplica só migrations novas (controle por uma tabela `schema_version` ou por idempotência dos `if not exists`). Expor `await bootstrap(config)`.

- [ ] **Step 4: Teste do bootstrap (no Linux, contra o Postgres do spike)** — `hub/test/bootstrap.test.mjs`: roda `bootstrap()` num DB temпорário e verifica que `empresas`/`profiles`/`ordens_servico` existem. (Reusa o Postgres local já rodando; cria DB `exped_test`, dropa no fim.)

- [ ] **Step 5: Rodar testes** → PASS. **Commit**:
```bash
git add hub/bootstrap.mjs hub/config.mjs hub/test/bootstrap.test.mjs next.config.ts
git commit -m "feat(hub): bootstrap idempotente em Node + app Next standalone"
```

---

## Task 5: Maestro + Auto-update (com rollback)

**Files:**
- Create: `hub/maestro.mjs`, `hub/updater.mjs`, `hub/test/updater.test.mjs`

- [ ] **Step 1: Teste do updater (compara versão; rollback em health-fail) — falha primeiro**

`hub/test/updater.test.mjs`:
```javascript
import { describe, it, expect } from 'vitest';
import { isNewer } from '../updater.mjs';
describe('updater', () => {
  it('detecta versão mais nova (semver simples)', () => {
    expect(isNewer('1.2.0', '1.1.9')).toBe(true);
    expect(isNewer('1.1.0', '1.1.0')).toBe(false);
    expect(isNewer('1.0.0', '1.2.0')).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar.**

- [ ] **Step 3: Implementar `hub/updater.mjs`** — `isNewer(a,b)` (compara semver), `checkAndUpdate(config, {restart, health})`:
  1. GET `config.manifestUrl` → `{ versao, url, sha256 }`.
  2. se `isNewer(versao, atual)`: baixa pra `releases/<versao>.zip`, valida sha256, extrai pra `releases/<versao>/`.
  3. salva ponteiro anterior; aponta `current` → `<versao>`; chama `restart()`.
  4. `await health()`; se falhar em N s → reverte `current` pro anterior, `restart()`, marca a versão como "ruim" (não retenta).
  Incluir código completo de `isNewer` + a estrutura de `checkAndUpdate` (download/sha256/swap/rollback) com `node:crypto` pro sha256.

- [ ] **Step 4: Rodar teste** → PASS.

- [ ] **Step 5: Implementar `hub/maestro.mjs`** — usa config + Supervisors + health + bootstrap + updater:
  1. inicia Postgres (Supervisor) → `waitForTcp(pg)` → `bootstrap(config)`.
  2. inicia PostgREST, GoTrue serve, storage-local, gateway (Supervisors) → `waitForHttp` de cada.
  3. inicia o app standalone (`node app/server.js`) → `waitForHttp(app)`.
  4. timer периódico → `updater.checkAndUpdate(...)` (fora de pico).
  5. endpoint `/status` (porta interna) com estado de cada peça.
  6. SIGTERM/stop → derruba todos os Supervisors na ordem inversa.
  Logs unificados em `C:\Exped\logs\`.

- [ ] **Step 6: Smoke test do maestro no Linux** — rodar `node hub/maestro.mjs` apontando pro stack do spike (portas já usadas) num modo "dry"/parcial OU contra um config de teste; confirmar que ele sobe peças e o `/status` responde. (Onde portas colidirem com o spike, usar config alternativo.) Documentar.

- [ ] **Step 7: Commit**
```bash
git add hub/maestro.mjs hub/updater.mjs hub/test/updater.test.mjs
git commit -m "feat(hub): maestro (orquestra+supervisiona+health) + auto-update com rollback"
```

---

## Task 6: Instalador Inno Setup + teste do zero no Windows

**Files:**
- Create: `hub/win/exped-hub.iss`, `hub/win/install-service.ps1`, `hub/win/uninstall-service.ps1`

- [ ] **Step 1: Serviço do maestro** — `install-service.ps1` registra o maestro como serviço Windows auto-start. Usar NSSM (bundlar `nssm.exe`) OU `sc.exe create ExpedHub binPath= "C:\Exped\bin\node.exe C:\Exped\app-hub\maestro.mjs" start= auto` + um wrapper. Abrir portas LAN no firewall (`netsh advfirewall firewall add rule ...` pra porta do app + gateway). `uninstall-service.ps1` reverte.

- [ ] **Step 2: Script Inno Setup** `hub/win/exped-hub.iss` — `[Files]` copia `C:\Exped\` (bin, app, hub, scripts SQL, node portátil); `[Run]` executa `download-binaries.ps1` (ou embute os binários), depois `install-service.ps1`, depois dispara o 1º start (maestro faz o bootstrap). `[UninstallRun]` chama `uninstall-service.ps1`. Parametrizar `config.json` (jwtSecret gerado, manifestUrl, identificação da empresa).

- [ ] **Step 3: (no Windows) Compilar o instalador** — `ISCC.exe hub\win\exped-hub.iss` gera `ExpedHubSetup.exe`. (Usuário roda; reporta.)

- [ ] **Step 4: (no Windows, VM limpa) Instalar do zero e validar ponta a ponta**
  1. Rodar `ExpedHubSetup.exe` → avançar/concluir.
  2. Conferir o serviço `ExpedHub` RUNNING (`sc query ExpedHub`).
  3. De outro PC da LAN, abrir `http://<ip-do-host>:3000/login` → login → ver mapa/OS → **abrir um PDF** (storage local) → fazer uma escrita.
  4. Reiniciar a máquina → tudo sobe sozinho.
  Expected: tudo funciona offline, sem Docker. Anotar resultados no `hub/win/README.md`.

- [ ] **Step 5: (no Windows) Testar auto-update** — publicar um manifesto fake apontando uma versão nova de teste; ver o maestro baixar, trocar e (forçando um health-fail) **fazer rollback**. Documentar.

- [ ] **Step 6: Commit**
```bash
git add hub/win/
git commit -m "feat(hub-win): instalador Inno Setup + serviço do maestro + teste do zero em VM + auto-update"
```

---

## Resultado esperado

Um **`ExpedHubSetup.exe`** que instala o hub local completo no Windows: a equipe acessa o Exped pela LAN, **com ou sem internet**, abre/imprime PDFs (storage local), e o sistema **se atualiza sozinho com segurança** (rollback). Tudo gerido por **um serviço** (o maestro), sem Docker.

**O que fica pro próximo (sub-projeto 3):** o **sincronizador** que mantém este hub local em dia com a nuvem (deltas bidirecionais + fila + conflito).

## Self-review (cobertura da spec)
- §3 componentes → Tasks 1,4,6. §4 maestro → Task 5. §5 storage local → Task 3. §6 auto-update → Task 5. §7 instalador → Task 6. §8 testes Windows → Tasks 1,6. §9 riscos: GoTrue→Task 1, Postgres portátil→Task 1, Next standalone→Task 4, update corrompido→Task 5, firewall→Task 6. Sem lacunas.
