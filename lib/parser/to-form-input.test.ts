import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseHiperErp } from './hiper-erp';
import { parsedToFormInput } from './to-form-input';

const fixture = readFileSync(
  resolve(__dirname, '../../tests/fixtures/pedido-L4077.txt'),
  'utf-8',
);

describe('parsedToFormInput — modalidade', () => {
  const parsed = parseHiperErp(fixture);
  const form = parsedToFormInput(parsed, null);

  it('todo item parseado começa com modalidade "loja"', () => {
    const itens = form.pontos_retirada.flatMap((p) => p.itens);
    expect(itens.length).toBeGreaterThan(0);
    for (const item of itens) {
      expect(item.modalidade).toBe('loja');
    }
  });
});
