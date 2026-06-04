# Hub na rede (LAN) + HTTPS + tempo-real — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expor o hub central do Exped na LAN da loja atrás de um porteiro HTTPS único (`https://10.1.1.30`), com notificação (via HTTPS) e fila ao vivo (via SSE), num instalador só.

**Architecture:** Um `frontdoor.mjs` (Node puro) termina TLS em `0.0.0.0:443` e roteia por caminho: Supabase→gateway, `/avisos`→events (SSE), resto→app Next — tudo em `127.0.0.1` por trás. Cert via `mkcert` (CA da loja, SAN do IP). Tempo-real por polling leve (events consulta o banco a cada ~1.5s e empurra SSE). Cliente do browser usa `window.location.origin` no hub.

**Tech Stack:** Node built-ins (`http`/`https`/`net`/`child_process`), shell-out `psql`, mkcert.exe, Next.js, vitest. Hub é zero-dep npm.

**Spec:** `docs/superpowers/specs/2026-06-04-hub-rede-https-realtime-design.md`

---

## File Structure

- `hub/frontdoor.mjs` — **Create.** Porteiro: TLS + proxy por caminho. (Fase A: HTTP; B: HTTPS.)
- `hub/test/frontdoor.test.mjs` — **Create.** `pickFrontdoorTarget` + integração de proxy.
- `hub/events.mjs` — **Create.** SSE + poll do banco. (Fase C.)
- `hub/test/events.test.mjs` — **Create.** `diffEmpresas` + `fanout`.
- `hub/config.mjs` — **Modify.** `ports.frontdoor`, `ports.events`, `paths.certDir`.
- `hub/maestro.mjs` — **Modify.** Supervisiona frontdoor + events; `/status`; shutdown.
- `lib/supabase/client.ts` — **Modify.** Usa origin quando `__SUPABASE_USE_ORIGIN__`.
- `app/layout.tsx` — **Modify.** Injeta `__SUPABASE_USE_ORIGIN__` no hub.
- `lib/realtime/use-live-updates.ts` — **Create.** Hook hub=SSE / nuvem=channel. (Fase C.)
- `lib/realtime/__tests__/use-live-updates.test.ts` — **Create.**
- `components/pedidos-list.tsx`, `components/alertas/use-alertas-pedido.ts` — **Modify.** Usam o hook. (Fase C.)
- `hub/win/install-service.ps1` — **Modify.** Firewall 443; mkcert (CA+cert); copia rootCA.
- `.github/workflows/build-installer.yml` — **Modify.** Baixa `mkcert.exe`.
- `scripts/montar-payload.mjs` — **Modify.** Bundla `mkcert.exe`.

---

# FASE A — Hub na rede (frontdoor HTTP + cliente origin + firewall)

## Task A1: `pickFrontdoorTarget` (roteamento puro)

**Files:**
- Create: `hub/frontdoor.mjs` (só a função export nesta task)
- Test: `hub/test/frontdoor.test.mjs`

- [ ] **Step 1: Teste que falha** — `hub/test/frontdoor.test.mjs`:

```js
import { describe, it, expect } from 'vitest';
import { pickFrontdoorTarget } from '../frontdoor.mjs';

const P = { app: 3000, gateway: 54320, events: 54350 };

describe('pickFrontdoorTarget', () => {
  it('Supabase (/auth /rest /storage v1) -> gateway', () => {
    expect(pickFrontdoorTarget('/auth/v1/token', P).port).toBe(54320);
    expect(pickFrontdoorTarget('/rest/v1/pedidos?x=1', P).port).toBe(54320);
    expect(pickFrontdoorTarget('/storage/v1/object/foo', P).port).toBe(54320);
  });
  it('/avisos -> events', () => {
    expect(pickFrontdoorTarget('/avisos?empresa=1', P).port).toBe(54350);
    expect(pickFrontdoorTarget('/avisos', P).port).toBe(54350);
  });
  it('resto -> app', () => {
    expect(pickFrontdoorTarget('/login', P).port).toBe(3000);
    expect(pickFrontdoorTarget('/admin/usuarios', P).port).toBe(3000);
    expect(pickFrontdoorTarget('/authxyz', P).port).toBe(3000); // não casa /auth/v1
  });
});
```

- [ ] **Step 2: Rodar e falhar** — `npx vitest run hub/test/frontdoor.test.mjs` → FAIL (módulo).

- [ ] **Step 3: Implementar** — `hub/frontdoor.mjs` (só esta função por ora):

