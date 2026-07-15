import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./inserir.ts', import.meta.url), 'utf8');

describe('reimportacao de filhos do pedido', () => {
  it('preserva historico com tombstones em vez de hard delete', () => {
    expect(source).not.toMatch(/from\('pedido_itens'\)\.delete\(\)/);
    expect(source).not.toMatch(/from\('pedido_pontos_retirada'\)\.delete\(\)/);
    expect(source).toMatch(/from\('pedido_itens'\)[\s\S]*?update\(\{ deleted_at: now \}\)/);
    expect(source).toMatch(/from\('pedido_pontos_retirada'\)[\s\S]*?update\(\{ deleted_at: now \}\)/);
  });
});
