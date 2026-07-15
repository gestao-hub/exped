import { describe, expect, it } from 'vitest';
import { buildPedidoTextSearchOr, parsePedidoSearch } from '../filtros-lista';
import { applyPedidoListQueryPolicy } from '../query-policy';

describe('parsePedidoSearch', () => {
  it.each(['#4079', '  #4079  '])('interpreta %s como numero_mapa exato', (raw) => {
    expect(parsePedidoSearch(raw)).toEqual({ kind: 'numero_mapa', value: 4079 });
  });

  it('mantém número sem # como busca híbrida por mapa ou documento', () => {
    expect(parsePedidoSearch('4079')).toEqual({ kind: 'texto', value: '4079' });
  });

  it('mantém documento ERP como busca textual', () => {
    expect(parsePedidoSearch('L001000000282')).toEqual({
      kind: 'texto',
      value: 'L001000000282',
    });
  });

  it('retorna vazio para espaços', () => {
    expect(parsePedidoSearch('   ')).toEqual({ kind: 'vazio' });
  });
});

describe('buildPedidoTextSearchOr', () => {
  it('preserva os três campos atuais', () => {
    expect(buildPedidoTextSearchOr('Muraro')).toBe(
      'cliente_nome.ilike."%Muraro%",documento_erp.ilike."%Muraro%",cliente_bairro.ilike."%Muraro%"',
    );
  });

  it('cota vírgula, parênteses, barra e aspas sem alterar a gramática do filtro', () => {
    expect(buildPedidoTextSearchOr('A,(B)\\"C')).toBe(
      'cliente_nome.ilike."%A,(B)\\\\\\"C%",documento_erp.ilike."%A,(B)\\\\\\"C%",cliente_bairro.ilike."%A,(B)\\\\\\"C%"',
    );
  });
});

describe('applyPedidoListQueryPolicy', () => {
  it('aplica exclusão de soft-delete à query real da lista', () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const query = {
      is(column: string, value: null) {
        calls.push({ method: 'is', args: [column, value] });
        return query;
      },
      eq(column: string, value: string | number) {
        calls.push({ method: 'eq', args: [column, value] });
        return query;
      },
      or(filter: string) {
        calls.push({ method: 'or', args: [filter] });
        return query;
      },
    };

    applyPedidoListQueryPolicy(query, {
      empresaId: null,
      status: 'todos',
      search: '   ',
    });

    expect(calls).toEqual([{ method: 'is', args: ['deleted_at', null] }]);
  });

  it('encontra documento ERP L4079 com mapa diferente sem perder tenant ou soft-delete', () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const query = {
      is(column: string, value: null) {
        calls.push({ method: 'is', args: [column, value] });
        return query;
      },
      eq(column: string, value: string | number) {
        calls.push({ method: 'eq', args: [column, value] });
        return query;
      },
      or(filter: string) {
        calls.push({ method: 'or', args: [filter] });
        return query;
      },
    };

    applyPedidoListQueryPolicy(query, {
      empresaId: 'empresa-1',
      status: 'todos',
      search: '4079',
    });

    expect(calls).toEqual([
      { method: 'is', args: ['deleted_at', null] },
      { method: 'eq', args: ['empresa_id', 'empresa-1'] },
      {
        method: 'or',
        args: ['numero_mapa.eq.4079,documento_erp.ilike."%4079%"'],
      },
    ]);
  });

  it('trata #4079 exclusivamente como numero_mapa', () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const query = {
      is(column: string, value: null) {
        calls.push({ method: 'is', args: [column, value] });
        return query;
      },
      eq(column: string, value: string | number) {
        calls.push({ method: 'eq', args: [column, value] });
        return query;
      },
      or(filter: string) {
        calls.push({ method: 'or', args: [filter] });
        return query;
      },
    };

    applyPedidoListQueryPolicy(query, {
      empresaId: 'empresa-1',
      status: 'todos',
      search: '#4079',
    });

    expect(calls).toEqual([
      { method: 'is', args: ['deleted_at', null] },
      { method: 'eq', args: ['empresa_id', 'empresa-1'] },
      { method: 'or', args: ['numero_mapa.eq.4079'] },
    ]);
  });
});