```js
import http from 'node:http';
import https from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/** Roteia por prefixo de caminho. Supabase->gateway; /avisos->events; resto->app. */
export function pickFrontdoorTarget(url, ports) {
  if (/^\/(auth|rest|storage)\/v1(\/|$|\?)/.test(url)) {
    return { host: '127.0.0.1', port: ports.gateway, name: 'gateway' };
  }
  if (url === '/avisos' || url.startsWith('/avisos/') || url.startsWith('/avisos?')) {
    return { host: '127.0.0.1', port: ports.events, name: 'events' };
  }
  return { host: '127.0.0.1', port: ports.app, name: 'app' };
}
```

- [ ] **Step 4: Passar** — `npx vitest run hub/test/frontdoor.test.mjs` → PASS (3).

- [ ] **Step 5: Commit** — `git add hub/frontdoor.mjs hub/test/frontdoor.test.mjs && git commit -m "feat(hub): frontdoor pickFrontdoorTarget (roteamento por caminho)"`

## Task A2: frontdoor server (proxy HTTP; TLS-ready)

**Files:**
- Modify: `hub/frontdoor.mjs`
- Test: `hub/test/frontdoor.test.mjs`

- [ ] **Step 1: Teste de integração que falha** — adicionar em `hub/test/frontdoor.test.mjs`:

```js
import http from 'node:http';
import { startFrontdoor } from '../frontdoor.mjs';

function upstream(label) {
  return http.createServer((req, res) => { res.writeHead(200); res.end(label + ':' + req.url); }).listen(0);
}
async function get(port, pathStr) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathStr }, (r) => {
      let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => resolve(b));
    }).on('error', reject);
  });
}

describe('startFrontdoor (proxy)', () => {
  it('roteia app/gateway por caminho', async () => {
    const app = upstream('APP'), gw = upstream('GW'), ev = upstream('EV');
    const ports = { app: app.address().port, gateway: gw.address().port, events: ev.address().port };
    const fd = startFrontdoor({ port: 0, ports, certDir: '' });
    await new Promise((r) => fd.on('listening', r));
    const port = fd.address().port;
    expect(await get(port, '/login')).toBe('APP:/login');
    expect(await get(port, '/rest/v1/pedidos')).toBe('GW:/rest/v1/pedidos');
    expect(await get(port, '/avisos?empresa=1')).toBe('EV:/avisos?empresa=1');
    fd.close(); app.close(); gw.close(); ev.close();
  });
});
```

- [ ] **Step 2: Rodar e falhar** — `npx vitest run hub/test/frontdoor.test.mjs` → FAIL (`startFrontdoor` indefinido).

- [ ] **Step 3: Implementar** — adicionar em `hub/frontdoor.mjs`:

```js
function makeHandler(ports) {
  return (req, res) => {
    const target = pickFrontdoorTarget(req.url || '/', ports);
    const proxyReq = http.request(
      {
        host: target.host, port: target.port, method: req.method, path: req.url,
        headers: { ...req.headers, host: `${target.host}:${target.port}` },
      },
      (proxyRes) => {
        // repassa status+headers crus; pipe (inclui SSE: stream aberto, sem buffer)
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );
    proxyReq.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `frontdoor: ${target.name} indisponivel: ${err.message}` }));
    });
    req.pipe(proxyReq);
  };
}

/** cert: lê server.key/server.crt do certDir. Ausente => null (roda HTTP, Fase A). */
function loadCert(certDir) {
  if (!certDir) return null;
  const key = path.join(certDir, 'server.key');
  const crt = path.join(certDir, 'server.crt');
  if (existsSync(key) && existsSync(crt)) return { key: readFileSync(key), cert: readFileSync(crt) };
  return null;
}

/** Sobe o porteiro em 0.0.0.0:port. HTTPS se há cert; senão HTTP. Retorna o server. */
export function startFrontdoor({ port, ports, certDir }) {
  const tls = loadCert(certDir);
  const h = makeHandler(ports);
  const server = tls ? https.createServer(tls, h) : http.createServer(h);
  server.listen(port, '0.0.0.0', () => {
    console.log(`[frontdoor] ${tls ? 'https' : 'http'} 0.0.0.0:${server.address().port} -> app:${ports.app} gw:${ports.gateway} events:${ports.events}`);
  });
  return server;
}

const isMain = (() => {
  try { return fileURLToPath(import.meta.url) === process.argv[1]; } catch { return false; }
})();
if (isMain) {
  startFrontdoor({
    port: Number(process.env.FRONTDOOR_PORT || 443),
    ports: {
      app: Number(process.env.APP_PORT || 3000),
      gateway: Number(process.env.GATEWAY_PORT || 54320),
      events: Number(process.env.EVENTS_PORT || 54350),
    },
    certDir: process.env.CERT_DIR || '',
  });
}
```

