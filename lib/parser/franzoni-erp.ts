/**
 * Parser do PDF do ERP da Franzoni.
 *
 * Recebe o texto cru extraído do PDF (via pdf-parse) e devolve um objeto
 * estruturado. Os campos que o ERP não fornece (motorista, veículo, pesos)
 * ficam vazios para serem preenchidos pela logística.
 *
 * Convenções:
 *  - Datas BR (dd/mm/yyyy) → ISO (yyyy-mm-dd)
 *  - Números BR (1.234,56) → number (1234.56)
 *  - Multi-line tolerante: o pdf-parse pode juntar/quebrar linhas
 *    de jeitos diferentes, então quase tudo é regex sobre o texto inteiro.
 */

export type ItemParsed = {
  codigo: string;
  descricao: string;
  quantidade: number;
  unidade: string;
  preco_unitario: number;
  desconto: number;
  total: number;
  referencia?: string;
};

export type PontoRetiradaParsed = {
  tipo: 'loja' | 'deposito';
  empresa_nome: string;
  endereco?: string;
  itens: ItemParsed[];
};

export type ClienteParsed = {
  codigo?: string;
  nome: string;
  cnpj_cpf?: string;
  endereco?: string;
  bairro?: string;
  cidade?: string;
  uf?: string;
  cep?: string;
  telefone?: string;
};

export type PedidoParsed = {
  documento_erp?: string;
  data_emissao?: string;       // YYYY-MM-DD
  data_entrega?: string;       // YYYY-MM-DD
  empresa_emissora?: string;   // Nome da empresa que aparece no topo (ex.: AMY TESTE)
  cliente: ClienteParsed;
  pontos_retirada: PontoRetiradaParsed[];
  valor_total: number;
  forma_pagamento?: string;
  parcelas?: string;
  observacoes?: string;
};

// ---------------------------------------------------------------------------
// helpers numéricos / datas
// ---------------------------------------------------------------------------

