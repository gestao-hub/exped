/**
 * Parser/normalizador da base de clientes exportada do Hiper (CSV, separador `;`).
 *
 * Lida com as variações de cabeçalho entre exports ("logradouro" vs "LOGADOURO"
 * vs "LOGRADOURO", "cliente/fornecedor" vs "E_CLIENTE/E_FORNECEDOR", presença/ausência
 * de RG/SEXO/OBSGERAL) e mescla linhas do MESMO CPF/CNPJ num único cliente com
 * vários endereços (cliente_enderecos). Lógica pura — testável sem banco.
 */

export type ImportEndereco = {
  rotulo: string;
  endereco: string | null;
  bairro: string | null;
  cidade: string | null;
  uf: string | null;
  cep: string | null;
  telefone: string | null;
  is_padrao: boolean;
};

export type ImportCliente = {
  /** CNPJ/CPF como veio (formatado); a chave de merge é só os dígitos. */
  cnpj_cpf: string | null;
  codigo_erp: string | null;
  nome: string;
  telefone: string | null;
  // campos "padrão" (= endereço principal) usados pra preencher clientes.*_padrao
  endereco: string | null;
  bairro: string | null;
  cidade: string | null;
  uf: string | null;
  cep: string | null;
  enderecos: ImportEndereco[];
};

export type ImportResultado = {
  clientes: ImportCliente[];
  totalLinhas: number; // linhas de dados (sem o cabeçalho)
  ignoradas: number; // linhas sem nome (lixo)
  malformadas: number; // linhas com nº de colunas != cabeçalho (puladas)
  docsInvalidos: number; // linhas cujo CNPJ/CPF não vale como chave (tratado como sem-doc)
  mesclados: number; // clientes que apareceram em mais de 1 linha (CPF/CNPJ repetido)
  enderecosExtras: number; // endereços além do principal
};

// Mapeia um cabeçalho cru → chave canônica. Chave de busca é normalizada
// (sem acento, minúscula, só letras/dígitos), pra casar "COD_IBGE"→"codibge" etc.
const ALIASES: Record<string, string> = {
  codigo: 'codigo',
  fantasia: 'nome',
  cnpjcpf: 'cnpjcpf',
  cidade: 'cidade',
  uf: 'uf',
  logradouro: 'logradouro',
  logadouro: 'logradouro', // typo presente em alguns exports
  numero: 'numero',
  bairro: 'bairro',
  complemento: 'complemento',
  cep: 'cep',
  email: 'email',
  fone1: 'fone1',
  fone2: 'fone2',
};

function normKey(h: string): string {
  return h
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove diacríticos combinantes
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export function soDigitos(s: string | null | undefined): string {
  return (s ?? '').replace(/\D/g, '');
}

/**
 * CNPJ/CPF válido como CHAVE de merge: 11 (CPF) ou 14 (CNPJ) dígitos e não é
 * sequência repetida (0000…, 1111…). Docs dummy/placeholder do ERP (ex.: "0",
 * "00000000000") NÃO valem como chave — senão clientes distintos colapsariam num só.
 */
export function cnpjCpfValido(dig: string): boolean {
  if (dig.length !== 11 && dig.length !== 14) return false;
  if (/^(\d)\1+$/.test(dig)) return false;
  return true;
}

/** Trim + trata placeholders sujos do Hiper ("<SEM ENDERECO>", "SN", "-") como vazio. */
function limpar(v: string | null | undefined): string | null {
  const t = (v ?? '').trim();
  if (!t) return null;
  if (/^<.*>$/.test(t)) return null; // <SEM ENDERECO>, < SEM BAIRRO >
  if (/^sem\s+(endereco|endereço|bairro|numero|número)/i.test(t)) return null;
  if (t === '-' || t === '--') return null;
  return t;
}

/** Número de endereço: "SN" / "S/N" / "0" → vazio. */
function limparNumero(v: string | null | undefined): string | null {
  const t = limpar(v);
  if (!t) return null;
  if (/^s\/?n$/i.test(t)) return null;
  return t;
}

/** Monta o endereço de uma linha: "LOGRADOURO, NUMERO - COMPLEMENTO". */
export function montarEndereco(
  logradouro: string | null | undefined,
  numero: string | null | undefined,
  complemento: string | null | undefined,
): string | null {
  const log = limpar(logradouro);
  const num = limparNumero(numero);
  const comp = limpar(complemento);
  if (!log && !num && !comp) return null;
  let base = log ?? '';
  if (num) base = base ? `${base}, ${num}` : num;
  if (comp) base = base ? `${base} - ${comp}` : comp;
  return base || null;
}

/** Divide o CSV em { header[], rows[][] } usando `;`, ignorando linhas vazias. */
function parseLinhas(texto: string): { header: string[]; rows: string[][] } {
  const linhas = texto
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, '')) // tira espaços/CR à direita
    .filter((l) => l.trim() !== '');
  if (linhas.length === 0) return { header: [], rows: [] };
  const header = linhas[0].split(';').map((h) => h.trim());
  const rows = linhas.slice(1).map((l) => l.split(';'));
  return { header, rows };
}