Adicionar no topo do arquivo o import faltante: `import { fileURLToPath } from 'node:url';`

- [ ] **Step 4: Passar** — `npx vitest run hub/test/frontdoor.test.mjs` → PASS (4).

- [ ] **Step 5: Commit** — `git add hub/frontdoor.mjs hub/test/frontdoor.test.mjs && git commit -m "feat(hub): frontdoor server (proxy por caminho; TLS-ready)"`

## Task A3: config — portas do frontdoor/events + certDir

**Files:**
- Modify: `hub/config.mjs` (bloco `DEFAULTS.ports` e `DEFAULTS.paths`)

- [ ] **Step 1: Editar DEFAULTS** — em `hub/config.mjs`, no `ports` adicionar `frontdoor: 443,` e `events: 54350,`; no `paths` adicionar `certDir: '/tmp/exped-cert',` (o instalador Windows sobrescreve pra `C:\Exped\cert`). Adicionar também o parsing de env (junto dos outros `if (process.env.EXPED_*_PORT)`):

```js
  if (process.env.EXPED_FRONTDOOR_PORT) ports.frontdoor = Number(process.env.EXPED_FRONTDOOR_PORT);
  if (process.env.EXPED_EVENTS_PORT) ports.events = Number(process.env.EXPED_EVENTS_PORT);
```

- [ ] **Step 2: Typecheck/lint** — `node -e "import('./hub/config.mjs').then(m=>console.log(m.loadConfig({jwtSecret:'x'.repeat(40)}).ports))"`
Expected: imprime ports incluindo `frontdoor: 443, events: 54350`.

- [ ] **Step 3: Commit** — `git add hub/config.mjs && git commit -m "feat(hub): portas frontdoor/events + certDir na config"`

## Task A4: maestro supervisiona o frontdoor

**Files:**
- Modify: `hub/maestro.mjs`

- [ ] **Step 1: Construtor do supervisor** — adicionar perto de `gatewaySupervisor` (em `hub/maestro.mjs`):

```js
function frontdoorSupervisor(cfg, logDir) {
  return new Supervisor({
    name: 'frontdoor',
    cmd: process.execPath,
    args: [path.join(ROOT, 'hub', 'frontdoor.mjs')],
    cwd: ROOT,
    env: {
      FRONTDOOR_PORT: String(cfg.ports.frontdoor),
      APP_PORT: String(cfg.ports.app),
      GATEWAY_PORT: String(cfg.ports.gateway),
      EVENTS_PORT: String(cfg.ports.events),
      CERT_DIR: cfg.paths.certDir || '',
    },
    logPath: path.join(logDir, 'frontdoor.log'),
    backoffMs: 1500,
  });
}
```

- [ ] **Step 2: Subir depois do app** — em `startMaestro`, logo após o bloco do app (`supervisors.app = ...`), adicionar:

```js
  // Porteiro de rede (LAN): única peça que escuta em 0.0.0.0. Sobe depois do app.
  logger.info(`subindo frontdoor :${cfg.ports.frontdoor}`);
  supervisors.frontdoor = frontdoorSupervisor(cfg, logDir).start();
```

- [ ] **Step 3: Smoke local** — rode o hub localmente se possível (ou confie na suíte). Run: `npx vitest run hub/` → tudo verde (nada quebrou). O frontdoor entra no `peers` do `/status` automaticamente (via `Object.values(supervisors).map(peerState)`).

- [ ] **Step 4: Commit** — `git add hub/maestro.mjs && git commit -m "feat(hub): maestro supervisiona o frontdoor"`

## Task A5: cliente usa a origem (browser) no hub

**Files:**
- Modify: `app/layout.tsx`, `lib/supabase/client.ts`

- [ ] **Step 1: layout injeta a flag no hub** — em `app/layout.tsx`, trocar o `<script>` por (mantendo o resto):

```tsx
  const isHubRuntime = process.env.EXPED_HUB === '1';
  const supabaseConfig = { url: supabaseUrl(), anonKey: supabaseAnonKey() };
```

e o script:

```tsx
        dangerouslySetInnerHTML={{
          __html:
            `window.__SUPABASE_ANON_KEY__=${JSON.stringify(supabaseConfig.anonKey)};` +
            (isHubRuntime
              ? `window.__SUPABASE_USE_ORIGIN__=true;`
              : `window.__SUPABASE_URL__=${JSON.stringify(supabaseConfig.url)};`),
        }}
```

