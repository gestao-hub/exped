import { describe, it, expect } from 'vitest';
import { mergeRow } from '../merge';

describe('mergeRow (campo-a-campo)', () => {
  it('mantém o valor com field_updated_at mais recente por coluna', () => {
    const local = {
      id: '1',
      endereco: 'A',
      telefone: 'T1',
      field_updated_at: { endereco: '2026-01-02T00:00:00Z', telefone: '2026-01-01T00:00:00Z' },
    };
    const remote = {
      id: '1',
      endereco: 'B',
      telefone: 'T2',
      field_updated_at: { endereco: '2026-01-01T00:00:00Z', telefone: '2026-01-03T00:00:00Z' },
    };
    const m = mergeRow(local, remote);
    expect(m.endereco).toBe('A'); // local mais novo
    expect(m.telefone).toBe('T2'); // remote mais novo
    expect((m.field_updated_at as Record<string, string>).endereco).toBe('2026-01-02T00:00:00Z');
    expect((m.field_updated_at as Record<string, string>).telefone).toBe('2026-01-03T00:00:00Z');
  });

  it('empate de timestamp favorece o local (lt >= rt)', () => {
    const local = { id: '1', v: 'L', field_updated_at: { v: '2026-01-01T00:00:00Z' } };
    const remote = { id: '1', v: 'R', field_updated_at: { v: '2026-01-01T00:00:00Z' } };
    const m = mergeRow(local, remote);
    expect(m.v).toBe('L');
  });

  it('coluna só presente no remote sem carimbo local fica com o remote', () => {
    const local = { id: '1', field_updated_at: {} };
    const remote = { id: '1', cor: 'azul', field_updated_at: { cor: '2026-01-05T00:00:00Z' } };
    const m = mergeRow(local, remote);
    expect(m.cor).toBe('azul');
    expect((m.field_updated_at as Record<string, string>).cor).toBe('2026-01-05T00:00:00Z');
  });

  it('field_updated_at resultante é o máximo por coluna', () => {
    const local = {
      id: '1',
      a: 'la',
      b: 'lb',
      field_updated_at: { a: '2026-02-01T00:00:00Z', b: '2026-01-01T00:00:00Z' },
    };
    const remote = {
      id: '1',
      a: 'ra',
      b: 'rb',
      field_updated_at: { a: '2026-01-01T00:00:00Z', b: '2026-02-01T00:00:00Z' },
    };
    const m = mergeRow(local, remote);
    const fua = m.field_updated_at as Record<string, string>;
    expect(fua.a).toBe('2026-02-01T00:00:00Z');
    expect(fua.b).toBe('2026-02-01T00:00:00Z');
    expect(m.a).toBe('la');
    expect(m.b).toBe('rb');
  });
});
