import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { brDate, brNumber, parseHiperErp } from './hiper-erp';

const fixture = readFileSync(
  resolve(__dirname, '../../tests/fixtures/pedido-L4077.txt'),
  'utf-8',
);

// L4079: PDF real (unpdf wall-of-text) com variações que quebravam o parser:
//  - CNPJ/CPF vazio "()"
//  - referência "Diversos (Ref.NNNN)" INLINE entre descrição e quantidade
//  - "Forma de Pagamento:" vazio seguido direto de "Observação:"
const fixtureL4079 = readFileSync(
  resolve(__dirname, '../../tests/fixtures/pedido-L4079.txt'),
  'utf-8',
);

describe('helpers', () => {
  it('brNumber: aceita BR e devolve 0 para vazio', () => {
    expect(brNumber('16,79')).toBe(16.79);
    expect(brNumber('1.234,56')).toBe(1234.56);
    expect(brNumber('0,00')).toBe(0);
    expect(brNumber(null)).toBe(0);
    expect(brNumber('')).toBe(0);
  });

  it('brDate: dd/mm/yyyy → yyyy-mm-dd', () => {
    expect(brDate('14/05/2026')).toBe('2026-05-14');
    expect(brDate('14/05/2026 16:18')).toBe('2026-05-14');
    expect(brDate('')).toBeUndefined();
  });
});

describe('parseHiperErp — fixture pedido L4077', () => {
  const r = parseHiperErp(fixture);

  it('documento e datas', () => {
    expect(r.documento_erp).toBe('L4077');
    expect(r.data_emissao).toBe('2026-05-14');
    expect(r.data_entrega).toBe('2026-05-14');
  });

  it('empresa emissora', () => {
    expect(r.empresa_emissora).toBe('AMY TESTE');
  });

  it('cliente', () => {
    expect(r.cliente.codigo).toBe('103');
    expect(r.cliente.nome).toBe('START SERVICE LTDA');
    expect(r.cliente.cnpj_cpf).toBe('44.531.186/0001-80');
    expect(r.cliente.endereco).toBe('Rua Tucano, 389');
    expect(r.cliente.bairro).toBe('Forquilhas');
    expect(r.cliente.cep).toBe('88107-315');
    expect(r.cliente.cidade).toBe('SÃO JOSÉ');
    expect(r.cliente.uf).toBe('SC');
    expect(r.cliente.telefone).toBe('(48) 9852-2514');
  });

  it('pontos de retirada e itens', () => {
    expect(r.pontos_retirada).toHaveLength(1);
    const p = r.pontos_retirada[0];
    expect(p.tipo).toBe('loja');
    expect(p.empresa_nome).toBe('AMY TESTE');
    expect(p.itens).toHaveLength(1);

    const it = p.itens[0];
    expect(it.codigo).toBe('5005');
    expect(it.descricao).toBe('SH CONDIC. HOMEM VERSATIL 2 EM 1 350 ML');
    expect(it.quantidade).toBe(1);
    expect(it.unidade).toBe('UN');
    expect(it.preco_unitario).toBe(16.79);
    expect(it.desconto).toBe(0);
    expect(it.total).toBe(16.79);
    expect(it.referencia).toBe('Diversos');
  });

  it('totais e pagamento', () => {
    expect(r.valor_total).toBe(16.79);
    expect(r.forma_pagamento).toBe('ENTREGA A RECEBER');
    expect(r.parcelas).toBe('10x');
  });

  it('observação', () => {
    expect(r.observacoes).toBe('ENTREGAR EM UMA CASA COM UM FUSCA VERMELHO');
  });
});

describe('robustez', () => {
  it('texto vazio → defaults seguros', () => {
    const r = parseHiperErp('');
    expect(r.cliente.nome).toBe('');
    expect(r.pontos_retirada).toHaveLength(1);
    expect(r.pontos_retirada[0].itens).toHaveLength(0);
    expect(r.valor_total).toBe(0);
    expect(r.documento_erp).toBeUndefined();
  });

  it('número com milhar BR', () => {
    const r = parseHiperErp(`Total 1.234,56\n`);
    expect(r.valor_total).toBe(1234.56);
  });

  it('texto wall-of-text (estilo unpdf) — normaliza quebras', () => {
    // Mesmo conteúdo do fixture mas sem quebras de linha
    const wall = fixture.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
    const r = parseHiperErp(wall);
    expect(r.documento_erp).toBe('L4077');
    expect(r.cliente.nome).toBe('START SERVICE LTDA');
    expect(r.cliente.bairro).toBe('Forquilhas');
    // bairro NÃO pode conter texto da tabela de itens
    expect(r.cliente.bairro?.length).toBeLessThan(50);
    expect(r.valor_total).toBe(16.79);
    expect(r.pontos_retirada[0].itens).toHaveLength(1);
    expect(r.pontos_retirada[0].itens[0].codigo).toBe('5005');
  });
});