- [ ] **Step 2: client resolve por origem** — em `lib/supabase/client.ts`, trocar a resolução de `url`:

```ts
  const win = typeof window !== 'undefined'
    ? (window as Window & { __SUPABASE_URL__?: string; __SUPABASE_USE_ORIGIN__?: boolean })
    : undefined;
  const url =
    (win?.__SUPABASE_USE_ORIGIN__ ? window.location.origin : win?.__SUPABASE_URL__) ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    '';
```

(o `key` permanece igual, lendo `__SUPABASE_ANON_KEY__`.)

- [ ] **Step 3: Typecheck + testes** — `npx tsc --noEmit && npx vitest run` → tudo verde.

- [ ] **Step 4: Commit** — `git add app/layout.tsx lib/supabase/client.ts && git commit -m "feat(hub): cliente do browser usa window.location.origin no hub (LAN)"`

## Task A6: firewall abre o frontdoor (443)

**Files:**
- Modify: `hub/win/install-service.ps1:173-174`

- [ ] **Step 1: Incluir 443 na regra** — trocar a regra de firewall para incluir a porta do frontdoor (e manter app/gateway p/ retrocompat local):

```powershell
netsh advfirewall firewall delete rule name="ExpedHub" | Out-Null
netsh advfirewall firewall add rule name="ExpedHub" dir=in action=allow protocol=TCP localport="443,$appPort,$gatewayPort" | Out-Null
```

- [ ] **Step 2: Commit** — `git add hub/win/install-service.ps1 && git commit -m "feat(hub): firewall abre 443 (frontdoor) na LAN"`

**✅ Validação Fase A (usuário, no servidor):** após instalar, abrir de OUTRA máquina `http://10.1.1.30` → tela de login do Exped. (HTTP ainda; HTTPS na Fase B.)

---

# FASE B — HTTPS (mkcert: CA da loja + cert do IP)

## Task B1: CI baixa o mkcert.exe

**Files:**
- Modify: `.github/workflows/build-installer.yml`, `scripts/montar-payload.mjs`

- [ ] **Step 1: Passo de download no workflow** — em `.github/workflows/build-installer.yml`, antes do `montar-payload`, adicionar um step:

```yaml
      - name: Baixar mkcert.exe
        run: |
          curl -L -o mkcert.exe https://github.com/FiloSottile/mkcert/releases/download/v1.4.4/mkcert-v1.4.4-windows-amd64.exe
```

e passar pro montar-payload via flag (Step 2 abaixo): `node scripts/montar-payload.mjs ... --mkcert mkcert.exe`.

- [ ] **Step 2: montar-payload bundla o binário** — em `scripts/montar-payload.mjs`, ler a flag `--mkcert` e copiar pra `bin/mkcert.exe` do payload (seguindo o padrão do `--auth`):

```js
  const mkcertArg = argFlag('--mkcert'); // helper já existente p/ flags (ver --auth)
  if (mkcertArg && existsSync(mkcertArg)) {
    mkdirSync(path.join(PAYLOAD, 'bin'), { recursive: true });
    cpSync(mkcertArg, path.join(PAYLOAD, 'bin', 'mkcert.exe'));
  }
```

(Conferir o helper real de parsing de flags no arquivo — `--auth` já é lido; reusar o mesmo mecanismo.)

- [ ] **Step 3: Commit** — `git add .github/workflows/build-installer.yml scripts/montar-payload.mjs && git commit -m "build(hub): bundla mkcert.exe no instalador"`

## Task B2: install gera CA + cert do IP

**Files:**
- Modify: `hub/win/install-service.ps1`

- [ ] **Step 1: Bloco mkcert no instalador** — adicionar (após o bloco de firewall), usando o IP do servidor (detectado ou parâmetro `$ServerIp`, default `10.1.1.30`):

```powershell
# --- HTTPS: CA local (mkcert) + cert do servidor (SAN com IP) ---
$Mkcert  = Join-Path $Root 'bin\mkcert.exe'
$CertDir = Join-Path $Root 'cert'
New-Item -ItemType Directory -Force -Path $CertDir | Out-Null
if (Test-Path $Mkcert) {
  & $Mkcert -install                                  # cria CA + confia no Windows do servidor
  & $Mkcert -cert-file (Join-Path $CertDir 'server.crt') `
            -key-file  (Join-Path $CertDir 'server.key') `
            $ServerIp localhost 127.0.0.1              # cert com SAN do IP
  $caRoot = (& $Mkcert -CAROOT).Trim()
  Copy-Item (Join-Path $caRoot 'rootCA.pem') (Join-Path $Root 'rootCA-Exped.crt') -Force
  Write-Host "    Cert pronto. Distribua $Root\rootCA-Exped.crt pras 5 maquinas."
} else {
  Write-Host "    AVISO: mkcert.exe ausente - hub sobe em HTTP (sem notificacao)."
}
```

