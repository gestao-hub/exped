import { describe, it, expect } from 'vitest';
import { financeiroFormSchema } from '../financeiro';

describe('financeiroFormSchema', () => {
  it('aceita exige_emissao: true', () => {
    const r = financeiroFormSchema.safeParse({
      valor_total: 100,
      exige_emissao: true,
    });
    expect(r.success && r.data.exige_emissao).toBe(true);
  });

  it('exige_emissao é opcional (ausente é válido)', () => {
    const r = financeiroFormSchema.safeParse({
      valor_total: 100,
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data.exige_emissao).toBeUndefined();
  });
});
