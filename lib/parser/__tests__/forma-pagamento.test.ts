// lib/parser/__tests__/forma-pagamento.test.ts
import { describe, it, expect } from 'vitest';
import { mapFormaPagamento, parseParcelas, rotuloFormaPagamento } from '../forma-pagamento';

describe('mapFormaPagamento', () => {
  it('mapeia textos do Hiper para o enum', () => {
    expect(mapFormaPagamento('Cartão de Crédito')).toBe('credito');
    expect(mapFormaPagamento('PIX')).toBe('pix');
    expect(mapFormaPagamento('Débito')).toBe('debito');
    expect(mapFormaPagamento('Dinheiro 1x')).toBe('dinheiro');
    expect(mapFormaPagamento('BOLETO BANCARIO')).toBe('boleto');
  });
  it('não reconhecido vira null', () => {
    expect(mapFormaPagamento('ENTREGA A RECEBER')).toBeNull();
    expect(mapFormaPagamento('')).toBeNull();
    expect(mapFormaPagamento(null)).toBeNull();
  });
});

describe('parseParcelas', () => {
  it('extrai dígitos e faz clamp 1..12', () => {
    expect(parseParcelas('10x')).toBe(10);
    expect(parseParcelas('3')).toBe(3);
    expect(parseParcelas('24x')).toBe(12);   // clamp
    expect(parseParcelas('0')).toBeNull();
    expect(parseParcelas('à vista')).toBeNull();
    expect(parseParcelas(null)).toBeNull();
  });
});

describe('rotuloFormaPagamento', () => {
  it('formata p/ exibição', () => {
    expect(rotuloFormaPagamento('credito', 3)).toBe('Crédito 3x');
    expect(rotuloFormaPagamento('pix', null)).toBe('Pix');
    expect(rotuloFormaPagamento(null, null)).toBe('—');
  });
});