- [ ] **Step 2: certDir no config do hub** — garantir que o `config.json` gerado/instalado aponte `paths.certDir` pra `C:\Exped\cert` (no `config.example.json` / no install). O frontdoor lê `CERT_DIR` (do maestro → cfg.paths.certDir): com `server.crt`/`server.key` presentes, sobe HTTPS automático.

- [ ] **Step 3: Commit** — `git add hub/win/install-service.ps1 hub/win/config.example.json && git commit -m "feat(hub): install gera CA+cert (mkcert) e habilita HTTPS no frontdoor"`

## Task B3: front-end e GoTrue cientes do https

**Files:**
- Modify: `hub/maestro.mjs` (env do gotrue/app: SITE_URL)

- [ ] **Step 1: SITE_URL coerente** — no `gotrueSupervisor`, tornar `GOTRUE_SITE_URL` configurável e, no hub com frontdoor, apontar pra a origem pública. Mais simples e robusto: deixar `GOTRUE_URI_ALLOW_LIST='*'` (aceita qualquer redirect) — o hub usa login por senha (sem magic link), então não há redirect externo; isto evita rejeição de redirect caso surja. Adicionar no env do gotrue:

```js
      GOTRUE_URI_ALLOW_LIST: '*',
```

- [ ] **Step 2: Testes** — `npx vitest run hub/` → verde.

- [ ] **Step 3: Commit** — `git add hub/maestro.mjs && git commit -m "feat(hub): gotrue allow-list aberta (login por senha no hub https/lan)"`

**✅ Validação Fase B (usuário):** reinstalar; instalar `rootCA-Exped.crt` numa máquina cliente (duplo-clique → Máquina Local → Autoridades Raiz Confiáveis, OU `Import-Certificate -FilePath C:\...\rootCA-Exped.crt -CertStoreLocation Cert:\LocalMachine\Root`); abrir `https://10.1.1.30` → cadeado, sem aviso; testar que a notificação de pedido novo dispara.

---

# FASE C — Tempo-real (events: poll → SSE + cliente)

## Task C1: `diffEmpresas` + `fanout` (núcleos puros)

**Files:**
- Create: `hub/events.mjs` (só as funções puras nesta task)
- Test: `hub/test/events.test.mjs`

- [ ] **Step 1: Teste que falha** — `hub/test/events.test.mjs`:

```js
import { describe, it, expect } from 'vitest';
import { diffEmpresas, fanout } from '../events.mjs';

describe('diffEmpresas', () => {
  it('retorna empresas cujo max(updated_at) avançou', () => {
    const prev = { E1: '2026-01-01T00:00:00Z', E2: '2026-01-01T00:00:00Z' };
    const atual = { E1: '2026-01-02T00:00:00Z', E2: '2026-01-01T00:00:00Z', E3: '2026-01-05T00:00:00Z' };
    expect(diffEmpresas(prev, atual).sort()).toEqual(['E1', 'E3']); // E1 avançou, E3 é nova
  });
  it('primeira leitura (prev vazio) NÃO dispara tudo', () => {
    expect(diffEmpresas({}, { E1: '2026-01-01T00:00:00Z' })).toEqual([]);
  });
});

describe('fanout', () => {
  it('entrega só aos clientes da empresa', () => {
    const escritos = [];
    const mk = (empresaId) => ({ empresaId, res: { write: (s) => escritos.push([empresaId, s]) } });
    const clients = [mk('E1'), mk('E2'), mk('E1')];
    const n = fanout(clients, 'E1');
    expect(n).toBe(2);
    expect(escritos.every(([e]) => e === 'E1')).toBe(true);
    expect(escritos[0][1]).toContain('event: changed');
  });
});
```

- [ ] **Step 2: Falhar** — `npx vitest run hub/test/events.test.mjs` → FAIL.

- [ ] **Step 3: Implementar** — `hub/events.mjs` (núcleos):

