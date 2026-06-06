import { describe, it, expect } from 'vitest';
import {
  parseClientesCsv,
  montarEndereco,
  soDigitos,
  cnpjCpfValido,
} from './import-csv';

describe('cnpjCpfValido', () => {
  it('aceita 11 (CPF) e 14 (CNPJ) dígitos não-repetidos', () => {
    expect(cnpjCpfValido('52948285968')).toBe(true);
    expect(cnpjCpfValido('86437639000154')).toBe(true);
  });
  it('rejeita tamanho errado e sequências repetidas (dummy)', () => {
    expect(cnpjCpfValido('0')).toBe(false);
    expect(cnpjCpfValido('00000000000')).toBe(false);
    expect(cnpjCpfValido('11111111111')).toBe(false);
    expect(cnpjCpfValido('123')).toBe(false);
  });
});

describe('soDigitos', () => {
  it('mantém só dígitos', () => {
    expect(soDigitos('289.395.828-10')).toBe('28939582810');
    expect(soDigitos('86.437.639/0001-54')).toBe('86437639000154');
    expect(soDigitos(null)).toBe('');
  });
});

describe('montarEndereco', () => {
  it('junta logradouro + numero + complemento', () => {
    expect(montarEndereco('RUA FRANKLIN CASCAES', '331', 'FUNDOS')).toBe(
      'RUA FRANKLIN CASCAES, 331 - FUNDOS',
    );
  });
  it('trata SN/placeholders como vazio', () => {
    expect(montarEndereco('AV LUIZ BOITEUX PIAZZA', 'SN', '')).toBe('AV LUIZ BOITEUX PIAZZA');
    expect(montarEndereco('<SEM ENDERECO>', 'SN', '')).toBeNull();
  });
});

