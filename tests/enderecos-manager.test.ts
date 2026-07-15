import { describe, expect, it } from 'vitest';
import { deriveEnderecosManagerView } from '@/components/clientes/enderecos-manager';

describe('deriveEnderecosManagerView', () => {
  it('oculta enderecos antigos e mostra loading quando clienteId muda', () => {
    const enderecoDoClienteA = { id: 'endereco-a' };

    expect(
      deriveEnderecosManagerView('cliente-a', 'cliente-a', [enderecoDoClienteA], false),
    ).toEqual({
      enderecos: [enderecoDoClienteA],
      loading: false,
    });
    expect(
      deriveEnderecosManagerView('cliente-b', 'cliente-a', [enderecoDoClienteA], false),
    ).toEqual({
      enderecos: [],
      loading: true,
    });
  });
});