/** "1.234,56" → 1234.56 ; "16,79" → 16.79 ; "" → 0 */
export function brNumber(raw: string | undefined | null): number {
  if (!raw) return 0;
  const cleaned = raw.trim().replace(/\./g, '').replace(',', '.');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

/** "14/05/2026" → "2026-05-14" */
export function brDate(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const m = raw.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return undefined;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function firstMatch(text: string, rx: RegExp): RegExpMatchArray | null {
  return text.match(rx);
}

// ---------------------------------------------------------------------------
// Regex (ancorados por linha quando possível)
// ---------------------------------------------------------------------------

const RX = {
  emissao:    /Data\s+de\s+emiss[aã]o\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i,
  entrega:    /Data\s+de\s+entrega\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i,
  documento:  /N[uú]mero\s+do\s+documento\s*:?\s*([A-Z0-9.\-]+)/i,
  // fallback: pega o "N. L4077" do cabeçalho se a linha "Número do documento" sumir
  documentoCab: /PEDIDO\s+DE\s+VENDA\s*-\s*N\.?\s*([A-Z0-9.\-]+)/i,
  cliente:    /Cliente\s+(\d+)\s*-\s*([^\n(]+?)\s*\(\s*([\d./-]+)\s*\)/i,
  // Endereço termina em CEP, Telefone, Produto ou fim — quebra sem precisar de \n
  // Usa [\s\S] em vez de . pra cobrir multilinha sem depender da flag /s (es2018+)
  endereco:   /Endere[cç]o\s*:\s*([\s\S]+?)(?=\s*(?:CEP\s*:|Telefone\s*:|Produto\b|$))/i,
  cep:        /CEP\s*:?\s*(\d{5}-?\d{3})\s*-\s*([^-\n]+?)\s*-\s*([A-Z]{2})\b/i,
  telefone:   /Telefone\s*:?\s*(\(?\d{2}\)?\s*\d{4,5}[-\s]?\d{4})/i,
  total:      /(?:^|\s)Total\s+([\d.]+,\d{2})(?=\s+Forma\s+de\s+Pagamento|\s*$|\s*\n)/i,
  formaPagto: /Forma\s+de\s+Pagamento\s*:?\s*([\s\S]+?)(?=\s*(?:Observa[cç][aã]o\s*:|É\s+vedada|$))/i,
  observacao: /Observa[cç][aã]o\s*:?\s*([\s\S]+?)(?=\s*(?:É\s+vedada|$))/i,
  // item: cód + descrição + " - " + qtd + unidade + 3 valores monetários
  item:       /^(\d{3,})\s+(.+?)\s+-\s+(\d+(?:[.,]\d+)?)\s+([A-Z]{1,3})\s+([\d.]+,\d{2})\s+([\d.]+,\d{2})\s+([\d.]+,\d{2})\s*$/gm,
  refDiversos:/^\s*(Diversos\s*\([^)]*\))\s*$/im,
};

// ---------------------------------------------------------------------------
// extrai cliente (multi-linha: cliente + endereço + cep + telefone)
// ---------------------------------------------------------------------------

function parseCliente(text: string): ClienteParsed {
  const out: ClienteParsed = { nome: '' };

  const m = firstMatch(text, RX.cliente);
  if (m) {
    out.codigo   = m[1];
    out.nome     = m[2].trim();
    out.cnpj_cpf = m[3].trim();
  }

  const e = firstMatch(text, RX.endereco);
  if (e) {
    // ex.: "Rua Tucano, 389 - - Forquilhas"  (complemento vazio)
    //      "Rua X, 10 - Apto 5 - Centro"     (com complemento)
    // Split tolerante a hifens grudados (sem espaço entre eles); descarta vazios.
    const raw = e[1].trim();
    const parts = raw.split(/\s*-\s*/).map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2) {
      out.bairro   = parts[parts.length - 1];
      out.endereco = parts.slice(0, parts.length - 1).join(' - ');
    } else {
      out.endereco = raw;
    }
  }

  const c = firstMatch(text, RX.cep);
  if (c) {
    out.cep    = c[1].replace(/-/g, '').replace(/(\d{5})(\d{3})/, '$1-$2');
    out.cidade = c[2].trim();
    out.uf     = c[3].trim();
  }

  const t = firstMatch(text, RX.telefone);
  if (t) {
    out.telefone = t[1].trim();
  }

  return out;
}

// ---------------------------------------------------------------------------
// extrai itens (uma linha por item, opcionalmente seguido por Diversos (Ref. X))
// ---------------------------------------------------------------------------

function parseItens(text: string): ItemParsed[] {
  const itens: ItemParsed[] = [];
  // Resetar lastIndex porque o regex tem flag /g e mantém estado
  RX.item.lastIndex = 0;
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^(\d{3,})\s+(.+?)\s+-\s+(\d+(?:[.,]\d+)?)\s+([A-Z]{1,3})\s+([\d.]+,\d{2})\s+([\d.]+,\d{2})\s+([\d.]+,\d{2})\s*$/);
    if (!m) continue;

    const item: ItemParsed = {
      codigo:         m[1],
      descricao:      m[2].trim(),
      quantidade:     brNumber(m[3]),
      unidade:        m[4],
      preco_unitario: brNumber(m[5]),
      desconto:       brNumber(m[6]),
      total:          brNumber(m[7]),
    };

    // próxima linha pode ser "Diversos (Ref. X)" — captura como referência
    const next = lines[i + 1]?.trim();
    if (next) {
      const refM = next.match(/^Diversos\s*\(\s*Ref\.?\s*([^)]*?)\s*\)\s*$/i);
      if (refM) {
        item.referencia = refM[1].trim() || 'Diversos';
        i++; // consome a linha de ref
      }
    }

    itens.push(item);
  }

  return itens;
}

// ---------------------------------------------------------------------------
// extrai forma de pagamento ("ENTREGA A RECEBER 10x" → forma + parcelas)
// ---------------------------------------------------------------------------

function parseFormaPagamento(text: string): { forma_pagamento?: string; parcelas?: string } {
  const m = firstMatch(text, RX.formaPagto);
  if (!m) return {};
  const raw = m[1].trim();
  // trailing "10x" / "1x" / "12x" = parcelas
  const pm = raw.match(/^(.*?)\s+(\d+x)\s*$/);
  if (pm) {
    return { forma_pagamento: pm[1].trim(), parcelas: pm[2] };
  }
  return { forma_pagamento: raw };
}

