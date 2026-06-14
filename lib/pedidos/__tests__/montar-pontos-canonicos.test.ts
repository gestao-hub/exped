import { describe, it, expect } from 'vitest';
import {
  montarPontosCanonicos,
  type EntregaDestino,
} from '@/lib/pedidos/montar-pontos-canonicos';
import type { PedidoFormInput, ItemInput } from '@/lib/validators/pedido';

function mkItem(over: Partial<ItemInput> & Pick<ItemInput, 'codigo' | 'modalidade'>): ItemInput {
  const base: ItemInput = {
    codigo: over.codigo,
    descricao: over.descricao ?? over.codigo,
    quantidade: over.quantidade ?? 1,
    unidade: over.unidade ?? 'UN',
    preco_unitario: over.preco_unitario ?? 10,
    desconto: over.desconto ?? 0,
    total: over.total ?? 10,
    modalidade: over.modalidade,
  };
  if (over.id !== undefined) base.id = over.id;
  if (over.endereco_entrega_id !== undefined) base.endereco_entrega_id = over.endereco_entrega_id;
  return base;
}

/** Forma de TRABALHO do form: [0]=loja carrega TODOS os itens, [1]=entrega (destino
 *  padrão), [2]=imediato (container). É o que o componente mantém em estado. */
function workingValues(
  itens: ItemInput[],
  ids?: { loja?: string | null; entrega?: string | null; imediato?: string | null },
): PedidoFormInput {
  return {
    cliente_nome: 'Cliente',
    valor_total: 0,
    pontos_retirada: [
      { id: ids?.loja ?? null, tipo: 'loja', empresa_nome: 'Loja', endereco: null, itens },
      { id: ids?.entrega ?? null, tipo: 'entrega', empresa_nome: '', endereco: null, itens: [] },
      { id: ids?.imediato ?? null, tipo: 'imediato', empresa_nome: '', endereco: null, itens: [] },
    ],
  } as PedidoFormInput;
}

describe('montarPontosCanonicos', () => {
  it('preserva itens de TODAS as modalidades (não perde entrega/imediato) — fix do re-save', () => {
    const itens = [
      mkItem({ codigo: 'L1', modalidade: 'loja' }),
      mkItem({ codigo: 'E1', modalidade: 'entrega' }),
      mkItem({ codigo: 'I1', modalidade: 'imediato' }),
    ];
    const pontos = montarPontosCanonicos(workingValues(itens), []);
    expect(pontos.map((p) => p.tipo).sort()).toEqual(['entrega', 'imediato', 'loja']);
    expect(pontos.flatMap((p) => p.itens.map((i) => i.codigo)).sort()).toEqual(['E1', 'I1', 'L1']);
  });

  it('é PURA: não muta os values e chamar 2x dá o mesmo resultado (re-save estável após erro)', () => {
    const itens = [
      mkItem({ codigo: 'L1', modalidade: 'loja' }),
      mkItem({ codigo: 'E1', modalidade: 'entrega' }),
      mkItem({ codigo: 'I1', modalidade: 'imediato' }),
    ];
    const values = workingValues(itens);
    const snapshot = JSON.parse(JSON.stringify(values));

    const a = montarPontosCanonicos(values, []);
    // O estado de trabalho permanece íntegro (NÃO colapsa pra só os itens loja) — é
    // exatamente o que o bug de re-save violava ao gravar no estado antes de validar.
    expect(values).toEqual(snapshot);
    expect(values.pontos_retirada[0].itens.map((i) => i.codigo)).toEqual(['L1', 'E1', 'I1']);

    const b = montarPontosCanonicos(values, []);
    expect(b).toEqual(a);
  });

  it('roteia itens entrega por endereço (multi-endereço) para pontos distintos', () => {
    const itens = [
      mkItem({ codigo: 'A', modalidade: 'entrega', endereco_entrega_id: 'addr-1' }),
      mkItem({ codigo: 'B', modalidade: 'entrega', endereco_entrega_id: 'addr-2' }),
      mkItem({ codigo: 'C', modalidade: 'entrega', endereco_entrega_id: 'addr-1' }),
    ];
    const destinos: EntregaDestino[] = [
      { enderecoId: 'addr-1', id: null, empresa_nome: 'Dest 1', endereco: 'Rua 1' },
      { enderecoId: 'addr-2', id: null, empresa_nome: 'Dest 2', endereco: 'Rua 2' },
    ];
    const entregas = montarPontosCanonicos(workingValues(itens), destinos).filter(
      (p) => p.tipo === 'entrega',
    );
    expect(entregas).toHaveLength(2);
    expect(entregas.find((p) => p.endereco === 'Rua 1')!.itens.map((i) => i.codigo).sort()).toEqual(['A', 'C']);
    expect(entregas.find((p) => p.endereco === 'Rua 2')!.itens.map((i) => i.codigo)).toEqual(['B']);
  });

  it('pedido só com itens imediato → um ponto-container imediato (nunca array vazio)', () => {
    const pontos = montarPontosCanonicos(
      workingValues([mkItem({ codigo: 'I1', modalidade: 'imediato' })]),
      [],
    );
    expect(pontos).toHaveLength(1);
    expect(pontos[0].tipo).toBe('imediato');
    expect(pontos[0].itens.map((i) => i.codigo)).toEqual(['I1']);
  });

  it('preserva a PK do ponto (UPDATE in-place) quando informada na forma de trabalho', () => {
    const itens = [mkItem({ codigo: 'L1', modalidade: 'loja' })];
    const pontos = montarPontosCanonicos(workingValues(itens, { loja: 'ponto-loja-1' }), []);
    const loja = pontos.find((p) => p.tipo === 'loja')!;
    expect(loja.id).toBe('ponto-loja-1');
  });
});
