import { describe, it, expect } from 'vitest';
import { reconcileChildren, type ExistingPonto } from '@/lib/pedidos/reconcile';
import type { PedidoFormInput } from '@/lib/validators/pedido';

type PontoInput = PedidoFormInput['pontos_retirada'][number];

function item(over: Partial<PontoInput['itens'][number]> = {}): PontoInput['itens'][number] {
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

describe('reconcileChildren — PK estável (cenário A/B/C)', () => {
  it('A continua (UPDATE id preservado, qtd nova), B sai (softDelete), C entra (INSERT)', () => {
    const existing: ExistingPonto[] = [
      { id: 'p1', itens: [{ id: 'a' }, { id: 'b' }] },
    ];
    const incoming: PontoInput[] = [
      {
        id: 'p1',
        tipo: 'loja',
        empresa_nome: 'Loja 1',
        endereco: null,
        itens: [
          item({ id: 'a', quantidade: 99 }), // A: continua com qtd nova
          item({ /* sem id */ codigo: 'C-novo' }), // C: novo
        ],
      },
    ];

    const { pontos } = reconcileChildren(existing, incoming);

    // ponto único permanece como UPDATE in-place
    expect(pontos).toHaveLength(1);
    const p = pontos[0];
    expect(p.kind).toBe('update');
    if (p.kind !== 'update') throw new Error('esperado update');
    expect(p.id).toBe('p1');

    const itemOps = p.itens;
    // A → update, id preservado, qtd nova
    const aOp = itemOps.find((o) => o.kind === 'update' && o.id === 'a');
    expect(aOp).toBeDefined();
    if (aOp?.kind !== 'update') throw new Error('A deveria ser update');
    expect(aOp.id).toBe('a');
    expect(aOp.data.quantidade).toBe(99);

    // B → softDelete (NÃO hard-delete)
    const bOp = itemOps.find((o) => o.kind !== 'insert' && o.id === 'b');
    expect(bOp).toBeDefined();
    expect(bOp?.kind).toBe('softDelete');

    // C → insert (sem id)
    const cOps = itemOps.filter((o) => o.kind === 'insert');
    expect(cOps).toHaveLength(1);
    if (cOps[0].kind !== 'insert') throw new Error('C deveria ser insert');
    expect(cOps[0].data.codigo).toBe('C-novo');

    // garantia: nenhum hard-delete possível — só update/insert/softDelete
    for (const o of itemOps) {
      expect(['update', 'insert', 'softDelete']).toContain(o.kind);
    }
  });

  it('ponto removido inteiro → softDelete do ponto e dos seus itens', () => {
    const existing: ExistingPonto[] = [
      { id: 'p1', itens: [{ id: 'a' }] },
      { id: 'p2', itens: [{ id: 'x' }, { id: 'y' }] },
    ];
    const incoming: PontoInput[] = [
      { id: 'p1', tipo: 'loja', empresa_nome: 'L', endereco: null, itens: [item({ id: 'a' })] },
    ];

    const { pontos } = reconcileChildren(existing, incoming);
    const p2 = pontos.find((p) => 'id' in p && p.id === 'p2');
    expect(p2?.kind).toBe('softDelete');
    if (p2?.kind !== 'softDelete') throw new Error('p2 deveria ser softDelete');
    expect(p2.itens.every((o) => o.kind === 'softDelete')).toBe(true);
    const ids = p2.itens.map((o) => (o.kind !== 'insert' ? o.id : '')).sort();
    expect(ids).toEqual(['x', 'y']);
  });

  it('ponto novo (sem id) → insert; seus itens viram insert', () => {
    const existing: ExistingPonto[] = [];
    const incoming: PontoInput[] = [
      { tipo: 'deposito', empresa_nome: 'Dep', endereco: 'rua', itens: [item(), item()] },
    ];
    const { pontos } = reconcileChildren(existing, incoming);
    expect(pontos).toHaveLength(1);
    expect(pontos[0].kind).toBe('insert');
    expect(pontos[0].itens.every((o) => o.kind === 'insert')).toBe(true);
  });

  it('ordem é recomputada pela posição no array', () => {
    const existing: ExistingPonto[] = [{ id: 'p1', itens: [{ id: 'a' }, { id: 'b' }] }];
    const incoming: PontoInput[] = [
      {
        id: 'p1',
        tipo: 'loja',
        empresa_nome: 'L',
        endereco: null,
        itens: [item({ id: 'b' }), item({ id: 'a' })], // invertidos
      },
    ];
    const { pontos } = reconcileChildren(existing, incoming);
    const p = pontos[0];
    if (p.kind !== 'update') throw new Error('update esperado');
    const b = p.itens.find((o) => o.kind !== 'softDelete' && 'id' in o && o.id === 'b');
    const a = p.itens.find((o) => o.kind !== 'softDelete' && 'id' in o && o.id === 'a');
    if (b?.kind !== 'update' || a?.kind !== 'update') throw new Error('updates esperados');
    expect(b.ordem).toBe(0);
    expect(a.ordem).toBe(1);
  });
});
