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
    expect(tocar).toHaveBeenCalledTimes(3); // iniciar#1 toca(1); iniciar#2 para timer e toca(2); +3000ms toca(3)
    loop.parar();
    vi.useRealTimers();
  });
});
