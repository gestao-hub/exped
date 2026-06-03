import { describe, it, expect } from 'vitest';
import { calcularPaginacao, PAGE_SIZE } from '../paginacao';

describe('calcularPaginacao', () => {
  it('página 1 de 53 itens (pageSize 50): from 0, to 49, 2 páginas, sem prev, com next', () => {
    expect(calcularPaginacao(1, 53)).toEqual({ from: 0, to: 49, totalPages: 2, hasPrev: false, hasNext: true });
  });
  it('página 2 de 53: from 50, sem next, com prev', () => {
    const r = calcularPaginacao(2, 53);
    expect(r.from).toBe(50);
    expect(r.hasNext).toBe(false);
    expect(r.hasPrev).toBe(true);
    expect(r.totalPages).toBe(2);
  });
  it('0 itens: 1 página, sem prev/next', () => {
    expect(calcularPaginacao(1, 0)).toEqual({ from: 0, to: PAGE_SIZE - 1, totalPages: 1, hasPrev: false, hasNext: false });
  });
  it('clampa página acima do total pra última', () => {
    const r = calcularPaginacao(99, 53);
    expect(r.from).toBe(50);
    expect(r.hasNext).toBe(false);
  });
  it('clampa página < 1 pra 1', () => {
    expect(calcularPaginacao(0, 53).from).toBe(0);
  });
});
