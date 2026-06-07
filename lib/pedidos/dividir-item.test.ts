import { describe, it, expect } from 'vitest';
import { dividirItem, mesclarItem, round2 } from './dividir-item';
import type { ItemInput } from '@/lib/validators/pedido';

function item(over: Partial<ItemInput> = {}): ItemInput {
  return {
    id: 'abc',
    codigo: 'A',
    descricao: 'PRODUTO A',
    quantidade: 5,
    unidade: 'UN',
    preco_unitario: 10,
    desconto: 0,
    total: 50,
    referencia: null,
    ...over,
  } as ItemInput;
}

describe('round2', () => {
  it('arredonda centavos', () => {
    expect(round2(9.005)).toBe(9.01);
    expect(round2(18.9)).toBe(18.9);
  });
});

describe('dividirItem', () => {
  it('mover tudo: movido com qtd cheia (id novo) e restante null', () => {
    const { movido, restante } = dividirItem(item({ quantidade: 2, preco_unitario: 9.45, total: 18.9 }), 2);
    expect(movido.quantidade).toBe(2);
    expect(movido.total).toBe(18.9);
    expect(movido.id).toBeNull();
    expect(restante).toBeNull();
  });

  it('mover parte: divide quantidade e total', () => {
    const { movido, restante } = dividirItem(item({ quantidade: 5, preco_unitario: 10, total: 50 }), 3);
    expect(movido.quantidade).toBe(3);
    expect(movido.total).toBe(30);
    expect(movido.id).toBeNull();
    expect(restante?.quantidade).toBe(2);
    expect(restante?.total).toBe(20);
    expect(restante?.id).toBe('abc'); // restante mantém o id original
  });

  it('rateia o desconto proporcionalmente', () => {
    // q=4, unit=10, desconto=4 (total=36). mover 1 → desc 1 (total 9); resta 3 → desc 3 (total 27)
    const { movido, restante } = dividirItem(
      item({ quantidade: 4, preco_unitario: 10, desconto: 4, total: 36 }),
      1,
    );
    expect(movido.desconto).toBe(1);
    expect(movido.total).toBe(9);
    expect(restante?.desconto).toBe(3);
    expect(restante?.total).toBe(27);
    expect(round2((movido.total ?? 0) + (restante?.total ?? 0))).toBe(36); // soma preservada
  });

  it('limita n ao intervalo [0, quantidade]', () => {
    const { movido, restante } = dividirItem(item({ quantidade: 2, preco_unitario: 10, total: 20 }), 99);
    expect(movido.quantidade).toBe(2);
    expect(restante).toBeNull();
  });
});

describe('mesclarItem', () => {
  it('soma no item de mesmo código + preço', () => {
    const alvo: ItemInput[] = [item({ codigo: 'A', preco_unitario: 10, quantidade: 3, total: 30 })];
    const out = mesclarItem(alvo, item({ id: null, codigo: 'A', preco_unitario: 10, quantidade: 2, total: 20 }));
    expect(out).toHaveLength(1);
    expect(out[0].quantidade).toBe(5);
    expect(out[0].total).toBe(50);
  });

  it('adiciona nova linha quando código difere', () => {
    const alvo: ItemInput[] = [item({ codigo: 'A', quantidade: 3 })];
    const out = mesclarItem(alvo, item({ id: null, codigo: 'B', quantidade: 1 }));
    expect(out).toHaveLength(2);
  });

  it('não mescla quando o código é vazio (adiciona)', () => {
    const alvo: ItemInput[] = [item({ codigo: '', quantidade: 3 })];
    const out = mesclarItem(alvo, item({ id: null, codigo: '', quantidade: 1 }));
    expect(out).toHaveLength(2);
  });
});
