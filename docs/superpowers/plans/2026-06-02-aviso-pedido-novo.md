# Aviso de Pedido Novo (do Hiper) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quando um pedido vindo do Hiper cai no Exped, avisar o operador na hora com notificação do Windows + som repetido + aba piscando, com um painel onde cada usuário escolhe a forma do aviso e testa.

**Architecture:** Reaproveita o realtime já ligado na tabela `pedidos`. Um conjunto de módulos puros (preferências, título, agendador de som) testáveis em Node; um player de som via Web Audio; um hook que assina o realtime e orquestra os sinais; e um componente global (sino + popover de preferências + "Testar aviso") montado no layout do app.

**Tech Stack:** Next.js 16 (App Router) + React client components, `@supabase/ssr` browser client, Web Audio API, Web Notifications API, Vitest (env `node`), `sonner` (toast).

**Spec:** [docs/superpowers/specs/2026-06-02-aviso-pedido-novo-design.md](../specs/2026-06-02-aviso-pedido-novo-design.md)

---

## File Structure

| Arquivo | Responsabilidade |
|---|---|
| `lib/alertas/preferencias.ts` | Tipo `PreferenciasAviso`, defaults, merge/validação, load/save (localStorage). Lógica pura testável. |
| `lib/alertas/preferencias.test.ts` | Testes da lógica pura de preferências. |
| `lib/alertas/titulo.ts` | `formatTituloAlerta(n)` (puro) + controlador de piscar `document.title`. |
| `lib/alertas/titulo.test.ts` | Testes do formato do título. |
| `lib/alertas/som.ts` | `LoopSom` (agendador injetável, puro-testável) + `criarPlayerSom()` (Web Audio) + catálogo de sons. |
| `lib/alertas/som.test.ts` | Testes do agendador `LoopSom`. |
| `components/alertas/use-alertas-pedido.ts` | Hook: assina realtime de `pedidos`, filtra INSERT com `documento_erp`, orquestra sinais + reconhecimento. |
| `components/alertas/alertas-center.tsx` | Sino + popover de preferências + "Testar aviso"; monta o hook. |
| `app/(app)/layout.tsx` | Montar `<AlertasCenter/>` globalmente (modificar). |
| `components/pedidos-list.tsx` | Remover o `toast` duplicado de INSERT (modificar). |
| `docs/onboarding-cliente.md` | Anotar passo "abrir por localhost:3000 no PC do operador" (modificar). |

---

## Task 1: Módulo de preferências (lógica pura + persistência)

**Files:**
- Create: `lib/alertas/preferencias.ts`
- Test: `lib/alertas/preferencias.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/alertas/preferencias.test.ts
import { describe, it, expect } from 'vitest';
import {
  PREFERENCIAS_PADRAO,
  mesclarPreferencias,
  chaveStorage,
  carregar,
  salvar,
  type PreferenciasAviso,
} from './preferencias';

describe('preferencias de aviso', () => {
  it('mescla parcial sobre os defaults', () => {
    const r = mesclarPreferencias({ som: false, somId: 'alarme' });
    expect(r).toEqual({ ...PREFERENCIAS_PADRAO, som: false, somId: 'alarme' });
  });

  it('ignora campos inválidos e cai no default', () => {
    const r = mesclarPreferencias({ somId: 'inexistente', ativado: 'sim' as unknown });
    expect(r.somId).toBe(PREFERENCIAS_PADRAO.somId);
    expect(r.ativado).toBe(PREFERENCIAS_PADRAO.ativado);
  });

  it('mesclarPreferencias(null) devolve uma cópia dos defaults', () => {
    expect(mesclarPreferencias(null)).toEqual(PREFERENCIAS_PADRAO);
  });

  it('chaveStorage inclui o userId', () => {
    expect(chaveStorage('u1')).toBe('exped:avisos:u1');
  });

  it('salvar + carregar faz round-trip via storage injetado', () => {
    const mem = new Map<string, string>();
    const storage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
    };
    const prefs: PreferenciasAviso = { ...PREFERENCIAS_PADRAO, ativado: true, somId: 'bipe' };
    salvar('u1', prefs, storage);
    expect(carregar('u1', storage)).toEqual(prefs);
  });

  it('carregar com storage vazio devolve defaults', () => {
    const storage = { getItem: () => null, setItem: () => {} };
    expect(carregar('u1', storage)).toEqual(PREFERENCIAS_PADRAO);
  });

  it('carregar com JSON corrompido devolve defaults (não lança)', () => {
    const storage = { getItem: () => '{lixo', setItem: () => {} };
    expect(carregar('u1', storage)).toEqual(PREFERENCIAS_PADRAO);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- lib/alertas/preferencias.test.ts`
