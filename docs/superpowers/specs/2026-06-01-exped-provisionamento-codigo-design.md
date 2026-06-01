# Exped — Provisionamento por código de instalação (design)

**Data:** 2026-06-01
**Status:** Design aprovado (aguardando revisão da spec)
**Origem:** simplificar o onboarding híbrido — hoje exige 2 instaladores + editar 2 JSON na mão
(token colado 2x). Meta: cliente roda **1 instalador**, digita **1 código**, e tudo se configura.

---

## 1. Problema

O onboarding híbrido atual (ver `docs/onboarding-cliente.md`) tem 3 atritos:
1. Dois instaladores separados (hub + agente).
2. Editar `C:\Exped\config.json` (hub) e `appsettings.json` (agente) na mão — o **token de
   dispositivo é colado duas vezes**, em arquivos diferentes.
3. Para usuário não-técnico (oficina/loja), abrir Notepad e colar token em JSON é frágil.

Além disso, o de-para da `situacao` (gatilhos do agente) hoje vive **só no `appsettings.json`**,
e na automecânica só se descobre **depois** que o Hiper conecta — não dá pra fixar no install.

## 2. Meta

```
Operador (painel):  cria empresa → "Gerar código de instalação" → EXPED-7K4P-2QXM
Cliente:            baixa ExpedSetup.exe → digita o código → Avançar → Concluir → 1º login
```

Zero JSON editado, zero token colado, zero escolha técnica do lado do cliente.

## 3. Decisões tomadas (brainstorming)

| Tema | Decisão |
|------|---------|
| Perfil do código | **Curto, uso único, expira em 24h** (ex.: `EXPED-7K4P-2QXM`) |
| Config do agente (situacao/SyncOs) | **No painel, no banco, sincronizada** — agente lê do hub local e re-lê |
| Instalador | **Único** (`ExpedSetup.exe`): instala hub (serviço) + agente, ambos auto-configurados |
| Mecanismo | **Resgate gera o token** (token só nasce quando o código é resgatado) |
| URL da nuvem | **Embutida** no instalador (cliente não digita) |
| Multi-site | **1 código = 1 máquina** (cada máquina vira seu próprio dispositivo) |

Rejeitadas: (B) código apontando pra token pré-criado — exigiria guardar token cru recuperável;
(C) código autoassinado sem servidor — vira código gigante, sem uso-único nem revogação.

## 4. Arquitetura

```
PAINEL (operador)            NUVEM (Supabase + API Next)              MÁQUINA DO CLIENTE
  "Gerar código"  ──POST──>  cria provisioning_codes (hash,         ExpedSetup.exe
   mostra EXPED-…            empresa_id, expires_at)                   └─ wizard: "Cole o código"
                                                                          └─ POST /api/provision/redeem
  edita config do  ──────>  empresas.agente_* (colunas)  ──sync──>     <─ { deviceToken, cloudApiUrl, empresa }
   agente no painel                                                       └─ escreve config.json + appsettings.json
                                                                          └─ instala hub(serviço)+agente, inicia
                            /api/provision/redeem:                       agente ─lê config─> hub local /api/agent/config
                              valida + marca usado + cria
                              dispositivo + emite token
```

## 5. Componentes

### 5.1 Banco (nuvem) — migrations
- **`provisioning_codes`** (nova tabela):
  - `id uuid pk`, `empresa_id uuid fk`, `code_hash text unique` (sha256 do código, nunca o cru),
    `expires_at timestamptz`, `used_at timestamptz null`, `used_dispositivo_id uuid null`,
    `created_by uuid` (operador), `created_at timestamptz default now()`.
  - RLS: leitura/escrita só platform admin (igual `dispositivos`). O endpoint de resgate usa
    service_role e ignora RLS.
  - **NÃO** sincroniza pro local (é artefato de onboarding da nuvem) — fora de `SYNC_TABLES`.
- **`empresas`** ganha colunas de config do agente (two-way sync, já existente):
  - `agente_situacoes_venda text default '2,5,7'`, `agente_sync_os boolean default false`,
    `agente_situacoes_os text default ''`, `agente_poll_segundos int default 30`.
  - Estampadas pelo trigger de sync (entram em `field_updated_at`).