/**
 * Parseia + mescla a base de clientes. Linhas com o mesmo CPF/CNPJ (só dígitos)
 * viram 1 cliente com vários endereços. Linhas sem CPF/CNPJ são chaveadas por
 * código; sem código, por nome. Linhas sem nome são ignoradas (lixo).
 */
export function parseClientesCsv(texto: string): ImportResultado {
  const { header, rows } = parseLinhas(texto);

  // Índice de cada chave canônica na linha (primeira ocorrência vence).
  const idx: Record<string, number> = {};
  header.forEach((h, i) => {
    const canon = ALIASES[normKey(h)];
    if (canon && !(canon in idx)) idx[canon] = i;
  });

  const get = (row: string[], key: string): string | null => {
    const i = idx[key];
    if (i == null) return null;
    return limpar(row[i]);
  };

  const mapa = new Map<string, ImportCliente>();
  const linhasPorChave = new Map<string, number>();
  let totalLinhas = 0;
  let ignoradas = 0;
  let malformadas = 0;
  let docsInvalidos = 0;

  for (const row of rows) {
    totalLinhas++;
    // Linha com nº de colunas != cabeçalho = campo com ';' não-escapado deslocou tudo.
    // Pula pra não ler CNPJ/cidade/cep da coluna errada (corrupção silenciosa).
    if (row.length !== header.length) {
      malformadas++;
      continue;
    }
    const nome = get(row, 'nome');
    if (!nome) {
      ignoradas++;
      continue;
    }
    const cnpjRaw = get(row, 'cnpjcpf');
    const codigo = get(row, 'codigo');
    const dig = soDigitos(cnpjRaw);
    const docOk = cnpjCpfValido(dig);
    if (cnpjRaw && !docOk) docsInvalidos++;
    // Doc inválido/dummy não vale como chave nem é gravado (vira sem-doc).
    const cnpjFinal = docOk ? cnpjRaw : null;
    const chave = (docOk ? dig : '') || (codigo ? `cod:${codigo}` : `nome:${nome.toLowerCase()}`);

    const telefone = get(row, 'fone1') ?? get(row, 'fone2');
    const endereco = montarEndereco(
      idx.logradouro != null ? row[idx.logradouro] : null,
      idx.numero != null ? row[idx.numero] : null,
      idx.complemento != null ? row[idx.complemento] : null,
    );
    const bairro = get(row, 'bairro');
    const cidade = get(row, 'cidade');
    const uf = (get(row, 'uf') ?? '').slice(0, 2) || null;
    const cep = soDigitos(get(row, 'cep')) || null;

    let cli = mapa.get(chave);
    if (!cli) {
      cli = {
        cnpj_cpf: cnpjFinal,
        codigo_erp: codigo,
        nome,
        telefone,
        endereco,
        bairro,
        cidade,
        uf,
        cep,
        enderecos: [],
      };
      mapa.set(chave, cli);
    } else if (!cli.telefone && telefone) {
      cli.telefone = telefone;
    }
    linhasPorChave.set(chave, (linhasPorChave.get(chave) ?? 0) + 1);

    // Adiciona o endereço se tiver logradouro ou bairro (CEP sozinho não é útil)
    // e não for duplicado.
    if (endereco || bairro) {
      const sig = `${endereco ?? ''}|${cep ?? ''}|${bairro ?? ''}`.toLowerCase();
      const jaTem = cli.enderecos.some(
        (e) => `${e.endereco ?? ''}|${e.cep ?? ''}|${e.bairro ?? ''}`.toLowerCase() === sig,
      );
      if (!jaTem) {
        cli.enderecos.push({
          rotulo: '', // definido depois
          endereco,
          bairro,
          cidade,
          uf,
          cep,
          telefone,
          is_padrao: false,
        });
      }
    }
  }

  // Rótulos + padrão: 1º = "Principal" (is_padrao), demais "Endereço N".
  let mesclados = 0;
  let enderecosExtras = 0;
  for (const [chave, cli] of mapa) {
    if ((linhasPorChave.get(chave) ?? 0) > 1) mesclados++;
    cli.enderecos.forEach((e, i) => {
      e.rotulo = i === 0 ? 'Principal' : `Endereço ${i + 1}`;
      e.is_padrao = i === 0;
    });
    if (cli.enderecos.length > 1) enderecosExtras += cli.enderecos.length - 1;
    // Garante que os campos *_padrao do cliente reflitam o endereço principal.
    const principal = cli.enderecos[0];
    if (principal) {
      cli.endereco = principal.endereco;
      cli.bairro = principal.bairro;
      cli.cidade = principal.cidade;
      cli.uf = principal.uf;
      cli.cep = principal.cep;
    }
  }

  return {
    clientes: [...mapa.values()],
    totalLinhas,
    ignoradas,
    malformadas,
    docsInvalidos,
    mesclados,
    enderecosExtras,
  };
}