Expected: FAIL — "Cannot find module './preferencias'".

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/alertas/preferencias.ts
export type SomId = 'sino' | 'bipe' | 'alarme';

export interface PreferenciasAviso {
  /** Master: avisos ligados (precisa do gesto de ativação no browser). */
  ativado: boolean;
  /** Tocar som no aviso. */
  som: boolean;
  /** Qual som. */
  somId: SomId;
  /** Repetir o som até reconhecer. */
  repetir: boolean;
  /** Mostrar notificação do Windows. */
  notificacao: boolean;
}

export const PREFERENCIAS_PADRAO: PreferenciasAviso = {
  ativado: false,
  som: true,
  somId: 'sino',
  repetir: true,
  notificacao: true,
};

const SONS_VALIDOS: SomId[] = ['sino', 'bipe', 'alarme'];

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/** Mescla um objeto desconhecido (JSON parseado) sobre os defaults, validando tipos. */
export function mesclarPreferencias(parcial: unknown): PreferenciasAviso {
  const p = (parcial && typeof parcial === 'object' ? parcial : {}) as Record<string, unknown>;
  const somId = SONS_VALIDOS.includes(p.somId as SomId)
    ? (p.somId as SomId)
    : PREFERENCIAS_PADRAO.somId;
  return {
    ativado: bool(p.ativado, PREFERENCIAS_PADRAO.ativado),
    som: bool(p.som, PREFERENCIAS_PADRAO.som),
    somId,
    repetir: bool(p.repetir, PREFERENCIAS_PADRAO.repetir),
    notificacao: bool(p.notificacao, PREFERENCIAS_PADRAO.notificacao),
  };
}

export function chaveStorage(userId: string): string {
  return `exped:avisos:${userId}`;
}

export function carregar(
  userId: string,
  storage: StorageLike | undefined = globalThis.localStorage,
): PreferenciasAviso {
  try {
    const raw = storage?.getItem(chaveStorage(userId));
    if (!raw) return { ...PREFERENCIAS_PADRAO };
    return mesclarPreferencias(JSON.parse(raw));
  } catch {
    return { ...PREFERENCIAS_PADRAO };
  }
}

