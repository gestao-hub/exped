import { describe, expect, it } from 'vitest';
import {
  HISTORICO_EXPORT_STATUS,
  HISTORICO_INITIAL_STATUS,
  historicoDetailDescription,
  pedidoStatusLabel,
} from '../historico';

describe('politica do historico', () => {
  it('abre em todos e exporta finalizados', () => {
    expect(HISTORICO_INITIAL_STATUS).toBe('todos');
    expect(HISTORICO_EXPORT_STATUS).toBe('finalizado');
  });

  it('descreve o status real sem afirmar finalizacao', () => {
    expect(pedidoStatusLabel('em_separacao')).toBe('Em separação');
    expect(historicoDetailDescription('em_separacao')).toBe(
      'Status: Em separação. Somente leitura.',
    );
  });
});
