import { describe, it, expect } from 'vitest';
import { sincronizarDestinos } from '@/lib/pedidos/sincronizar-destinos';
import type { ItemInput } from '@/lib/validators/pedido';

function item(over: Partial<ItemInput> = {}): ItemInput {
  return {
    codigo: 'C',
    descricao: 'desc',
    quantidade: 1,
    unidade: 'UN',
    preco_unitario: 10,
    desconto: 0,
    total: 10,
    modalidade: 'loja',
    ...over,
  };
}

describe('sincronizarDestinos', () => {
  it('só itens imediato → nenhum ponto (sem destino)', () => {
    const pontos = sincronizarDestinos({
      itens: [item({ modalidade: 'imediato' }), item({ modalidade: 'imediato' })],
    });
    expect(pontos).toEqual([]);
  });

  it('itens loja → 1 ponto loja com todos os itens loja', () => {
    const pontos = sincronizarDestinos({
      itens: [item({ codigo: 'A' }), item({ codigo: 'B' })],
      loja: { empresa_nome: 'Loja Centro', endereco: 'Rua 1' },
    });
    expect(pontos).toHaveLength(1);
    expect(pontos[0].tipo).toBe('loja');
    expect(pontos[0].empresa_nome).toBe('Loja Centro');
    expect(pontos[0].endereco).toBe('Rua 1');
    expect(pontos[0].itens.map((i) => i.codigo)).toEqual(['A', 'B']);
  });

  it('itens entrega → 1 ponto entrega com endereço do destino', () => {
    const pontos = sincronizarDestinos({
      itens: [item({ codigo: 'E', modalidade: 'entrega' })],
      entrega: { empresa_nome: 'Cliente', endereco: 'Av. Brasil, 100' },
    });
    expect(pontos).toHaveLength(1);
    expect(pontos[0].tipo).toBe('entrega');
    expect(pontos[0].endereco).toBe('Av. Brasil, 100');
    expect(pontos[0].itens).toHaveLength(1);
  });

  it('mix (loja + entrega + imediato) → ponto loja + ponto entrega; imediato fora', () => {
    const pontos = sincronizarDestinos({
      itens: [
        item({ codigo: 'L1', modalidade: 'loja' }),
        item({ codigo: 'E1', modalidade: 'entrega' }),
        item({ codigo: 'I1', modalidade: 'imediato' }),
        item({ codigo: 'L2', modalidade: 'loja' }),
      ],
      loja: { empresa_nome: 'Loja' },
      entrega: { empresa_nome: 'Cliente', endereco: 'End' },
    });
    expect(pontos.map((p) => p.tipo)).toEqual(['loja', 'entrega']);
    const loja = pontos.find((p) => p.tipo === 'loja')!;
    const entrega = pontos.find((p) => p.tipo === 'entrega')!;
    expect(loja.itens.map((i) => i.codigo)).toEqual(['L1', 'L2']);
    expect(entrega.itens.map((i) => i.codigo)).toEqual(['E1']);
    // nenhum ponto contém o item imediato
    const todosCodigos = pontos.flatMap((p) => p.itens.map((i) => i.codigo));
    expect(todosCodigos).not.toContain('I1');
  });

  it('preserva a PK (id) dos pontos quando informada → permite UPDATE in-place', () => {
    const pontos = sincronizarDestinos({
      itens: [item({ modalidade: 'loja' }), item({ modalidade: 'entrega' })],
      loja: { id: 'ponto-loja-1', empresa_nome: 'L' },
      entrega: { id: 'ponto-entrega-1', endereco: 'E' },
    });
    expect(pontos.find((p) => p.tipo === 'loja')!.id).toBe('ponto-loja-1');
    expect(pontos.find((p) => p.tipo === 'entrega')!.id).toBe('ponto-entrega-1');
  });

  it('preserva a modalidade original de cada item (fonte da verdade)', () => {
    const pontos = sincronizarDestinos({
      itens: [item({ modalidade: 'loja' }), item({ modalidade: 'entrega' })],
    });
    expect(pontos.find((p) => p.tipo === 'loja')!.itens[0].modalidade).toBe('loja');
    expect(pontos.find((p) => p.tipo === 'entrega')!.itens[0].modalidade).toBe('entrega');
  });
});