export function salvar(
  userId: string,
  prefs: PreferenciasAviso,
  storage: StorageLike | undefined = globalThis.localStorage,
): void {
  try {
    storage?.setItem(chaveStorage(userId), JSON.stringify(prefs));
  } catch {
    /* localStorage indisponível — silencia */
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- lib/alertas/preferencias.test.ts`
Expected: PASS (7 testes).

- [ ] **Step 5: Commit**

```bash
git add lib/alertas/preferencias.ts lib/alertas/preferencias.test.ts
git commit -m "feat(aviso): modulo de preferencias do aviso de pedido"
```

---

## Task 2: Módulo de título piscante

**Files:**
- Create: `lib/alertas/titulo.ts`
- Test: `lib/alertas/titulo.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/alertas/titulo.test.ts
import { describe, it, expect } from 'vitest';
import { formatTituloAlerta } from './titulo';

describe('formatTituloAlerta', () => {
  it('singular para 1', () => {
    expect(formatTituloAlerta(1)).toBe('🔴 1 novo pedido');
  });
  it('plural para >1', () => {
    expect(formatTituloAlerta(3)).toBe('🔴 3 novos pedidos');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- lib/alertas/titulo.test.ts`
Expected: FAIL — "Cannot find module './titulo'".

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/alertas/titulo.ts
/** Texto do título piscante para N pedidos não vistos. Puro. */
export function formatTituloAlerta(n: number): string {
  return n > 1 ? `🔴 ${n} novos pedidos` : `🔴 ${n} novo pedido`;
}

/**
 * Controlador que pisca document.title entre o título-base e o alerta, até parar.
 * Só roda no browser; chamadas em ambiente sem `document` são no-op.
 */
export function criarPiscaTitulo() {
  let timer: ReturnType<typeof setInterval> | null = null;
  let base = '';
  let mostrandoAlerta = false;

  function parar() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (typeof document !== 'undefined' && base) document.title = base;
    mostrandoAlerta = false;
  }

  function piscar(n: number) {
    if (typeof document === 'undefined') return;
    if (!timer) base = document.title;
    const alerta = formatTituloAlerta(n);
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      mostrandoAlerta = !mostrandoAlerta;
      document.title = mostrandoAlerta ? alerta : base;
    }, 1000);
  }

  return { piscar, parar };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- lib/alertas/titulo.test.ts`
Expected: PASS (2 testes).

- [ ] **Step 5: Commit**

```bash
git add lib/alertas/titulo.ts lib/alertas/titulo.test.ts
git commit -m "feat(aviso): titulo piscante do aviso de pedido"
```

---

## Task 3: Módulo de som (agendador puro + player Web Audio)

**Files:**
- Create: `lib/alertas/som.ts`
- Test: `lib/alertas/som.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/alertas/som.test.ts
import { describe, it, expect, vi } from 'vitest';
import { LoopSom } from './som';

describe('LoopSom', () => {
  it('toca uma vez imediatamente ao iniciar', () => {
    const tocar = vi.fn();
    const loop = new LoopSom(tocar, { repetir: false });
    loop.iniciar();
    expect(tocar).toHaveBeenCalledTimes(1);
    loop.parar();
  });

  it('com repetir, reagenda a cada intervalo', () => {
    vi.useFakeTimers();
    const tocar = vi.fn();
    const loop = new LoopSom(tocar, { repetir: true, intervaloMs: 3000 });
    loop.iniciar();
    expect(tocar).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(9000);
    expect(tocar).toHaveBeenCalledTimes(4); // 1 imediato + 3 repetições
    loop.parar();
    vi.useRealTimers();
  });

  it('parar cancela as repetições', () => {
    vi.useFakeTimers();
    const tocar = vi.fn();
    const loop = new LoopSom(tocar, { repetir: true, intervaloMs: 3000 });
    loop.iniciar();
    loop.parar();
    vi.advanceTimersByTime(9000);
    expect(tocar).toHaveBeenCalledTimes(1); // só o imediato
    vi.useRealTimers();
  });

  it('iniciar duas vezes não cria dois timers', () => {
    vi.useFakeTimers();
    const tocar = vi.fn();
    const loop = new LoopSom(tocar, { repetir: true, intervaloMs: 3000 });
    loop.iniciar();
    loop.iniciar();
    vi.advanceTimersByTime(3000);
    expect(tocar).toHaveBeenCalledTimes(3); // 2 imediatos (1 por iniciar) ... ver nota
    loop.parar();
    vi.useRealTimers();
  });
});
```

> Nota sobre o 4º teste: `iniciar()` quando já rodando deve **reiniciar** (parar o timer antigo e tocar de novo). Então: 1º `iniciar` toca (1) e agenda; 2º `iniciar` para o timer antigo, toca (2) e reagenda; após 3000ms toca (3). Total 3. A implementação abaixo garante isso.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- lib/alertas/som.test.ts`
Expected: FAIL — "Cannot find module './som'".

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/alertas/som.ts
import type { SomId } from './preferencias';

export interface LoopSomOpts {
  repetir?: boolean;
  intervaloMs?: number;
}

/**
 * Agenda a chamada de `tocar`: uma vez imediata e, se `repetir`, a cada `intervaloMs`
 * até `parar()`. Sem dependência de browser — testável com fake timers.
 */
export class LoopSom {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly repetir: boolean;
  private readonly intervaloMs: number;

  constructor(private readonly tocar: () => void, opts: LoopSomOpts = {}) {
    this.repetir = opts.repetir ?? true;
    this.intervaloMs = opts.intervaloMs ?? 3000;
  }

  iniciar() {
    this.parar();
    this.tocar();
    if (this.repetir) {
      this.timer = setInterval(() => this.tocar(), this.intervaloMs);
    }
  }

  parar() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

// ===== Player Web Audio (só browser) =====

type WindowComAudio = Window & {
  webkitAudioContext?: typeof AudioContext;
};

/** Toca uma sequência de notas (freq Hz, início s, duração s) num AudioContext. */
function tocarNotas(ctx: AudioContext, notas: [number, number, number][]) {
  const agora = ctx.currentTime;
  for (const [freq, inicio, dur] of notas) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, agora + inicio);
    gain.gain.exponentialRampToValueAtTime(0.25, agora + inicio + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, agora + inicio + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(agora + inicio);
    osc.stop(agora + inicio + dur + 0.02);
  }
}

const CATALOGO: Record<SomId, [number, number, number][]> = {
  // [frequência Hz, início s, duração s]
  sino: [[880, 0, 0.18], [1320, 0.18, 0.35]],
  bipe: [[1000, 0, 0.12]],
  alarme: [[1200, 0, 0.1], [900, 0.12, 0.1], [1200, 0.24, 0.1]],
};

export interface PlayerSom {
  /** Garante o AudioContext ativo (chamar no gesto do usuário). */
  desbloquear: () => Promise<void>;
  tocar: (somId: SomId) => void;
}

export function criarPlayerSom(): PlayerSom {
  let ctx: AudioContext | null = null;

  function obterCtx(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (!ctx) {
      const Ctor = window.AudioContext || (window as WindowComAudio).webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    return ctx;
  }

  return {
    async desbloquear() {
      const c = obterCtx();
      if (c && c.state === 'suspended') await c.resume();
    },
    tocar(somId) {
      const c = obterCtx();
      if (!c) return;
      if (c.state === 'suspended') void c.resume();
      tocarNotas(c, CATALOGO[somId] ?? CATALOGO.sino);
    },
  };
}

export const SONS_LABEL: Record<SomId, string> = {
  sino: 'Sino',
  bipe: 'Bipe',
  alarme: 'Alarme',
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- lib/alertas/som.test.ts`
Expected: PASS (4 testes).

- [ ] **Step 5: Commit**

```bash
git add lib/alertas/som.ts lib/alertas/som.test.ts
git commit -m "feat(aviso): agendador de som (LoopSom) e player Web Audio"
```

---

## Task 4: Hook de realtime e orquestração dos sinais

**Files:**
- Create: `components/alertas/use-alertas-pedido.ts`

> Sem teste unitário: depende de Supabase realtime + Web Audio/Notification (browser). É verificado por `npm run typecheck` aqui e por verificação manual na Task 7.

- [ ] **Step 1: Implement the hook**

```ts
// components/alertas/use-alertas-pedido.ts
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { Pedido } from '@/lib/types';
import type { PreferenciasAviso } from '@/lib/alertas/preferencias';
import { criarPlayerSom, LoopSom } from '@/lib/alertas/som';
import { criarPiscaTitulo } from '@/lib/alertas/titulo';

interface Opts {
  userId: string;
  prefs: PreferenciasAviso;
  /** Para onde navegar ao clicar na notificação. */
  linkDoPedido: (p: Pedido) => string;
  navegar: (href: string) => void;
}

export function useAlertasPedido({ userId, prefs, linkDoPedido, navegar }: Opts) {
  const supabase = useMemo(() => createClient(), []);
  const [naoVistos, setNaoVistos] = useState(0);

  const player = useRef(criarPlayerSom());
  const loop = useRef<LoopSom | null>(null);
  const pisca = useRef(criarPiscaTitulo());
  // refs com os valores atuais pra usar dentro de callbacks estáveis do realtime
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const linkRef = useRef(linkDoPedido);
  linkRef.current = linkDoPedido;
  const navegarRef = useRef(navegar);
  navegarRef.current = navegar;
  const naoVistosRef = useRef(0);

  const reconhecer = useCallback(() => {
    naoVistosRef.current = 0;
    setNaoVistos(0);
    loop.current?.parar();
    loop.current = null;
    pisca.current.parar();
  }, []);

  const disparar = useCallback((p: Pedido) => {
    const pr = prefsRef.current;
    // Aba já em foco → só atualiza contagem, sem insistir
    const emFoco = typeof document !== 'undefined' && document.visibilityState === 'visible';
    naoVistosRef.current += 1;
    setNaoVistos(naoVistosRef.current);

    if (pr.som && !emFoco) {
      loop.current?.parar();
      loop.current = new LoopSom(() => player.current.tocar(pr.somId), { repetir: pr.repetir });
      loop.current.iniciar();
    }
    if (!emFoco) pisca.current.piscar(naoVistosRef.current);

    if (pr.notificacao && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      const n = new Notification(`Novo pedido — ${p.cliente_nome ?? 'cliente'}`, {
        body: `Nº ${p.numero_mapa ?? '-'} · R$ ${Number(p.valor_total ?? 0).toFixed(2)}`,
        tag: `pedido-${p.id}`,
      });
      n.onclick = () => {
        window.focus();
        navegarRef.current(linkRef.current(p));
        reconhecer();
        n.close();
      };
    }
  }, [reconhecer]);

  /** Usado pelo botão "Testar aviso". */
  const dispararTeste = useCallback(() => {
    disparar({
      id: 'teste',
      cliente_nome: 'Cliente Teste',
      numero_mapa: 0,
      valor_total: 0,
      documento_erp: 'TESTE',
    } as unknown as Pedido);
  }, [disparar]);

  // Reconhecer quando a aba volta ao foco / fica visível
  useEffect(() => {
    const onVisivel = () => {
      if (document.visibilityState === 'visible') reconhecer();
    };
    window.addEventListener('focus', reconhecer);
    document.addEventListener('visibilitychange', onVisivel);
    return () => {
      window.removeEventListener('focus', reconhecer);
      document.removeEventListener('visibilitychange', onVisivel);
    };
  }, [reconhecer]);

  // Assinatura realtime — só quando avisos ativados
  useEffect(() => {
    if (!prefs.ativado) return;
    const channel = supabase
      .channel('pedidos-alertas')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'pedidos' },
        (payload) => {
          const p = payload.new as Pedido;
          // só pedidos vindos do Hiper (têm documento_erp)
          if (!p.documento_erp) return;
          disparar(p);
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, prefs.ativado, disparar]);

  return { naoVistos, reconhecer, dispararTeste, player: player.current };
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: sem erros relacionados a `components/alertas/use-alertas-pedido.ts`. (Se `Pedido` exigir campos no literal do teste, o cast `as unknown as Pedido` já cobre.)

- [ ] **Step 3: Commit**

```bash
git add components/alertas/use-alertas-pedido.ts
git commit -m "feat(aviso): hook de realtime que orquestra os sinais de aviso"
```

---

## Task 5: Componente AlertasCenter (sino + preferências + testar) e montagem global

**Files:**
- Create: `components/alertas/alertas-center.tsx`
- Modify: `app/(app)/layout.tsx`
- Modify: `components/pedidos-list.tsx` (remover toast duplicado)

- [ ] **Step 1: Implement the component**

```tsx
// components/alertas/alertas-center.tsx
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, BellRing } from 'lucide-react';
import { useUser } from '@/components/providers/user-provider';
import type { Pedido } from '@/lib/types';
import {
  carregar,
  salvar,
  PREFERENCIAS_PADRAO,
  type PreferenciasAviso,
  type SomId,
} from '@/lib/alertas/preferencias';
import { SONS_LABEL } from '@/lib/alertas/som';
import { useAlertasPedido } from './use-alertas-pedido';

function linkDoPedido(role: string, p: Pedido): string {
  if (p.id === 'teste') return '#';
  return role === 'vendedor' ? `/vendas/${p.id}` : `/logistica/${p.id}`;
}

export function AlertasCenter() {
  const { profile } = useUser();
  const router = useRouter();
  const [aberto, setAberto] = useState(false);
  const [prefs, setPrefs] = useState<PreferenciasAviso>(PREFERENCIAS_PADRAO);
  const [pronto, setPronto] = useState(false);
  const [seguro, setSeguro] = useState(true);

  // carrega prefs do localStorage no mount (cliente)
  useEffect(() => {
    setPrefs(carregar(profile.id));
    setSeguro(typeof window !== 'undefined' ? window.isSecureContext : true);
    setPronto(true);
  }, [profile.id]);

  const { naoVistos, dispararTeste, player } = useAlertasPedido({
    userId: profile.id,
    prefs,
    linkDoPedido: (p) => linkDoPedido(profile.role, p),
    navegar: (href) => {
      if (href !== '#') router.push(href);
    },
  });

  function atualizar(patch: Partial<PreferenciasAviso>) {
    setPrefs((prev) => {
      const novo = { ...prev, ...patch };
      salvar(profile.id, novo);
      return novo;
    });
  }

  /** Liga o master: gesto do usuário → desbloqueia áudio + pede permissão de notificação. */
  async function ativar() {
    await player.desbloquear();
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      try {
        await Notification.requestPermission();
      } catch {
        /* ignora */
      }
    }
    atualizar({ ativado: true });
  }

  async function testar() {
    await player.desbloquear();
    dispararTeste();
  }

  if (!pronto) return null;

  const Icone = prefs.ativado && naoVistos > 0 ? BellRing : Bell;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setAberto((v) => !v)}
        className="relative inline-flex h-9 w-9 items-center justify-center rounded-lg text-[#667085] hover:bg-[#F2F4F7]"
        aria-label="Avisos de pedido"
      >
        <Icone className="h-5 w-5" />
        {naoVistos > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#D92D20] px-1 text-[10px] font-semibold text-white">
            {naoVistos}
          </span>
        )}
      </button>

      {aberto && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setAberto(false)} />
          <div className="absolute right-0 z-50 mt-2 w-72 rounded-xl border border-[#EAECF0] bg-white p-3 shadow-lg">
            <p className="mb-2 text-sm font-semibold text-[#1D2939]">Avisos de pedido novo</p>

            {!prefs.ativado ? (
              <button
                type="button"
                onClick={ativar}
                className="mb-2 w-full rounded-lg bg-[#039855] px-3 py-2 text-sm font-medium text-white"
              >
                Ativar avisos
              </button>
            ) : (
              <p className="mb-2 text-xs text-[#039855]">✅ Avisos ativos</p>
            )}

            {!seguro && (
              <p className="mb-2 rounded-md bg-[#FFFAEB] p-2 text-[11px] text-[#B54708]">
                ⚠️ Para a notificação do Windows, abra o Exped por{' '}
                <strong>http://localhost:3000</strong> neste PC. Som e piscar funcionam mesmo assim.
              </p>
            )}

            <Linha label="Tocar som" checked={prefs.som} onChange={(v) => atualizar({ som: v })} />
            <div className="my-2 flex items-center justify-between">
              <span className="text-sm text-[#344054]">Som</span>
              <select
                value={prefs.somId}
                onChange={(e) => atualizar({ somId: e.target.value as SomId })}
                className="rounded-md border border-[#D0D5DD] px-2 py-1 text-sm"
              >
                {(Object.keys(SONS_LABEL) as SomId[]).map((id) => (
                  <option key={id} value={id}>
                    {SONS_LABEL[id]}
                  </option>
                ))}
              </select>
            </div>
            <Linha
              label="Repetir som até eu ver"
              checked={prefs.repetir}
              onChange={(v) => atualizar({ repetir: v })}
            />
            <Linha
              label="Notificação do Windows"
              checked={prefs.notificacao}
              onChange={(v) => atualizar({ notificacao: v })}
            />

            <button
              type="button"
              onClick={testar}
              className="mt-3 w-full rounded-lg border border-[#D0D5DD] px-3 py-2 text-sm font-medium text-[#344054] hover:bg-[#F9FAFB]"
            >
              Testar aviso
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Linha({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between py-1.5 text-sm text-[#344054]">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}
```

- [ ] **Step 2: Mount globally in the app layout**

Modify `app/(app)/layout.tsx` — importar e renderizar o `AlertasCenter` dentro do `<UserProvider>`. Trocar a abertura do `<main>` para incluir o sino num cabeçalho fino acima do conteúdo (desktop). Aplicar:

Adicionar o import no topo (junto aos outros):
```tsx
import { AlertasCenter } from '@/components/alertas/alertas-center';
```

Trocar este trecho:
```tsx
          <MobileHeader empresa={empresa} />
          <main className="flex-1 min-h-0 overflow-y-auto px-4 md:px-8 py-6 md:py-8">
```
por:
```tsx
          <MobileHeader empresa={empresa} />
          <div className="hidden md:flex items-center justify-end px-8 pt-4">
            <AlertasCenter />
          </div>
          <main className="flex-1 min-h-0 overflow-y-auto px-4 md:px-8 py-6 md:py-8">
```

> O sino também deve aparecer no mobile: adicionar `<AlertasCenter />` dentro de `components/layout/mobile-header.tsx` na área de ações do header (ao lado dos controles existentes). Abrir o arquivo, localizar o container das ações à direita e inserir `<AlertasCenter />` lá. (Se o MobileHeader não tiver área de ações, renderizar ao final do header, antes de fechar a `<header>`.)

- [ ] **Step 3: Remove the duplicated toast in the list**

Modify `components/pedidos-list.tsx` — remover o bloco de toast em INSERT (o aviso passa a ser único, na AlertasCenter). Localizar:
```tsx
              if (mode === 'logistica' && novo.status === 'pendente') {
                toast(`Novo pedido na fila: ${novo.cliente_nome}`);
              }
```
e **apagar** essas 3 linhas. Se o import `toast` de `sonner` ficar sem uso após isso, removê-lo também (rodar `npm run lint` confirma).

- [ ] **Step 4: Typecheck, lint e build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: sem erros. (O build do Next compila os client components e valida o uso de `useRouter`/`useUser`.)

- [ ] **Step 5: Commit**

```bash
git add components/alertas/alertas-center.tsx app/\(app\)/layout.tsx components/layout/mobile-header.tsx components/pedidos-list.tsx
git commit -m "feat(aviso): central de avisos (sino + preferencias + testar) montada no app"
```

---

## Task 6: Nota de onboarding (abrir por localhost)

**Files:**
- Modify: `docs/onboarding-cliente.md`

- [ ] **Step 1: Add the operator step**

Abrir `docs/onboarding-cliente.md`, localizar a seção de configuração do PC do operador (onde se descreve abrir o Exped no navegador). Adicionar o item:

```markdown
- **PC do operador (mesmo do Hiper):** abrir o Exped por **http://localhost:3000** (não pelo IP
  da LAN). Isso libera a **notificação do Windows** e o **som** do aviso de pedido novo. Depois,
  clicar uma vez no sino → **Ativar avisos** (o navegador exige esse clique). Pelo IP da LAN o
  aviso ainda toca som e pisca a aba, mas sem a notificação do Windows.
```

- [ ] **Step 2: Commit**

```bash
git add docs/onboarding-cliente.md
git commit -m "docs(onboarding): abrir Exped por localhost no PC do operador (avisos)"
```

---

## Task 7: Verificação manual (dev server + browser)

**Files:** nenhum (verificação).

- [ ] **Step 1: Subir o dev e abrir por localhost**

Run: `npm run dev` e abrir `http://localhost:3000` (contexto seguro), logar como `logistica@franzoni.local`.

- [ ] **Step 2: Ativar e testar**

No sino → **Ativar avisos** (aceitar a permissão de notificação) → **Testar aviso**.
Expected: aparece a notificação do Windows "Novo pedido — Cliente Teste", toca o som escolhido, e (se a aba estiver em segundo plano) o título da aba pisca "🔴 1 novo pedido". Trocar o som no select e testar de novo confirma a escolha.

- [ ] **Step 3: INSERT real de realtime**

Em outra aba/terminal, inserir um pedido com `documento_erp` (via app `/vendas/novo` não serve — não tem documento_erp; usar a Management API ou um INSERT SQL de teste com `documento_erp='TESTE-RT'` no banco, depois apagar). Minimizar a aba do Exped antes.
Expected: com a aba em segundo plano, dispara notificação + som repetindo a cada ~3s; ao clicar na notificação (ou focar a aba), o som **para**, o título volta ao normal e (no clique) navega pro pedido. **Apagar** o pedido de teste do banco depois.

- [ ] **Step 4: Fallback inseguro**

Abrir por `http://<ip-da-lan>:3000`, repetir o "Testar aviso".
Expected: popover mostra o aviso de "abra por localhost"; **sem** notificação do Windows, mas som + piscar funcionam após Ativar/Testar (gesto). Nada quebra no console.

- [ ] **Step 5: Marcar verificação concluída** (sem commit — é checklist).

---

## Self-Review (preenchido pelo autor do plano)

- **Cobertura do spec:** disparo por `documento_erp` (T4) ✓; 3 sinais notificação/som/piscar (T2,T3,T4) ✓; som repetido até reconhecer (T3 `repetir` + T4 loop/reconhecer) ✓; painel de preferências com escolha de som + on/off (T5) ✓; "Testar aviso" (T4 `dispararTeste` + T5) ✓; gesto de ativação + contexto seguro + fallback (T5) ✓; reconhecimento por foco/clique (T4) ✓; montagem global (T5 layout) ✓; dedup do toast da lista (T5) ✓; nota de onboarding localhost (T6) ✓; testes (T1–T3 unit, T7 manual) ✓.
- **Placeholders:** nenhum — todo código está escrito.
- **Consistência de tipos:** `PreferenciasAviso`/`SomId` usados igual em todas as tasks; `LoopSom(tocar, opts)` igual em T3/T4; `criarPlayerSom().{desbloquear,tocar}` igual em T3/T4/T5; `dispararTeste`/`naoVistos`/`reconhecer` expostos pelo hook (T4) e consumidos em T5.