describe('parseClientesCsv', () => {
  it('parseia cabeçalho padrão e ignora colunas extras', () => {
    const csv = [
      'CODIGO;FANTASIA;RG;CNPJCPF;cliente;fornecedor;IE;CIDADE;UF;logradouro;NUMERO;BAIRRO;COMPLEMENTO;CEP;COD_IBGE;EMAIL;LIMITE;FONE1;FONE2;SEXO',
      '21875;RUTH ELISA LUDERS;;529.482.859-68;sim;;;FLORIANOPOLIS;SC;RODOVIA TERTULIANO BRITO XAVIER;3754;JURERE;;88054601;4205407;;0;48996483074;;masculino',
    ].join('\n');
    const r = parseClientesCsv(csv);
    expect(r.totalLinhas).toBe(1);
    expect(r.clientes).toHaveLength(1);
    const c = r.clientes[0];
    expect(c.nome).toBe('RUTH ELISA LUDERS');
    expect(c.cnpj_cpf).toBe('529.482.859-68');
    expect(c.cidade).toBe('FLORIANOPOLIS');
    expect(c.uf).toBe('SC');
    expect(c.cep).toBe('88054601');
    expect(c.telefone).toBe('48996483074');
    expect(c.enderecos).toHaveLength(1);
    expect(c.enderecos[0]).toMatchObject({
      rotulo: 'Principal',
      endereco: 'RODOVIA TERTULIANO BRITO XAVIER, 3754',
      bairro: 'JURERE',
      is_padrao: true,
    });
  });

  it('lê cabeçalho variante (LOGADOURO, E_CLIENTE, OBSGERAL)', () => {
    const csv = [
      'CODIGO;FANTASIA;CNPJCPF;E_CLIENTE;E_FORNECEDOR;IE;CIDADE;UF;LOGADOURO;NUMERO;BAIRRO;COMPLEMENTO;CEP;COD_IBGE;EMAIL;LIMITE;FONE1;FONE2;OBSGERAL',
      '24417;JAIRO RODRIGUES SILVA;073.748.989-83;sim;;;FLORIANOPOLIS;SC;AVENIDA LUIZ BOITEUX PIAZZA;6957;CACHOEIRA DO BOM JES;;88056001;4205407;;0;;48988047596;',
    ].join('\n');
    const r = parseClientesCsv(csv);
    expect(r.clientes).toHaveLength(1);
    expect(r.clientes[0].enderecos[0].endereco).toBe('AVENIDA LUIZ BOITEUX PIAZZA, 6957');
    expect(r.clientes[0].telefone).toBe('48988047596'); // fone2 quando fone1 vazio
  });

  it('mescla MESMO CPF/CNPJ em 1 cliente com vários endereços', () => {
    const csv = [
      'CODIGO;FANTASIA;CNPJCPF;CIDADE;UF;logradouro;NUMERO;BAIRRO;CEP;FONE1;FONE2',
      '100;MARIA SOUZA;529.482.859-68;FLORIANOPOLIS;SC;RUA A;10;CENTRO;88000000;4811111111;',
      '101;MARIA SOUZA;52948285968;FLORIANOPOLIS;SC;RUA B;20;TRINDADE;88010000;;4822222222',
    ].join('\n');
    const r = parseClientesCsv(csv);
    expect(r.clientes).toHaveLength(1);
    expect(r.mesclados).toBe(1);
    expect(r.enderecosExtras).toBe(1);
    const c = r.clientes[0];
    expect(c.enderecos).toHaveLength(2);
    expect(c.enderecos.map((e) => e.rotulo)).toEqual(['Principal', 'Endereço 2']);
    expect(c.enderecos[0].is_padrao).toBe(true);
    expect(c.enderecos[1].is_padrao).toBe(false);
    // o cliente herda o endereço principal nos campos *_padrao
    expect(c.endereco).toBe('RUA A, 10');
    expect(c.bairro).toBe('CENTRO');
  });

  it('endereços idênticos do mesmo cliente são deduplicados', () => {
    const csv = [
      'CODIGO;FANTASIA;CNPJCPF;CIDADE;UF;logradouro;NUMERO;BAIRRO;CEP',
      '1;FULANO;111.444.777-35;FLN;SC;RUA X;5;CENTRO;88000000',
      '2;FULANO;11144477735;FLN;SC;RUA X;5;CENTRO;88000000',
    ].join('\n');
    const r = parseClientesCsv(csv);
    expect(r.clientes).toHaveLength(1);
    expect(r.clientes[0].enderecos).toHaveLength(1);
  });

  it('ignora linhas sem nome (lixo) e endereço placeholder', () => {
    const csv = [
      'CODIGO;FANTASIA;CNPJCPF;CIDADE;UF;logradouro;NUMERO;BAIRRO;CEP',
      '7307;;;FLORIANOPOLIS;SC;<SEM ENDERECO>;SN;< SEM BAIRRO >;88056000',
      '7308;CLIENTE OK;987.654.321-00;FLORIANOPOLIS;SC;<SEM ENDERECO>;SN;< SEM BAIRRO >;88056000',
    ].join('\n');
    const r = parseClientesCsv(csv);
    expect(r.totalLinhas).toBe(2);
    expect(r.ignoradas).toBe(1);
    expect(r.clientes).toHaveLength(1);
    // linha com nome mas endereço todo placeholder → cliente sem endereço cadastrado
    expect(r.clientes[0].nome).toBe('CLIENTE OK');
    expect(r.clientes[0].enderecos).toHaveLength(0);
  });

  it('doc dummy (0, repetido) NÃO funde clientes distintos — cai na chave por código', () => {
    const csv = [
      'CODIGO;FANTASIA;CNPJCPF;CIDADE;UF;logradouro;NUMERO;BAIRRO;CEP',
      '500;ALFA;0;FLN;SC;RUA A;1;CENTRO;88000000',
      '501;BETA;0;FLN;SC;RUA B;2;CENTRO;88000001',
      '502;GAMA;00000000000;FLN;SC;RUA C;3;CENTRO;88000002',
    ].join('\n');
    const r = parseClientesCsv(csv);
    expect(r.clientes).toHaveLength(3); // não colapsou em 1
    expect(r.docsInvalidos).toBe(3);
    expect(r.mesclados).toBe(0);
    // doc inválido não é gravado (vira sem-doc)
    expect(r.clientes.every((c) => c.cnpj_cpf === null)).toBe(true);
    expect(r.clientes.map((c) => c.nome).sort()).toEqual(['ALFA', 'BETA', 'GAMA']);
  });

  it('linha com nº de colunas diferente do cabeçalho é pulada (campo com ; deslocaria tudo)', () => {
    const csv = [
      'CODIGO;FANTASIA;CNPJCPF;CIDADE;UF;logradouro;NUMERO;BAIRRO;CEP',
      '600;EMPRESA;A;LTDA;529.482.859-68;FLN;SC;RUA Z;9;CENTRO;88000000', // FANTASIA com ; → colunas a mais
      '601;CLIENTE BOM;168.426.054-09;FLN;SC;RUA Y;8;CENTRO;88000003',
    ].join('\n');
    const r = parseClientesCsv(csv);
    expect(r.malformadas).toBe(1);
    expect(r.clientes).toHaveLength(1);
    expect(r.clientes[0].nome).toBe('CLIENTE BOM');
  });

  it('sem CPF/CNPJ: chaveia por código (não mescla códigos distintos)', () => {
    const csv = [
      'CODIGO;FANTASIA;CNPJCPF;CIDADE;UF;logradouro;NUMERO;BAIRRO;CEP',
      '900;SEM DOC UM;;FLN;SC;RUA P;1;CENTRO;88000000',
      '901;SEM DOC DOIS;;FLN;SC;RUA Q;2;CENTRO;88000001',
    ].join('\n');
    const r = parseClientesCsv(csv);
    expect(r.clientes).toHaveLength(2);
    expect(r.mesclados).toBe(0);
  });
});
