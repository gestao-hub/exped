export type PedidoSearchFilter =
  | { kind: 'vazio' }
  | { kind: 'numero_mapa'; value: number }
  | { kind: 'texto'; value: string };

export function parsePedidoSearch(raw: string): PedidoSearchFilter {
  const value = raw.trim();
  if (!value) return { kind: 'vazio' };

  const mapa = /^#(\d+)$/.exec(value);
  if (mapa) {
    const parsed = Number(mapa[1]);
    if (Number.isSafeInteger(parsed)) return { kind: 'numero_mapa', value: parsed };
  }

  return { kind: 'texto', value };
}

function quotePostgrestValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function buildPedidoTextSearchOr(text: string): string {
  const numero = /^(\d+)$/.exec(text);
  if (numero) {
    const numeroMapa = Number(numero[1]);
    if (Number.isSafeInteger(numeroMapa)) {
      const documentoPattern = quotePostgrestValue(`%${text}%`);
      return `numero_mapa.eq.${numeroMapa},documento_erp.ilike.${documentoPattern}`;
    }
  }

  const pattern = quotePostgrestValue(`%${text}%`);
  return ['cliente_nome', 'documento_erp', 'cliente_bairro']
    .map((column) => `${column}.ilike.${pattern}`)
    .join(',');
}

export function buildPedidoNumericSearchOr(numeroMapa: number): string {
  return `numero_mapa.eq.${numeroMapa}`;
}