// ---------------------------------------------------------------------------
// parser principal
// ---------------------------------------------------------------------------

/**
 * unpdf devolve a página inteira numa "wall of text" sem quebras de linha.
 * pdf-parse devolvia com quebras. Esta normalização insere \n antes de
 * cabeçalhos conhecidos pra os regex line-based continuarem funcionando.
 */
function normalizeBreaks(text: string): string {
  const markers = [
    'Data de emissão',
    'Data de entrega',
    'Número do documento',
    'Identificação do destinatário',
    'Cliente ',
    'Endereço:',
    'CEP:',
    'Telefone:',
    'Produto Quantidade',
    'Meios de pagamento',
    'Forma de Pagamento:',
    'Observação:',
    'É vedada',
  ];
  let out = text;
  for (const m of markers) {
    out = out.split(m).join(`\n${m}`);
  }
  // Cabeçalho da tabela e primeiro item ficam grudados em wall-of-text;
  // insere \n após o "Total" do cabeçalho (último Total antes do código)
  out = out.replace(/(Produto\s+Quantidade[^\n]*?Total)\s+(?=\d{3,}\s+\S)/g, '$1\n');
  // Entre itens: <num>,<dd> seguido de espaço + código (3+ dígitos)
  out = out.replace(/(\d+[.,]\d{2})\s+(?=\d{3,}\s+\S)/g, '$1\n');
  // "Diversos (Ref. ...)" sempre numa linha própria
  out = out.replace(/\s+(Diversos\s*\(\s*Ref\.?)/g, '\n$1');
  // "Total <valor>" final (após itens) numa linha própria
  out = out.replace(/\s+(Total\s+\d+[.,]\d{2})/g, '\n$1');
  return out;
}

export function parseFranzoniErp(text: string): PedidoParsed {
  const normalized = normalizeBreaks(text.replace(/ /g, ' '));

  // empresa emissora: primeira linha não-vazia, cortando ao chegar em
  // termos típicos de endereço (AVENIDA/RUA/AV./R./TRAVESSA), CNPJ, FONE
  // ou caracteres separadores. Cap em 100 chars como segurança final.
  const empresa_emissora = (() => {
    const firstLine = normalized
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? '';
    // Termina antes de palavras-chave de endereço/identificação ou separadores
    const m = firstLine.match(
      /^(.+?)(?=\s+(?:AVENIDA|AV\.?|RUA|R\.?|TRAVESSA|TV\.?|RODOVIA|ROD\.?|ALAMEDA|AL\.?|ESTRADA|EST\.?|CNPJ|CPF|FONE|TEL|DOCUMENTO|PEDIDO)\b|[,;]|\s+-\s+|$)/i,
    );
    const name = (m?.[1] ?? firstLine).trim();
    return name.length > 100 ? name.slice(0, 100).trim() : name;
  })();

  const documento_erp =
    firstMatch(normalized, RX.documento)?.[1] ??
    firstMatch(normalized, RX.documentoCab)?.[1];

  const data_emissao = brDate(firstMatch(normalized, RX.emissao)?.[1]);
  const data_entrega = brDate(firstMatch(normalized, RX.entrega)?.[1]);

  const cliente = parseCliente(normalized);

  const itens = parseItens(normalized);

  const valor_total = brNumber(firstMatch(normalized, RX.total)?.[1]);

  const { forma_pagamento, parcelas } = parseFormaPagamento(normalized);

  const observacoes = firstMatch(normalized, RX.observacao)?.[1]?.trim();

  // Sempre devolve 1 ponto de retirada por padrão.
  // Quando o ERP gerar um PDF com múltiplos pontos (LOJA + DEPÓSITO),
  // estender aqui detectando blocos delimitados (ex.: "Empresa 1 -", "Empresa 2 -").
  const pontos_retirada: PontoRetiradaParsed[] = [
    {
      tipo: 'loja',
      empresa_nome: empresa_emissora ?? '',
      endereco: cliente.endereco,
      itens,
    },
  ];

  return {
    documento_erp,
    data_emissao,
    data_entrega,
    empresa_emissora,
    cliente,
    pontos_retirada,
    valor_total,
    forma_pagamento,
    parcelas,
    observacoes,
  };
}