### 5.2 Geração do código — `lib/provisioning/code.ts`
- `gerarCodigoInstalacao(): { raw, hash }` — `raw` no formato `EXPED-XXXX-XXXX` (alfabeto sem
  ambíguos: sem `0/O/1/I/L`), `hash = sha256(raw normalizado upper, sem hifens)`.
- Server action `criarCodigoInstalacaoAction(empresaId)` (platform admin) → insere
  `provisioning_codes` com `expires_at = now()+24h`, devolve o `raw` 1x.

### 5.3 Endpoint público `/api/provision/redeem` (POST, `runtime nodejs`, verify_jwt off)
- Body: `{ code: string }`. Normaliza, calcula hash.
- Rate-limit por IP (janela curta) — defesa contra brute force do código curto.
- Transação/atomicidade (RPC `redeem_provisioning_code` SECURITY DEFINER):
  1. `select ... for update` o código pelo `code_hash`.
  2. Rejeita se inexistente / `used_at not null` / `expires_at < now()` → erro genérico `{error}`.
  3. Cria `dispositivos` (empresa_id, nome=ex. "Hub <empresa> <data>", token_hash, ativo).
  4. `update provisioning_codes set used_at=now(), used_dispositivo_id=…`.
  5. Retorna `device_id` (o token cru é gerado no Node, só o hash vai pro banco).
- Resposta 200: `{ deviceToken, cloudApiUrl, empresaId, empresaNome }`. Erros → genérico + log
  server-side com requestId (mesmo padrão de `/api/sync/pull`). NUNCA detalha o motivo ao cliente.

### 5.4 Config do agente lido do hub local — `/api/agent/config` (GET, auth device token)
- O agente chama o **hub local** (não a nuvem) → resolve `empresa_id` pelo device token →
  devolve `{ situacoesVenda, syncOs, situacoesOs, pollSegundos }` lidos da `empresas` local
  (que recebe os valores via sync). Offline-safe. O agente re-busca a cada ciclo (cache + ETag simples).
- Fallback: se o endpoint falhar, o agente usa o último valor conhecido (persistido) ou os defaults.

### 5.5 Painel (operador) — `plataforma-client.tsx`
- Na linha da empresa: botão **"Gerar código de instalação"** → modal mostra `EXPED-7K4P-2QXM`
  + validade + copiar. Aviso "vale 1 instalação, expira em 24h".
- Form de **config do agente** por empresa (situações de venda, liga OS, situações de OS, intervalo).

### 5.6 Instalador único `ExpedSetup.exe` (Inno Setup, admin)
- Unifica `hub/win/exped-hub.iss` + `agent/installer/ExpedAgent.iss` num só (.iss).
- Página de wizard custom (Pascal): campo **"Código de instalação"** (+ link "modo manual" escondido
  p/ suporte: colar token/URL direto).
- `[Run]` chama `provision.ps1`:
  1. POST `https://app-exped.vercel.app/api/provision/redeem` com o código (URL **embutida**).
  2. Recebe `{deviceToken, cloudApiUrl, …}`. Em erro → aborta com mensagem clara.
  3. Escreve `C:\Exped\config.json` (injeta `cloud.apiBase`, `cloud.deviceToken`; jwtSecret já
     gerado no install) e o `appsettings.json` do agente (`ApiBaseUrl=http://127.0.0.1:3000`,
     `DeviceToken`, `SqlConnectionString` default).
  4. Segue o fluxo já existente (download-binaries → install-service → inicia ExpedHub; instala agente).

## 6. Fluxo de dados (resgate)

1. Operador clica "gerar código" → `provisioning_codes` (sem token ainda).
2. Cliente digita o código no instalador → `provision.ps1` → POST `/redeem`.
3. Endpoint valida + marca usado + cria dispositivo + emite token → responde o pacote.
4. `provision.ps1` escreve os 2 configs → instala/inicia hub + agente.
5. 1º login online → cold start (hub puxa dados+senhas da nuvem) → operação normal.
6. Mudou a config do agente no painel → sincroniza pra `empresas` local → agente re-lê em `/api/agent/config`.