```js
/**
 * diffEmpresas(prev, atual): quais empresas tiveram max(updated_at) AVANÇADO.
 * Primeira leitura (prev sem a empresa) NÃO conta como mudança (evita disparo em massa
 * no boot — só notifica o que mudou DEPOIS que já conhecíamos o estado).
 */
export function diffEmpresas(prev, atual) {
  const mudou = [];
  for (const [emp, ts] of Object.entries(atual)) {
    if (prev[emp] === undefined) continue;       // empresa nova no snapshot: não dispara
    if (ts > prev[emp]) mudou.push(emp);
  }
  return mudou;
}

/** Entrega 'changed' (SSE) só aos clientes da empresa. Retorna quantos receberam. */
export function fanout(clients, empresaId) {
  let n = 0;
  for (const c of clients) {
    if (c.empresaId !== empresaId) continue;
    try { c.res.write(`event: changed\ndata: {"empresa":"${empresaId}"}\n\n`); n++; } catch { /* foi-se */ }
  }
  return n;
}
```

- [ ] **Step 4: Passar** — `npx vitest run hub/test/events.test.mjs` → PASS (4).

- [ ] **Step 5: Commit** — `git add hub/events.mjs hub/test/events.test.mjs && git commit -m "feat(hub): events diffEmpresas + fanout (nucleos do tempo-real)"`

## Task C2: events server (SSE + poll do banco)

**Files:**
- Modify: `hub/events.mjs`

- [ ] **Step 1: Implementar o servidor** — adicionar em `hub/events.mjs`:

```js
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const POLL_MS = Number(process.env.EVENTS_POLL_MS || 1500);

function psqlArgs(cfg) {
  return ['-p', String(cfg.pg), '-h', cfg.host, '-U', cfg.user, '-d', cfg.db, '-At', '-v', 'ON_ERROR_STOP=1'];
}

/** snapshot { empresa_id: max_updated_at } sobre pedidos + ordens_servico. */
async function snapshot(cfg) {
  const sql =
    "select empresa_id::text || '|' || to_char(max(u) at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') " +
    "from (select empresa_id, updated_at u from public.pedidos " +
    "union all select empresa_id, updated_at u from public.ordens_servico) t group by empresa_id";
  const { stdout } = await execFileAsync('psql', [...psqlArgs(cfg), '-c', sql],
    { env: { ...process.env, PGCLIENTENCODING: 'UTF8' }, maxBuffer: 1024 * 1024 * 64 });
  const snap = {};
  for (const line of stdout.split('\n')) {
    const [emp, ts] = line.split('|');
    if (emp && ts) snap[emp] = ts;
  }
  return snap;
}

export function startEvents(cfg) {
  const clients = new Set();
  let prev = {};
  let primed = false;

  const server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://x');
    if (!u.pathname.startsWith('/avisos')) { res.writeHead(404); res.end(); return; }
    const empresaId = u.searchParams.get('empresa') || '';
    res.writeHead(200, {
      'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive',
    });
    res.write(': ok\n\n'); // abre o stream
    const client = { empresaId, res };
    clients.add(client);
    req.on('close', () => clients.delete(client));
  });
  server.listen(cfg.port, '127.0.0.1', () => console.log(`[events] SSE 127.0.0.1:${cfg.port} (poll ${POLL_MS}ms)`));

  // heartbeat (mantém conexões vivas)
  const hb = setInterval(() => { for (const c of clients) { try { c.res.write(': hb\n\n'); } catch { clients.delete(c); } } }, 25000);
  hb.unref?.();

  // poll só quando há clientes
  const poll = setInterval(async () => {
    if (clients.size === 0) return;
    try {
      const atual = await snapshot(cfg.db ? cfg : cfg); // cfg já tem pg/host/user/db
      if (!primed) { prev = atual; primed = true; return; }
      for (const emp of diffEmpresas(prev, atual)) fanout([...clients], emp);
      prev = atual;
    } catch (e) { console.error(`[events] poll: ${e.message}`); }
  }, POLL_MS);
  poll.unref?.();

  return { server, stop: () => { clearInterval(hb); clearInterval(poll); server.close(); } };
}

const isMain = (() => { try { return fileURLToPath(import.meta.url) === process.argv[1]; } catch { return false; } })();
if (isMain) {
  startEvents({
    port: Number(process.env.EVENTS_PORT || 54350),
    pg: Number(process.env.EXPED_PG_PORT || 54329),
    host: process.env.EXPED_PG_HOST || '127.0.0.1',
    user: process.env.EXPED_PG_USER || 'postgres',
    db: process.env.EXPED_PG_DB || 'exped',
  });
}
```

(Nota: `snapshot(cfg)` espera `cfg` com `{pg, host, user, db}`. O `cfg` do `startEvents` carrega esses campos — passar o mesmo objeto. Simplificar a chamada para `snapshot(cfg)`.)