/** Chave de identidade do cliente: dígitos do CNPJ/CPF → código → nome. */
export function chaveCliente(c: {
  cnpj_cpf: string | null;
  codigo_erp: string | null;
  nome: string;
}): string {
  const dig = soDigitos(c.cnpj_cpf);
  const docOk = cnpjCpfValido(dig);
  return (docOk ? dig : '') || (c.codigo_erp ? `cod:${c.codigo_erp}` : `nome:${c.nome.toLowerCase()}`);
}

function rerotular(c: ImportCliente): void {
  c.enderecos.forEach((e, i) => {
    e.rotulo = i === 0 ? 'Principal' : `Endereço ${i + 1}`;
    e.is_padrao = i === 0;
  });
  const p = c.enderecos[0];
  if (p) {
    c.endereco = p.endereco;
    c.bairro = p.bairro;
    c.cidade = p.cidade;
    c.uf = p.uf;
    c.cep = p.cep;
  }
}

/**
 * Mescla clientes de vários arquivos (os exports do Hiper se sobrepõem). Mesmo
 * CNPJ/CPF entre arquivos vira 1 cliente; endereços são acumulados e deduplicados.
 */
export function mergeClientes(grupos: ImportCliente[][]): ImportCliente[] {
  const mapa = new Map<string, ImportCliente>();
  for (const grupo of grupos) {
    for (const c of grupo) {
      const k = chaveCliente(c);
      const ex = mapa.get(k);
      if (!ex) {
        mapa.set(k, { ...c, enderecos: c.enderecos.map((e) => ({ ...e })) });
        continue;
      }
      if (!ex.telefone && c.telefone) ex.telefone = c.telefone;
      if (!ex.cnpj_cpf && c.cnpj_cpf) ex.cnpj_cpf = c.cnpj_cpf;
      for (const e of c.enderecos) {
        const sig = `${e.endereco ?? ''}|${e.cep ?? ''}|${e.bairro ?? ''}`.toLowerCase();
        const has = ex.enderecos.some(
          (x) => `${x.endereco ?? ''}|${x.cep ?? ''}|${x.bairro ?? ''}`.toLowerCase() === sig,
        );
        if (!has) ex.enderecos.push({ ...e });
      }
    }
  }
  const out = [...mapa.values()];
  out.forEach(rerotular);
  return out;
}