> **Ordenação importante:** o `dispositivo` nasce na **nuvem** no resgate, mas o agente
> autentica no **hub local**. O hub valida o device token contra a `dispositivos` LOCAL, que só
> tem a linha **após o 1º sync** (cold start traz `dispositivos`, que é tabela sincronizada). Logo,
> entre o install e o 1º sync, os POSTs do agente ao hub local podem dar 401 — o agente **re-tenta**
> a cada ciclo (poll 30s) e passa a autenticar assim que a linha desce. Sem perda (idempotência por
> `documento_erp`). O mesmo device token serve aos dois usos: hub→nuvem (sync) e agente→hub local.

## 7. Segurança

- Código: alfabeto sem ambíguos, **uso único**, **TTL 24h**, só o **hash** no banco, comparação por
  hash (não expõe timing do valor cru). Rate-limit por IP no `/redeem`.
- Token de dispositivo **só nasce no resgate** — código vazado pré-uso não vale token.
- `/redeem` e `/api/agent/config` seguem o padrão de erro genérico + requestId (sem vazar motivo).
- URL da nuvem embutida evita phishing de endpoint pelo cliente.
- "Modo manual" do instalador é caminho de suporte, não o padrão.
- Não muda nada das constraints já existentes (Hiper só-leitura; auth schema não exposto; etc.).

## 8. Tratamento de erro

| Situação | Comportamento |
|----------|---------------|
| Código inexistente/errado | `/redeem` 4xx genérico → instalador: "Código inválido. Gere um novo no painel." |
| Código expirado/já usado | idem (genérico) → mesma mensagem |
| Sem internet no install | `provision.ps1` falha no POST → "Sem conexão. O 1º install precisa de internet." |
| Falha ao escrever config | aborta install com log em `C:\Exped\logs\` |
| `/api/agent/config` indisponível | agente usa último valor conhecido / defaults (não trava ingestão) |

## 9. Escopo / Não-objetivos

**No escopo:** tabela `provisioning_codes` + RPC de resgate; colunas de config do agente na
`empresas` + form no painel; endpoint `/redeem` e `/api/agent/config`; geração/UI do código no
painel; instalador único com wizard + `provision.ps1`; o agente lendo config do hub local.

**Fora do escopo:** assinatura de código dos .exe (decisão do usuário: adiada); rotação automática
de token; expiração/rotação do device token; multi-master entre sites; reescrever o agente .NET
em Node (segue .NET self-contained).

## 10. Testes

- **Resgate:** válido (cria dispositivo + retorna token); expirado; já usado; inexistente; corrida
  (dois resgates simultâneos do mesmo código → só 1 vence, atomicidade via `for update`).
- **Rate-limit** por IP no `/redeem`.
- **Geração do código:** formato, alfabeto sem ambíguos, hash determinístico, normalização
  (case/hífen).
- **`/api/agent/config`:** auth por device token, escopo por empresa, valores corretos da `empresas`
  local, fallback quando indisponível.
- **`provision.ps1`** (no piloto Windows): escreve os 2 configs certos; aborta limpo em erro/sem-net.
- **Sync:** as colunas `agente_*` da `empresas` propagam nuvem→local.

## 11. Decomposição sugerida (para o plano)

1. **Banco + config do agente:** migration `provisioning_codes` + RPC `redeem`; colunas `agente_*`
   na `empresas` (+ sync allowlist).
2. **API:** `/api/provision/redeem` (público, rate-limit) e `/api/agent/config` (hub local).
3. **Painel:** geração/exibição do código + form de config do agente.
4. **Instalador único:** unificar os dois `.iss` + `provision.ps1` + wizard (validar no Windows).
5. **Agente .NET:** ler config de `/api/agent/config` (cache + fallback).

Cada item pode virar uma fatia do plano de implementação. Referências:
`docs/onboarding-cliente.md`, `hub/win/README.md`, `lib/crypto/token.ts`,
`lib/empresa/devices-actions.ts`, `memory/onboarding-hibrido-decisao.md`.