- [ ] **Step 2: Smoke** — `node -e "import('./hub/events.mjs')"` não deve lançar (imports ok). Run: `npx vitest run hub/test/events.test.mjs` → ainda PASS (núcleos).

- [ ] **Step 3: Commit** — `git add hub/events.mjs && git commit -m "feat(hub): events server SSE + poll do banco (~1.5s)"`

## Task C3: maestro sobe o events + frontdoor já roteia /avisos

**Files:**
- Modify: `hub/maestro.mjs`

- [ ] **Step 1: Supervisor do events** — adicionar:

```js
function eventsSupervisor(cfg, logDir) {
  return new Supervisor({
    name: 'events',
    cmd: process.execPath,
    args: [path.join(ROOT, 'hub', 'events.mjs')],
    cwd: ROOT,
    env: {
      EVENTS_PORT: String(cfg.ports.events),
      EXPED_PG_PORT: String(cfg.ports.pg),
      EXPED_PG_HOST: pgTcpHost(cfg),
      EXPED_PG_USER: cfg.paths.user || 'postgres',
      EXPED_PG_DB: cfg.paths.db,
    },
    logPath: path.join(logDir, 'events.log'),
    backoffMs: 1500,
  });
}
```

- [ ] **Step 2: Subir antes do frontdoor** — em `startMaestro`, ANTES do bloco do frontdoor (Task A4), adicionar:

```js
  logger.info(`subindo events :${cfg.ports.events}`);
  supervisors.events = eventsSupervisor(cfg, logDir).start();
```

- [ ] **Step 3: Testes** — `npx vitest run hub/` → verde. (frontdoor já roteia `/avisos`→events da Task A1/A2.)

- [ ] **Step 4: Commit** — `git add hub/maestro.mjs && git commit -m "feat(hub): maestro supervisiona o events (tempo-real)"`

## Task C4: cliente `useLiveUpdates` (hub=SSE / nuvem=channel)

**Files:**
- Create: `lib/realtime/use-live-updates.ts`
- Test: `lib/realtime/__tests__/use-live-updates.test.ts`

- [ ] **Step 1: Teste que falha** — `lib/realtime/__tests__/use-live-updates.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveLiveSource } from '../use-live-updates';

afterEach(() => vi.unstubAllGlobals());

describe('resolveLiveSource', () => {
  it('no hub → sse com a URL /avisos da origem', () => {
    vi.stubGlobal('window', { __SUPABASE_USE_ORIGIN__: true, location: { origin: 'https://10.1.1.30' } });
    expect(resolveLiveSource('E1')).toEqual({ kind: 'sse', url: 'https://10.1.1.30/avisos?empresa=E1' });
  });
  it('na nuvem → channel', () => {
    vi.stubGlobal('window', { location: { origin: 'https://app.vercel.app' } });
    expect(resolveLiveSource('E1')).toEqual({ kind: 'channel' });
  });
});
```

- [ ] **Step 2: Falhar** — `npx vitest run lib/realtime/__tests__/use-live-updates.test.ts` → FAIL.

- [ ] **Step 3: Implementar** — `lib/realtime/use-live-updates.ts`:

```ts
'use client';

import { useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';

type LiveSource = { kind: 'sse'; url: string } | { kind: 'channel' };

/** Decide a fonte de eventos: hub (origin) → SSE /avisos; nuvem → realtime channel. */
export function resolveLiveSource(empresaId: string): LiveSource {
  const w = typeof window !== 'undefined'
    ? (window as Window & { __SUPABASE_USE_ORIGIN__?: boolean })
    : undefined;
  if (w?.__SUPABASE_USE_ORIGIN__) {
    return { kind: 'sse', url: `${window.location.origin}/avisos?empresa=${empresaId}` };
  }
  return { kind: 'channel' };
}

/**
 * Assina mudanças de pedidos/OS e chama onChange (debounce do consumidor).
 * Hub: EventSource em /avisos. Nuvem: canal postgres_changes (pedidos+ordens_servico).
 */
export function useLiveUpdates(empresaId: string | null, onChange: () => void) {
  useEffect(() => {
    if (!empresaId) return;
    const src = resolveLiveSource(empresaId);
    if (src.kind === 'sse') {
      const es = new EventSource(src.url);
      es.addEventListener('changed', () => onChange());
      return () => es.close();
    }
    const supabase = createClient();
    const ch = supabase
      .channel(`live:${empresaId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pedidos', filter: `empresa_id=eq.${empresaId}` }, () => onChange())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ordens_servico', filter: `empresa_id=eq.${empresaId}` }, () => onChange())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [empresaId, onChange]);
}
```

- [ ] **Step 4: Passar** — `npx vitest run lib/realtime/__tests__/use-live-updates.test.ts` → PASS (2).

- [ ] **Step 5: Commit** — `git add lib/realtime/ && git commit -m "feat(realtime): useLiveUpdates (hub=SSE / nuvem=channel)"`

## Task C5: religar pedidos-list e alertas no useLiveUpdates

**Files:**
- Modify: `components/pedidos-list.tsx`, `components/alertas/use-alertas-pedido.ts`

- [ ] **Step 1: pedidos-list** — substituir o bloco de `supabase.channel(...postgres_changes...).subscribe()` por:

```tsx
  useLiveUpdates(empresaId, useCallback(() => setTick((t) => t + 1), []));
