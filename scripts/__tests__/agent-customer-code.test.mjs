import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('../../agent/ExpedAgent/PayloadBuilder.cs', import.meta.url),
  'utf8',
);

describe('payload do agente Hiper', () => {
  it('envia o id da entidade como codigo estavel do cliente', () => {
    expect(source).toMatch(/ClienteCodigo\s*=.*h\.IdEntidadeCliente\.ToString/);
  });
});
