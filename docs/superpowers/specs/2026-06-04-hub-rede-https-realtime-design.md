# Hub na rede da loja (LAN) + HTTPS + tempo-real — Design

**Data:** 2026-06-04
**Status:** Aprovado pelo usuário (aguardando spec review → writing-plans)

## Objetivo

Permitir que as **5 máquinas da Franzoni** (setores diferentes) usem **um hub central
offline-first** pela rede da loja, em vez de cada uma depender da nuvem. Endereço único e
seguro: **`https://10.1.1.30`**. Três capacidades, num instalador só:

1. **Hub na rede** — as 5 máquinas acessam o hub central do servidor.
2. **HTTPS (certificado da loja)** — habilita a *notificação de pedido novo* nas máquinas
   (a Notification API exige contexto seguro: https ou localhost).
3. **Tempo-real** — a fila atualiza sozinha em todas as telas quando um pedido entra/muda.

## Contexto confirmado (medição no servidor, 2026-06-04)

- **Hiper é CENTRAL.** Prova: 5 máquinas remotas (`10.1.1.40/.44/.60/.126/.202`) conectadas
  no `MSSQL$HIPER` do servidor agora; SQL Server escutando em `0.0.0.0`; SQL Browser ligado.
  → O **agente único que já roda** no servidor captura as vendas de **todas** as máquinas.
  **Não precisa de agente por máquina.**
- **Servidor:** `10.1.1.30` (Ethernet). Rede `10.1.1.x`.
- **Hub hoje é localhost-only:** app Next em `127.0.0.1:3000` (`HOSTNAME:'127.0.0.1'` no
  `appSupervisor`), gateway Supabase em `127.0.0.1:54320` (`gateway.mjs` listen `127.0.0.1`).
  O browser recebe `window.__SUPABASE_URL__ = http://127.0.0.1:54320` (`app/layout.tsx`),
  que só resolve na máquina do servidor.
- **Hub é zero-dep npm:** componentes em Node puro (`http`, `https`, `net`, `child_process`)
  + shell-out pro `psql`/`pg_ctl`. Mantemos isso.

## Arquitetura: um "porteiro" HTTPS único (single-origin)

O HTTPS (necessário pra notificação) torna o **single-origin** a escolha natural: tudo atrás
de `https://10.1.1.30` evita CORS e *mixed-content*. As peças internas continuam em
`127.0.0.1` (NÃO expostas); só o **porteiro** fica na rede.

```
 5 máquinas (navegador) → https://10.1.1.30
            │
            ▼  (TLS, porta 443, bind 0.0.0.0)
 ┌──────────── SERVIDOR 10.1.1.30 ─────────────┐
 │  [frontdoor.mjs]  termina TLS + roteia:      │
 │    /auth/v1,/rest/v1,/storage/v1 → gateway   │ 127.0.0.1:54320
 │    /avisos (SSE)                 → events     │ 127.0.0.1:<events>
 │    /* (resto)                    → app Next   │ 127.0.0.1:3000
 │                                              │
 │  [events.mjs] poll DB (~1.5s) → SSE          │
 │  [agente] → lê Hiper central (já existe)     │
 └──────────────────────────────────────────────┘
```

## Componentes

### 1. Porteiro HTTPS — `hub/frontdoor.mjs` (NOVO)
- `https.createServer({ key, cert }, handler)` (Node built-in), bind **`0.0.0.0:443`**
  (fallback `8443` se 443 ocupada — configurável `cfg.ports.frontdoor`).
- Roteamento por prefixo de caminho (mesma ideia do `gateway.mjs`):
  - `/auth/v1*`, `/rest/v1*`, `/storage/v1*` → proxy p/ `127.0.0.1:${cfg.ports.gateway}`.
  - `/avisos*` → proxy p/ `127.0.0.1:${cfg.ports.events}` (SSE; precisa `flushHeaders` +
    sem buffering — repassar `text/event-stream` com `res` aberto).
  - resto → proxy p/ `127.0.0.1:${cfg.ports.app}` (o app Next).