```

(importar `useLiveUpdates` de `@/lib/realtime/use-live-updates` e `useCallback` do react; remover o canal manual e o `createClient` se ficar sem uso. Manter o `setTick`/refetch existente.)

- [ ] **Step 2: use-alertas-pedido** — idem: trocar a assinatura de canal pelo `useLiveUpdates(empresaId, onNovo)` onde `onNovo` dispara a checagem de pedido novo existente (manter `guard if (!prefs.ativado || !empresaId) return` antes de assinar — passar `empresaId` só quando ativo).

- [ ] **Step 3: Typecheck + testes** — `npx tsc --noEmit && npx vitest run` → tudo verde.

- [ ] **Step 4: Commit** — `git add components/pedidos-list.tsx components/alertas/use-alertas-pedido.ts && git commit -m "feat(realtime): pedidos-list e alertas via useLiveUpdates (funciona no hub LAN)"`

## Task C6: montar-payload já leva events.mjs/frontdoor.mjs

**Files:**
- Verify: `scripts/montar-payload.mjs` (já copia `hub/*.mjs` como `tipo:'mjs'` — Task confirma)

- [ ] **Step 1: Conferir cópia** — o entry `{ de: 'hub', para: 'hub', tipo: 'mjs' }` copia TODOS os `.mjs` de `hub/` (incl. `frontdoor.mjs`, `events.mjs`). Confirmar com: `node -e "const {readdirSync}=require('fs'); console.log(readdirSync('hub').filter(f=>f.endsWith('.mjs')))"` → lista inclui frontdoor.mjs e events.mjs.

- [ ] **Step 2: (sem mudança se já cobre)** — se cobrir, nada a commitar nesta task.

**✅ Validação Fase C (usuário):** numa máquina, mexer num pedido (ou criar venda no Hiper); em OUTRA máquina, a fila atualiza sozinha em ~1.5s, sem recarregar.

---

## Verificação final + revisão adversarial

- [ ] `npx tsc --noEmit && npx vitest run` → tudo verde.
- [ ] `npx next build` → compila.
- [ ] Revisão adversarial (workflow) das peças de rede/TLS/SSE: vazamento de origem, SSE não-bufferizado pelo frontdoor, filtro de empresa no fanout, fail-closed do isHub, e o disparo-em-massa do diff no boot.
- [ ] Bump de versão + tag → instalador novo (leva também colaboradores read-only no hub + fix /status, já em main).

---

## Self-Review

**1. Spec coverage:** frontdoor (A1/A2/A4) ✓; cert mkcert (B1/B2) ✓; HTTPS auto no frontdoor (A2 loadCert + B2) ✓; cliente origin (A5) ✓; firewall (A6) ✓; events poll→SSE (C1/C2/C3) ✓; useLiveUpdates + religar consumidores (C4/C5) ✓; bundle dos .mjs (C6) ✓; SITE_URL/allow-list (B3) ✓; rollout (validações por fase) ✓. Migração pg_notify removida (decisão: polling) — coberto.

**2. Placeholder scan:** sem TBD. As notas ("conferir o helper de flags do montar-payload", "config.json aponta certDir") são verificações de API local concretas, não placeholders de lógica.

**3. Type/símbolo consistency:** `pickFrontdoorTarget(url,ports)`, `startFrontdoor({port,ports,certDir})`, `startEvents(cfg)`, `diffEmpresas(prev,atual)`, `fanout(clients,empresaId)`, `resolveLiveSource(empresaId)`, `useLiveUpdates(empresaId,onChange)`, `window.__SUPABASE_USE_ORIGIN__`, ports `frontdoor`/`events`, `paths.certDir` — consistentes entre tasks e com a spec.
