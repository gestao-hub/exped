# Re-sync de NF/pagamento (pedido 2→5) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quando um pedido já ingerido ganha NF no Hiper (vira faturado), o agente re-sincroniza só a NF + pagamento, preenchendo o pedido existente no Exped sem tocar no que a equipe editou.

**Architecture:** Servidor ganha uma função "preenche-só-vazio" + um endpoint `POST /api/ingest/pedido/nf`. O agente mantém uma lista local de pedidos sem NF (em `state.json`), re-checa a cada poll e, quando a NF aparece, chama o endpoint e tira o pedido da lista (com TTL de 7 dias).

**Tech Stack:** Next.js 16 (route handler, runtime nodejs), Supabase admin (service_role), Zod, Vitest (env node). Agente: .NET (C#), `HttpClient`, `System.Text.Json`.

**Spec:** [docs/superpowers/specs/2026-06-02-resync-nf-pedido-design.md](../specs/2026-06-02-resync-nf-pedido-design.md)

> ⚠️ **Ambiente sem `dotnet`:** as tasks 3–5 (C#) NÃO compilam neste ambiente. Verificação delas = revisão de código contra este plano (o código está completo aqui). O `dotnet build` real acontece no recompile do instalador. As tasks 1–2 (TypeScript) rodam com `npm run test`/`typecheck` normalmente.

---

## File Structure

| Arquivo | Responsabilidade |
|---|---|
| `lib/pedidos/atualizar-nf.ts` | Função `atualizarNfPedido` — preenche só campos NULL de NF/pagamento no pedido existente. |
| `lib/pedidos/__tests__/atualizar-nf.test.ts` | Testes da função (vitest). |
| `lib/validators/ingest.ts` | + `ingestNfSchema` (modificar). |
| `app/api/ingest/pedido/nf/route.ts` | Endpoint POST: auth por token de dispositivo → chama `atualizarNfPedido`. |
| `app/api/ingest/pedido/nf/__tests__/route.test.ts` | Teste do endpoint (auth + happy path). |
| `agent/ExpedAgent/StateStore.cs` | + tipo `NfPendente` e lista com add/remove/prune (modificar). |
| `agent/ExpedAgent/Models.cs` | + `IngestNfPayload` (modificar). |
| `agent/ExpedAgent/IngestClient.cs` | + enum `NfSyncResult` e `EnviarNfAsync` (modificar). |
| `agent/ExpedAgent/Worker.cs` | + adiciona à lista ao ingerir sem NF; + `TickNfPendentesAsync`; chama no loop (modificar). |

---

## Task 1: Função `atualizarNfPedido` (servidor)

**Files:**
- Create: `lib/pedidos/atualizar-nf.ts`
- Test: `lib/pedidos/__tests__/atualizar-nf.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/pedidos/__tests__/atualizar-nf.test.ts
import { describe, it, expect } from 'vitest';
import { atualizarNfPedido } from '../atualizar-nf';

type Row = Record<string, unknown> | null;

function mockSupabase(existing: Row) {
  const updates: Record<string, unknown>[] = [];
  const filters: [string, string, unknown][] = [];
  const builder = {
    select() { return builder; },
    eq(col: string, val: unknown) { filters.push(['eq', col, val]); return builder; },
    neq(col: string, val: unknown) { filters.push(['neq', col, val]); return builder; },
    async maybeSingle() { return { data: existing }; },
    update(patch: Record<string, unknown>) {
      updates.push(patch);
      return { eq: async () => ({ error: null }) };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: { from: () => builder } as any, updates, filters };
}

const nf = { nf_numero: '616', nf_chave: 'CHV', nf_emitida_em: '2026-06-02 17:23:53', nf_valor: 148 };
const pg = { forma_pagamento: 'pix' as never, parcelas: 1 };

describe('atualizarNfPedido', () => {
  it('preenche NF e pagamento quando os campos estão nulos', async () => {
    const { client, updates } = mockSupabase({
      id: 'P1', nf_numero: null, nf_chave: null, nf_emitida_em: null, nf_valor: null,
      forma_pagamento: null, parcelas: null,
    });
    const r = await atualizarNfPedido(client, { empresaId: 'E1', documentoErp: 'DOC1', nf, pagamento: pg });
    expect(r).toEqual({ updated: true, id: 'P1' });
    expect(updates[0]).toEqual({
      nf_numero: '616', nf_chave: 'CHV', nf_emitida_em: '2026-06-02 17:23:53', nf_valor: 148,
      forma_pagamento: 'pix', parcelas: 1,
    });
  });

  it('NÃO sobrescreve campos já preenchidos', async () => {
    const { client, updates } = mockSupabase({
      id: 'P1', nf_numero: '999', nf_chave: 'JA', nf_emitida_em: '2026-01-01 00:00:00', nf_valor: 10,
      forma_pagamento: 'dinheiro', parcelas: 3,
    });
    const r = await atualizarNfPedido(client, { empresaId: 'E1', documentoErp: 'DOC1', nf, pagamento: pg });
    expect(r).toEqual({ nochange: true, id: 'P1' });
    expect(updates).toHaveLength(0);
  });

  it('preenche só o que falta (NF nula, pagamento já setado)', async () => {
    const { client, updates } = mockSupabase({
      id: 'P1', nf_numero: null, nf_chave: null, nf_emitida_em: null, nf_valor: null,
      forma_pagamento: 'dinheiro', parcelas: 2,
    });
    const r = await atualizarNfPedido(client, { empresaId: 'E1', documentoErp: 'DOC1', nf, pagamento: pg });
    expect(r).toEqual({ updated: true, id: 'P1' });
    expect(updates[0]).toEqual({
      nf_numero: '616', nf_chave: 'CHV', nf_emitida_em: '2026-06-02 17:23:53', nf_valor: 148,
    });
    expect(updates[0]).not.toHaveProperty('forma_pagamento');
  });

  it('escopa por empresa e ignora cancelado (filtros aplicados)', async () => {
    const { client, filters } = mockSupabase(null);
    await atualizarNfPedido(client, { empresaId: 'E9', documentoErp: 'DOCX', nf, pagamento: pg });
    expect(filters).toContainEqual(['eq', 'documento_erp', 'DOCX']);
    expect(filters).toContainEqual(['eq', 'empresa_id', 'E9']);
    expect(filters).toContainEqual(['neq', 'status', 'cancelado']);
  });

  it('pedido inexistente → notfound', async () => {
    const { client, updates } = mockSupabase(null);
    const r = await atualizarNfPedido(client, { empresaId: 'E1', documentoErp: 'DOC1', nf, pagamento: pg });
    expect(r).toEqual({ notfound: true });
    expect(updates).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- lib/pedidos/__tests__/atualizar-nf.test.ts`
Expected: FAIL — "Cannot find module '../atualizar-nf'".

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/pedidos/atualizar-nf.ts
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/types/database';

export interface NfFields {
  nf_numero?: string | null;
  nf_chave?: string | null;
  nf_emitida_em?: string | null;
  nf_valor?: number | null;
}

export interface PagamentoFields {
  forma_pagamento?: Database['public']['Enums']['forma_pagamento_tipo'] | null;
  parcelas?: number | null;
}

export type AtualizarNfResult =
  | { updated: true; id: string }
  | { nochange: true; id: string }
  | { notfound: true };

/**
 * Preenche SÓ os campos atualmente nulos de NF/pagamento no pedido existente
 * (achado por documento_erp + empresa, status != cancelado). Nunca toca em
 * status/itens/pontos/cliente — não atropela edição da equipe. Idempotente.
 */
export async function atualizarNfPedido(
  supabase: SupabaseClient<Database>,
  opts: { empresaId: string; documentoErp: string; nf: NfFields; pagamento: PagamentoFields },
): Promise<AtualizarNfResult> {
  const { data: existing } = await supabase
    .from('pedidos')
    .select('id, nf_numero, nf_chave, nf_emitida_em, nf_valor, forma_pagamento, parcelas')
    .eq('documento_erp', opts.documentoErp)
    .eq('empresa_id', opts.empresaId)
    .neq('status', 'cancelado')
    .maybeSingle();

  if (!existing) return { notfound: true };

  const e = existing as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  if (e.nf_numero == null && opts.nf.nf_numero != null) patch.nf_numero = opts.nf.nf_numero;
  if (e.nf_chave == null && opts.nf.nf_chave != null) patch.nf_chave = opts.nf.nf_chave;
  if (e.nf_emitida_em == null && opts.nf.nf_emitida_em != null) patch.nf_emitida_em = opts.nf.nf_emitida_em;
  if (e.nf_valor == null && opts.nf.nf_valor != null) patch.nf_valor = opts.nf.nf_valor;
  if (e.forma_pagamento == null && opts.pagamento.forma_pagamento != null)
    patch.forma_pagamento = opts.pagamento.forma_pagamento;
  if (e.parcelas == null && opts.pagamento.parcelas != null) patch.parcelas = opts.pagamento.parcelas;

  const id = e.id as string;
  if (Object.keys(patch).length === 0) return { nochange: true, id };

  const { error } = await supabase.from('pedidos').update(patch).eq('id', id);
  if (error) throw new Error(error.message);
  return { updated: true, id };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- lib/pedidos/__tests__/atualizar-nf.test.ts`
Expected: PASS (5 testes).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add lib/pedidos/atualizar-nf.ts lib/pedidos/__tests__/atualizar-nf.test.ts
git commit -m "feat(resync-nf): funcao atualizarNfPedido (preenche so campos vazios)"
```

---

## Task 2: Schema + endpoint `/api/ingest/pedido/nf` (servidor)

**Files:**
- Modify: `lib/validators/ingest.ts` (adicionar `ingestNfSchema` ao final)
- Create: `app/api/ingest/pedido/nf/route.ts`
- Test: `app/api/ingest/pedido/nf/__tests__/route.test.ts`

- [ ] **Step 1: Add the schema**

No final de `lib/validators/ingest.ts`, adicionar:

```ts
/**
 * Payload do re-sync de NF/pagamento (endpoint /api/ingest/pedido/nf).
 * documento_erp identifica o pedido já existente; o resto preenche só o que falta.
 */
export const ingestNfSchema = z.object({
  documento_erp: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[A-Za-z0-9._-]+$/, 'documento_erp com caracteres inválidos'),
  nf_numero: z.string().max(80).nullable().optional(),
  nf_chave: z.string().max(80).nullable().optional(),
  nf_emitida_em: z.string().max(80).nullable().optional(),
  nf_valor: z.number().nonnegative().nullable().optional(),
  forma_pagamento: z.string().max(1000).nullable().optional(),
  parcelas: z.string().max(80).nullable().optional(),
});

export type IngestNfInput = z.infer<typeof ingestNfSchema>;
```

- [ ] **Step 2: Write the failing route test**

```ts
// app/api/ingest/pedido/nf/__tests__/route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

let deviceRow: { id: string; empresa_id: string; ativo: boolean } | null = null;

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        async maybeSingle() { return { data: deviceRow }; },
        update() { return { eq: async () => ({ data: null }) }; },
      };
    },
  }),
}));

const atualizarNfPedido = vi.fn();
vi.mock('@/lib/pedidos/atualizar-nf', () => ({
  atualizarNfPedido: (...args: unknown[]) => atualizarNfPedido(...args),
}));

import { POST } from '../route';

function req(body: unknown, token?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request('http://127.0.0.1:3000/api/ingest/pedido/nf', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  deviceRow = { id: 'D1', empresa_id: 'E1', ativo: true };
  atualizarNfPedido.mockReset();
});

describe('POST /api/ingest/pedido/nf', () => {
  it('sem token → 401', async () => {
    const res = await POST(req({ documento_erp: 'DOC1' }) as never);
    expect(res.status).toBe(401);
  });

  it('documento_erp ausente → 422', async () => {
    const res = await POST(req({ nf_numero: '1' }, 'tok') as never);
    expect(res.status).toBe(422);
  });

  it('happy path → 200 e chama atualizarNfPedido com a empresa do device', async () => {
    atualizarNfPedido.mockResolvedValue({ updated: true, id: 'P1' });
    const res = await POST(req({ documento_erp: 'DOC1', nf_numero: '616', forma_pagamento: 'Pix' }, 'tok') as never);
    expect(res.status).toBe(200);
    expect(atualizarNfPedido).toHaveBeenCalledOnce();
    const arg = atualizarNfPedido.mock.calls[0][1];
    expect(arg.empresaId).toBe('E1');
    expect(arg.documentoErp).toBe('DOC1');
  });

  it('pedido inexistente → 404', async () => {
    atualizarNfPedido.mockResolvedValue({ notfound: true });
    const res = await POST(req({ documento_erp: 'DOCX', nf_numero: '1' }, 'tok') as never);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test -- app/api/ingest/pedido/nf/__tests__/route.test.ts`
Expected: FAIL — "Cannot find module '../route'".

- [ ] **Step 4: Write the route**

```ts
// app/api/ingest/pedido/nf/route.ts
import { NextResponse, type NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { ingestNfSchema } from '@/lib/validators/ingest';
import { mapFormaPagamento, parseParcelas } from '@/lib/parser/forma-pagamento';
import { atualizarNfPedido } from '@/lib/pedidos/atualizar-nf';

export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * Re-sync de NF/pagamento de um pedido já ingerido (vindo do agente quando o
 * pedido vira faturado no Hiper). Preenche só campos vazios; não atropela edição.
 */
export async function POST(req: NextRequest) {
  const supabase = createAdminClient();

  const auth = req.headers.get('authorization') ?? '';
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (!token) return NextResponse.json({ error: 'Token ausente' }, { status: 401 });
  const tokenHash = createHash('sha256').update(token).digest('hex');

  const { data: dispositivo } = await supabase
    .from('dispositivos')
    .select('id, empresa_id, ativo')
    .eq('token_hash', tokenHash)
    .maybeSingle();
  if (!dispositivo || !dispositivo.ativo) {
    return NextResponse.json({ error: 'Dispositivo inválido ou inativo' }, { status: 401 });
  }
  const empresaId = dispositivo.empresa_id as string;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }
  const parsed = ingestNfSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'dados inválidos' },
      { status: 422 },
    );
  }
  const d = parsed.data;

  const r = await atualizarNfPedido(supabase, {
    empresaId,
    documentoErp: d.documento_erp,
    nf: {
      nf_numero: d.nf_numero ?? null,
      nf_chave: d.nf_chave ?? null,
      nf_emitida_em: d.nf_emitida_em ?? null,
      nf_valor: d.nf_valor ?? null,
    },
    pagamento: {
      forma_pagamento: mapFormaPagamento(d.forma_pagamento ?? null),
      parcelas: parseParcelas(d.parcelas ?? null),
    },
  });

  if ('notfound' in r) return NextResponse.json({ notfound: true }, { status: 404 });
  return NextResponse.json(r, { status: 200 });
}
```

- [ ] **Step 5: Run test + typecheck + commit**

Run: `npm run test -- app/api/ingest/pedido/nf/__tests__/route.test.ts` (PASS, 4 testes)
Run: `npm run typecheck` (exit 0)

```bash
git add lib/validators/ingest.ts app/api/ingest/pedido/nf/route.ts app/api/ingest/pedido/nf/__tests__/route.test.ts
git commit -m "feat(resync-nf): endpoint POST /api/ingest/pedido/nf"
```

---

## Task 3: StateStore — lista de pendentes (agente, C#)

> Sem `dotnet` no ambiente: verificação = revisão de código. O código abaixo é completo.

**Files:**
- Modify: `agent/ExpedAgent/StateStore.cs`

- [ ] **Step 1: Replace the file content**

Substituir TODO o conteúdo de `agent/ExpedAgent/StateStore.cs` por:

```csharp
using System.Text.Json;
namespace ExpedAgent;

/// <summary>Pedido ingerido sem NF, aguardando faturamento pra re-sincronizar a NF.</summary>
public sealed class NfPendente
{
    public int IdPedidoVenda { get; set; }
    public string DocumentoErp { get; set; } = "";
    public DateTime AddedAtUtc { get; set; }
}

public sealed class StateStore
{
    private readonly string _path;
    public StateStore()
    {
        var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "ExpedAgent");
        Directory.CreateDirectory(dir);
        _path = Path.Combine(dir, "state.json");
    }
    private sealed class State
    {
        public int Hwm { get; set; }
        public int OsHwm { get; set; }
        public List<NfPendente> NfPendentes { get; set; } = new();
    }

    private State Load()
    {
        try { return File.Exists(_path) ? (JsonSerializer.Deserialize<State>(File.ReadAllText(_path)) ?? new State()) : new State(); }
        catch { return new State(); }
    }
    private void Save(State s) => File.WriteAllText(_path, JsonSerializer.Serialize(s));

    public int GetHwm() => Load().Hwm;
    public void SetHwm(int hwm) { var s = Load(); s.Hwm = hwm; Save(s); }

    public int GetOsHwm() => Load().OsHwm;
    public void SetOsHwm(int hwm) { var s = Load(); s.OsHwm = hwm; Save(s); }

    public List<NfPendente> GetNfPendentes() => Load().NfPendentes;

    /// <summary>Adiciona um pedido à lista de "aguardando NF" (no-op se o id já está lá).</summary>
    public void AddNfPendente(int idPedidoVenda, string documentoErp, DateTime nowUtc)
    {
        var s = Load();
        if (s.NfPendentes.Exists(p => p.IdPedidoVenda == idPedidoVenda)) return;
        s.NfPendentes.Add(new NfPendente { IdPedidoVenda = idPedidoVenda, DocumentoErp = documentoErp, AddedAtUtc = nowUtc });
        Save(s);
    }

    public void RemoveNfPendente(int idPedidoVenda)
    {
        var s = Load();
        if (s.NfPendentes.RemoveAll(p => p.IdPedidoVenda == idPedidoVenda) > 0) Save(s);
    }

    /// <summary>Remove pendentes mais antigos que ttlDias (pedido que nunca faturou).</summary>
    public void PruneNfPendentes(DateTime nowUtc, int ttlDias)
    {
        var s = Load();
        if (s.NfPendentes.RemoveAll(p => (nowUtc - p.AddedAtUtc).TotalDays > ttlDias) > 0) Save(s);
    }
}
```

- [ ] **Step 2: Code review (sem dotnet) + commit**

Conferir: `NfPendente` serializa junto no `state.json`; `AddNfPendente` é idempotente por id; `RemoveAll` só salva se mudou. Não há outras referências a `StateStore` que quebrem (os métodos antigos foram mantidos com a mesma assinatura).

```bash
git add agent/ExpedAgent/StateStore.cs
git commit -m "feat(agent): StateStore guarda lista de pedidos aguardando NF"
```

---

## Task 4: IngestClient.EnviarNfAsync + payload (agente, C#)

**Files:**
- Modify: `agent/ExpedAgent/Models.cs` (adicionar `IngestNfPayload` ao final)
- Modify: `agent/ExpedAgent/IngestClient.cs` (adicionar enum + método)

- [ ] **Step 1: Add the payload model**

No final de `agent/ExpedAgent/Models.cs`, adicionar:

```csharp
public sealed class IngestNfPayload
{
    [JsonPropertyName("documento_erp")] public string DocumentoErp { get; set; } = "";
    [JsonPropertyName("nf_numero")] public string? NfNumero { get; set; }
    [JsonPropertyName("nf_chave")] public string? NfChave { get; set; }
    [JsonPropertyName("nf_emitida_em")] public string? NfEmitidaEm { get; set; }
    [JsonPropertyName("nf_valor")] public decimal? NfValor { get; set; }
    [JsonPropertyName("forma_pagamento")] public string? FormaPagamento { get; set; }
    [JsonPropertyName("parcelas")] public string? Parcelas { get; set; }
}
```

- [ ] **Step 2: Add the enum + method to IngestClient**

Em `agent/ExpedAgent/IngestClient.cs`:

(a) Adicionar o enum logo após o enum `IngestResult` existente (linha 7):

```csharp
public enum NfSyncResult { Ok, NotFound, Error }
```

(b) Adicionar o método dentro da classe `IngestClient` (ex.: logo após `EnviarAsync`). Usa `System.Text.Encoding` (já tem `using System.Net.Http.Headers;`/`System.Text.Json;` no topo; `System.Net` também):

```csharp
    /// <summary>
    /// Re-sync de NF/pagamento de um pedido já ingerido. POST JSON em /api/ingest/pedido/nf.
    /// 200 → Ok (preencheu ou nada a fazer); 404 → NotFound (pedido sumiu/cancelado);
    /// outros → Error (tenta no próximo poll).
    /// </summary>
    public async Task<NfSyncResult> EnviarNfAsync(
        string documentoErp,
        (string? Numero, string? Chave, DateTime? Emitida, decimal? Valor) nf,
        (string? Forma, string? Parcelas)? pg,
        CancellationToken ct)
    {
        var payload = new IngestNfPayload
        {
            DocumentoErp = documentoErp,
            NfNumero = nf.Numero,
            NfChave = nf.Chave,
            NfEmitidaEm = nf.Emitida?.ToString("yyyy-MM-dd HH:mm:ss"),
            NfValor = nf.Valor,
            FormaPagamento = pg?.Forma,
            Parcelas = pg?.Parcelas,
        };
        var json = JsonSerializer.Serialize(payload);
        using var req = new HttpRequestMessage(HttpMethod.Post, $"{cfg.ApiBaseUrl}/api/ingest/pedido/nf")
        {
            Content = new StringContent(json, System.Text.Encoding.UTF8, "application/json"),
        };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", cfg.DeviceToken);
        try
        {
            using var res = await http.SendAsync(req, ct);
            return res.StatusCode switch
            {
                HttpStatusCode.OK => NfSyncResult.Ok,
                HttpStatusCode.NotFound => NfSyncResult.NotFound,
                _ => Log(NfSyncResult.Error, $"NF {(int)res.StatusCode}"),
            };
        }
        catch (Exception ex) { return Log(NfSyncResult.Error, ex.Message); }
    }
```

> Nota: existe um helper `Log(IngestResult, string)` na classe. Como `NfSyncResult` é outro tipo,
> adicionar um overload genérico OU um helper irmão. Forma simples — adicionar este overload
> privado perto do `Log` existente:
>
> ```csharp
>     private NfSyncResult Log(NfSyncResult r, string msg) { log.LogWarning("Ingest NF: {Msg}", msg); return r; }
> ```

- [ ] **Step 3: Code review (sem dotnet) + commit**

Conferir: tipos das tuplas batem com `repo.NfDoPedidoAsync` (`(string? Numero, string? Chave, DateTime? Emitida, decimal? Valor)?`) e `repo.PagamentoDoPedidoAsync` (`(string? Forma, string? Parcelas)?`); `NfEmitidaEm` formatada igual ao `PayloadBuilder` (`"yyyy-MM-dd HH:mm:ss"`); o overload de `Log` não conflita com o existente (tipos de retorno diferentes).

```bash
git add agent/ExpedAgent/Models.cs agent/ExpedAgent/IngestClient.cs
git commit -m "feat(agent): IngestClient.EnviarNfAsync (re-sync de NF/pagamento)"
```

---

## Task 5: Worker — alimentar a lista e re-checar (agente, C#)

**Files:**
- Modify: `agent/ExpedAgent/Worker.cs`

- [ ] **Step 1: Adicionar à lista ao ingerir sem NF**

Em `TickAsync`, no bloco de sucesso (hoje linhas ~142-146), trocar:

```csharp
            if (r is IngestResult.Created or IngestResult.Duplicate)
            {
                log.LogInformation("Pedido {Cod} sincronizado ({R}{Pdf}).", h.Codigo, r, pdfExiste ? ", com PDF" : ", sem PDF");
                maxOk = h.IdPedidoVenda;
            }
```

por:

```csharp
            if (r is IngestResult.Created or IngestResult.Duplicate)
            {
                log.LogInformation("Pedido {Cod} sincronizado ({R}{Pdf}).", h.Codigo, r, pdfExiste ? ", com PDF" : ", sem PDF");
                maxOk = h.IdPedidoVenda;
                // Ingerido sem NF → observa pra re-sincronizar quando faturar (2→5).
                if (string.IsNullOrWhiteSpace(h.NfNumero))
                    state.AddNfPendente(h.IdPedidoVenda, h.Codigo, DateTime.UtcNow);
            }
```

- [ ] **Step 2: Adicionar o método `TickNfPendentesAsync`**

Adicionar este método na classe `Worker` (ex.: logo após `TickAsync`):

```csharp
    /// <summary>
    /// Re-sync de NF: pra cada pedido na lista "aguardando NF", checa se já faturou
    /// no Hiper; se sim, manda só a NF+pagamento pro Exped e tira da lista. TTL 7 dias.
    /// Best-effort — nunca quebra o sync principal.
    /// </summary>
    private async Task TickNfPendentesAsync(CancellationToken ct)
    {
        state.PruneNfPendentes(DateTime.UtcNow, 7);
        foreach (var p in state.GetNfPendentes())
        {
            if (ct.IsCancellationRequested) break;
            var nf = await repo.NfDoPedidoAsync(p.IdPedidoVenda, ct);
            if (nf is not { } n) continue; // ainda sem NF — tenta no próximo poll

            (string? Forma, string? Parcelas)? pg = null;
            try { pg = await repo.PagamentoDoPedidoAsync(p.IdPedidoVenda, ct); }
            catch (Exception ex) { log.LogWarning("Pagamento (re-sync) do pedido {Doc} indisponível: {Msg}", p.DocumentoErp, ex.Message); }

            var r = await client.EnviarNfAsync(p.DocumentoErp, n, pg, ct);
            if (r is NfSyncResult.Ok or NfSyncResult.NotFound)
            {
                state.RemoveNfPendente(p.IdPedidoVenda);
                log.LogInformation("NF re-sincronizada: pedido {Doc} ({R}).", p.DocumentoErp, r);
            }
        }
    }
```

- [ ] **Step 3: Chamar no loop**

Em `ExecuteAsync`, logo após o bloco `try { await TickAsync(situacoesVenda, ct); } catch (...) { ... }` (hoje linhas ~17-18), adicionar:

```csharp
            try { await TickNfPendentesAsync(ct); }
            catch (Exception ex) { log.LogError(ex, "Erro no re-sync de NF"); }
```

- [ ] **Step 4: Code review (sem dotnet) + commit**

Conferir: `n` (do `nf is not { } n`) é a tupla `(string? Numero, string? Chave, DateTime? Emitida, decimal? Valor)` e casa com o 2º parâmetro de `EnviarNfAsync`; `state`, `repo`, `client`, `log` são os campos do primary constructor (já existentes); `TickNfPendentesAsync` roda DEPOIS de `TickAsync` (a lista pode ter acabado de ganhar itens, tudo bem). Iterar sobre `state.GetNfPendentes()` (cópia carregada do disco) enquanto `RemoveNfPendente` regrava o arquivo é seguro (a iteração é sobre a lista em memória já carregada).

```bash
git add agent/ExpedAgent/Worker.cs
git commit -m "feat(agent): re-sync de NF (alimenta lista no ingest + TickNfPendentesAsync no loop)"
```

---

## Task 6: Verificação final

**Files:** nenhum (verificação).

- [ ] **Step 1: Gates do servidor**

Run: `npm run test -- lib/pedidos/__tests__/atualizar-nf.test.ts app/api/ingest/pedido/nf/__tests__/route.test.ts`
Expected: PASS (9 testes no total).
Run: `npm run typecheck` (exit 0)
Run: `npx eslint lib/pedidos/atualizar-nf.ts app/api/ingest/pedido/nf/route.ts lib/validators/ingest.ts` (exit 0)

- [ ] **Step 2: Revisão do agente (sem dotnet)**

Reler os diffs C# (Tasks 3–5) confirmando: assinaturas, tipos de tupla, `using`s necessários
(`StateStore` usa `System` e `System.Collections.Generic` via implicit usings do .NET; `List<>.Exists/RemoveAll` ok). O `dotnet build agent/ExpedAgent` roda no **recompile do instalador** (fora deste ambiente) — se acusar algo, corrigir lá.

- [ ] **Step 3: Plano de teste manual (no recompile/instalação)**

Documentar para o go-live:
1. Criar um pedido no Hiper em situação 2 (pendente) → confirmar que entra no Exped sem NF e que
   o `state.json` ganha um item em `NfPendentes`.
2. Faturar esse pedido no Hiper (→ situação 5, NF emitida).
3. No próximo poll do agente: confirmar no Exped que `nf_numero`/`nf_chave`/`nf_valor` apareceram e
   que a forma de pagamento (se estava vazia) foi preenchida — **sem** alterar itens/status.
4. Confirmar que o item saiu de `NfPendentes` no `state.json`.

---

## Self-Review (autor do plano)

- **Cobertura do spec:** função preenche-só-vazio (T1) ✓; endpoint + schema + auth (T2) ✓; lista no
  StateStore com TTL (T3) ✓; EnviarNfAsync + payload (T4) ✓; alimentar lista no ingest sem NF +
  TickNfPendentesAsync no loop + TTL prune (T5) ✓; testes servidor (T1/T2/T6) ✓; revisão+manual do
  agente (T6) ✓; não toca status/itens/pontos (T1 só monta patch de nf/pagamento) ✓.
- **Placeholders:** nenhum — todo código escrito.
- **Consistência de tipos:** `atualizarNfPedido(supabase, {empresaId, documentoErp, nf, pagamento})`
  igual em T1/T2; `AtualizarNfResult` com `updated|nochange|notfound` consumido no route (T2);
  `NfSyncResult {Ok,NotFound,Error}` definido em T4 e usado em T5; `NfPendente{IdPedidoVenda,
  DocumentoErp,AddedAtUtc}` definido em T3 e usado em T4/T5; `EnviarNfAsync(doc, tupla-nf, tupla-pg?, ct)`
  definido em T4 e chamado em T5 com `n`/`pg` dos tipos certos; `AddNfPendente(id, doc, nowUtc)` /
  `PruneNfPendentes(nowUtc, ttl)` / `GetNfPendentes` / `RemoveNfPendente(id)` consistentes T3↔T5.
