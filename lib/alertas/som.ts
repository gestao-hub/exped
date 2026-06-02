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
