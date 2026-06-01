// lib/provisioning/__tests__/code.test.ts
import { describe, it, expect } from 'vitest';
import { gerarCodigoInstalacao, hashCodigo, normalizeCodigo } from '../code';

describe('código de instalação', () => {
  it('gera no formato EXPED-XXXX-XXXX sem caracteres ambíguos', () => {
    const { raw } = gerarCodigoInstalacao();
    expect(raw).toMatch(/^EXPED-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(raw).not.toMatch(/[01OIL]/); // sem ambíguos
  });

  it('normaliza case e hífens antes de hashear', () => {
    expect(normalizeCodigo('exped-7k4p-2qxm')).toBe('EXPED7K4P2QXM');
    expect(hashCodigo('exped-7k4p-2qxm')).toBe(hashCodigo('EXPED 7K4P 2QXM'));
  });

  it('hash é sha256 hex determinístico e o raw casa com seu hash', () => {
    const { raw, hash } = gerarCodigoInstalacao();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCodigo(raw)).toBe(hash);
  });
});