- Carrega `key`/`cert` de `cfg.paths.certDir` (gerados no install — ver #2).
- Função pura testável `pickFrontdoorTarget(url)` (igual `pickTarget` do gateway).
- **Não muda** o bind do app/gateway/events (seguem `127.0.0.1`); só o porteiro é LAN-facing.

### 2. Certificado HTTPS — `mkcert.exe` empacotado
- O build do instalador (CI) baixa **`mkcert.exe`** (binário único, MIT) e o bundla em
  `C:\Exped\bin\` (igual `auth.exe`/`psql.exe`).
- No **install/bootstrap** do servidor (uma vez):
  - `mkcert -install` → cria a CA local e a confia no Windows do **servidor**.
  - `mkcert -cert-file <certDir>\server.crt -key-file <certDir>\server.key 10.1.1.30 localhost 127.0.0.1`
    → emite o cert do servidor com **SAN do IP** (browsers exigem SAN pra IP).
  - Copia o **CA root** (`mkcert -CAROOT` → `rootCA.pem`) pra um local fácil
    (`C:\Exped\rootCA-Exped.crt`) pra distribuir aos clientes.
- O IP entra no cert → o servidor precisa de **IP fixo** (`10.1.1.30`). Passo de rollout
  (estático ou reserva no DHCP). Se o IP mudar, reemitir o cert (script `regen-cert`).
- **Clientes (5 máquinas), uma vez cada:** instalar o `rootCA-Exped.crt` na *Autoridade de
  Certificação Raiz Confiável* (duplo-clique → "Instalar" → "Máquina Local" → "Confiáveis",
  ou `Import-Certificate -FilePath rootCA-Exped.crt -CertStoreLocation Cert:\LocalMachine\Root`).
  Depois: `https://10.1.1.30` abre **sem aviso** e como **contexto seguro** (notificação ✅).

### 3. Tempo-real — `hub/events.mjs` (NOVO), via POLLING leve (sem dep, sem migration)
- **Decisão (refinada no planejamento):** `psql LISTEN`/`NOTIFY` é frágil pelo stdin (psql só
  imprime notificações entre comandos; bloqueado lendo stdin, não as processa). Em vez disso,
  **polling leve** — robusto e sem dependência nova. Sem migration.
- **`hub/events.mjs`:** servidor SSE em `127.0.0.1:${cfg.ports.events}`. Enquanto há cliente
  conectado, a cada **~1.5s** faz UMA query (shell `psql`, igual o sync):
  `select empresa_id::text, max(greatest(updated_at,...)) from (pedidos UNION os) group by empresa_id`.
  Compara com o snapshot anterior por empresa; pra cada empresa que **avançou**, manda SSE
  `event: changed` pros clientes daquela empresa. (Zero clientes → não consulta.)
  - Endpoint: `GET /avisos?empresa=<uuid>` → `Content-Type: text/event-stream`, mantém aberto.
  - Heartbeat (comentário `:\n` a cada ~25s) pra manter a conexão viva por proxies.
  - Funções puras testáveis: `diffEmpresas(prev, atual)` (quais empresas mudaram) e
    `fanout(clientes, empresaId)` (entrega só aos clientes daquela empresa).
  - Latência ~1.5s (suficiente pra "fila não pisar"); carga trivial (1 query pequena/1.5s).
- **Cliente — `lib/realtime/use-live-updates.ts` (NOVO):** hook
  `useLiveUpdates(empresaId, onChange)` que:
  - **no hub** (isHub via window flag) → abre `EventSource('/avisos?empresa='+id)` e chama
    `onChange()` em cada `changed`.
  - **na nuvem** → mantém o `supabase.channel(postgres_changes)` atual.
  - `pedidos-list.tsx` e `use-alertas-pedido.ts` passam a usar `useLiveUpdates` (mesmo
    callback de refetch/tick que já existe). DRY: a lógica de "como ouvir" fica num lugar só.

### 4. Bind do cliente à origem — `lib/supabase/client.ts` + `app/layout.tsx`
- `layout.tsx`: quando `EXPED_HUB==='1'`, injeta `window.__SUPABASE_USE_ORIGIN__ = true`
  (em vez de URL fixa). Na nuvem, segue injetando a URL real.
- `client.ts`: se `__SUPABASE_USE_ORIGIN__`, usa `window.location.origin` como Supabase URL
  (ex.: `https://10.1.1.30`) → as chamadas batem no porteiro → gateway. Senão, comportamento
  atual. **Server-side (`server.ts`/`admin.ts`) não muda** (fala direto `127.0.0.1:gateway`).

### 5. maestro + config + firewall + instalador
- `hub/config.mjs`: novos `ports.frontdoor` (443) e `ports.events`; `paths.certDir`.
- `hub/maestro.mjs`: sobe `events.mjs` e `frontdoor.mjs` como peças supervisionadas (ordem:
  depois do app); `/status` inclui as duas; shutdown na ordem inversa. `appSupervisor` segue
  `127.0.0.1` (o porteiro é a face de rede).
- `hub/win/install-service.ps1`: regra de **firewall inbound TCP 443**; passos do `mkcert`
  (-install + emitir cert); copiar `rootCA` pra distribuição; (opcional) checar/instruir IP fixo.
- Instalador novo (bump + tag) leva tudo. Inclui também o que já está pendente em main
  (gestão de colaboradores read-only no hub, fix /status, EXPED_HUB).

## Segurança
- Só o **porteiro :443** fica exposto na LAN (rede confiável da loja). app/gateway/gotrue/
  postgrest/events/postgres seguem em `127.0.0.1`. service_role e jwtSecret nunca saem do
  servidor. Auth continua exigida (anon key + RLS).
- **NÃO expor à internet** — só LAN. (Sem port-forward no roteador.)
- O cert é da CA local da loja (mkcert) — confiada só nas máquinas onde o root for instalado.

## Limitações / decisões
- **IP fixo obrigatório** (`10.1.1.30`) — o cert tem o IP no SAN. Se mudar, reemitir (script).
  Decisão: usar IP (não hostname) — simples e sem DNS; o cert cobre `10.1.1.30` + `localhost`.
- **Tempo-real é "refetch sob evento"** (SSE dispara o refetch que já existe), não streaming de
  linhas. Suficiente pro caso (fila não pisar). Latência ~imediata (push via LISTEN/NOTIFY).
- **Realtime fallback:** se o `psql LISTEN` cair, `events.mjs` reconecta; clientes SSE
  reconectam sozinhos (EventSource faz retry nativo).
- **Áudio do aviso:** pode exigir 1ª interação do usuário na aba (política de autoplay) — fora
  de escopo resolver; o visual + a notificação (com HTTPS) cobrem o aviso.
- **Fora de escopo:** acesso pela internet; multi-loja; hostname/DNS; HA do servidor.

## Testes (vitest + Node, no Linux; Windows/rede testado pelo usuário)
- `pickFrontdoorTarget(url)` → roteia /auth,/rest,/storage→gateway, /avisos→events, resto→app.
- `frontdoor` integração: sobe app/gateway/events fakes em portas locais + um cert de teste,
  faz request HTTPS e valida o proxy (incl. SSE streaming não-bufferizado).
- `diffEmpresas(prev, atual)` → retorna as empresas cujo max(updated_at) avançou.
- `events.fanout(clientes, empresaId)` → entrega só pros clientes daquela empresa; heartbeat.
- `useLiveUpdates`: hub → cria EventSource no endpoint certo; nuvem → usa channel. (mock).
- Geração de cert: smoke local (mkcert no Linux do CI) valida SAN com IP.
- Migration: dry-run BEGIN/ROLLBACK; trigger dispara NOTIFY (teste manual no psql local).

## Rollout (passo a passo que entrego ao usuário)
1. Servidor: IP fixo `10.1.1.30`; instalar o ExpedSetup novo (gera CA + cert + firewall 443).
2. Cada máquina (1×): instalar `rootCA-Exped.crt` + atalho `https://10.1.1.30`.
3. Validar: abrir nas 5, logar, ver a fila; criar pedido no Hiper → aparece ao vivo nas telas;
   notificação dispara nas máquinas (não só no servidor).

## Plano em 3 fases (entrega num instalador só)
- **Fase A — Hub na rede:** frontdoor (HTTP first) + roteamento + bind 0.0.0.0 + firewall +
  cliente usa origem. Validável: 5 máquinas abrem `http://10.1.1.30`.
- **Fase B — HTTPS:** mkcert (CA+cert) + frontdoor termina TLS + distribuição do root +
  cliente em `https`. Validável: `https://10.1.1.30` sem aviso + notificação funciona.
- **Fase C — Tempo-real:** events.mjs (poll DB ~1.5s → SSE) + frontdoor /avisos + useLiveUpdates
  (cliente). Validável: mudança numa máquina aparece nas outras sem recarregar (~1.5s).