describe('parseHiperErp — fixture pedido L4079 (variações do ERP real)', () => {
  const r = parseHiperErp(fixtureL4079);

  it('cliente com CNPJ/CPF vazio "()" — ainda extrai código e nome', () => {
    expect(r.cliente.codigo).toBe('91');
    expect(r.cliente.nome).toBe('BRUNO BOVO');
    expect(r.cliente.cnpj_cpf).toBeUndefined();
    expect(r.cliente.cidade).toBe('APUCARANA');
    expect(r.cliente.uf).toBe('PR');
    expect(r.cliente.bairro).toBe('Jardim Tibagi');
  });

  it('item com "Diversos (Ref.NNNN)" inline entre descrição e quantidade', () => {
    expect(r.pontos_retirada[0].itens).toHaveLength(1);
    const item = r.pontos_retirada[0].itens[0];
    expect(item.codigo).toBe('3028');
    expect(item.descricao).toBe('REFRIGERANTE COCA-COLA 2L');
    expect(item.quantidade).toBe(1);
    expect(item.unidade).toBe('UN');
    expect(item.preco_unitario).toBe(8.52);
    expect(item.total).toBe(8.52);
    expect(item.referencia).toBe('56578');
  });

  it('Forma de Pagamento vazio não engole a Observação', () => {
    expect(r.forma_pagamento).toBeUndefined();
    expect(r.parcelas).toBeUndefined();
    expect(r.observacoes).toBe('LEONARDO VIADAO');
  });

  it('documento e valor total', () => {
    expect(r.documento_erp).toBe('L4079');
    expect(r.valor_total).toBe(8.52);
  });
});

// Hiper NOVO (Franzoni go-live, doc L001000001013). Layout diferente que zerava itens:
//  - linha de item SEM " - " antes da qtd ("<desc> <qtd> UN ...") — antes exigia o " - "
//  - " - " aparece DENTRO do nome ("VASSOURA ... - DTOOLS 1 PC ...") — não é separador
//  - rodapé "Totais <qtd> <desc> <valor>" em vez de "Total <valor>"
//  - sem linha "Forma de Pagamento:" (vem embutida na Observação)
const fixtureHiperNovo = readFileSync(
  resolve(__dirname, '../../tests/fixtures/pedido-L001000001013-hiper-novo.txt'),
  'utf-8',
);

describe('parseHiperErp — fixture Hiper novo (L001000001013)', () => {
  const r = parseHiperErp(fixtureHiperNovo);

  it('extrai os 3 itens mesmo sem " - " antes da qtd', () => {
    const itens = r.pontos_retirada[0].itens;
    expect(itens).toHaveLength(3);

    expect(itens[0].codigo).toBe('1301');
    expect(itens[0].descricao).toBe('TELHA 4MM 2,44X0,50 ETERNIT');
    expect(itens[0].quantidade).toBe(2);
    expect(itens[0].unidade).toBe('UN');
    expect(itens[0].total).toBe(41.8);

    // " - DTOOLS" é parte do NOME, não separador → fica na descrição
    expect(itens[1].codigo).toBe('23632');
    expect(itens[1].descricao).toBe('VASSOURA GARI 28CM FIO LONGO - DTOOLS');
    expect(itens[1].unidade).toBe('PC');

    expect(itens[2].codigo).toBe('4504');
    expect(itens[2].quantidade).toBe(2);
    expect(itens[2].total).toBe(85);
  });

  it('valor total vem do rodapé "Totais"', () => {
    expect(r.valor_total).toBe(195.9);
  });

  it('documento e cliente', () => {
    expect(r.documento_erp).toBe('L001000001013');
    expect(r.cliente.nome).toBe('CLIENTE EXEMPLO LTDA');
  });
});
