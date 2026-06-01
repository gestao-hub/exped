import { describe, it, expect } from 'vitest';
import { pedidoFormSchema } from '../pedido';
describe('pedidoFormSchema pagamento/retirada', () => {
  const base = { cliente_nome: 'X', valor_total: 0,
    pontos_retirada: [{ tipo: 'entrega', empresa_nome: '', itens: [] }] };
  it('aceita forma enum, parcelas int e tipo entrega', () => {
    const r = pedidoFormSchema.safeParse({ ...base, forma_pagamento: 'credito', parcelas: 6 });
    expect(r.success).toBe(true);
  });
  it('rejeita forma fora do enum e parcelas > 12', () => {
    expect(pedidoFormSchema.safeParse({ ...base, forma_pagamento: 'cheque' }).success).toBe(false);
    expect(pedidoFormSchema.safeParse({ ...base, parcelas: 99 }).success).toBe(false);
  });
});
