// lib/parser/forma-pagamento.ts
export const FORMAS_PAGAMENTO = ['credito', 'pix', 'debito', 'dinheiro', 'boleto'] as const;
export type FormaPagamento = (typeof FORMAS_PAGAMENTO)[number];

/** Só Crédito e Boleto aceitam parcelamento; os demais são 1x. */
export const FORMAS_COM_PARCELAS: ReadonlySet<FormaPagamento> = new Set(['credito', 'boleto']);

const ROTULOS: Record<FormaPagamento, string> = {
  credito: 'Crédito', pix: 'Pix', debito: 'Débito', dinheiro: 'Dinheiro', boleto: 'Boleto',
};

/** Texto livre (PDF do Hiper) → enum; não reconhecido → null. */
export function mapFormaPagamento(raw: string | null | undefined): FormaPagamento | null {
  if (!raw) return null;
  const s = raw.toLowerCase();
  if (s.includes('credito') || s.includes('crédito')) return 'credito';
  if (s.includes('pix')) return 'pix';
  if (s.includes('debito') || s.includes('débito')) return 'debito';
  if (s.includes('dinheiro') || s.includes('especie') || s.includes('espécie')) return 'dinheiro';
  if (s.includes('boleto')) return 'boleto';
  return null;
}

/** Texto livre ("10x") → inteiro 1..12; vazio/0/sem-dígito → null. */
export function parseParcelas(raw: string | number | null | undefined): number | null {
  if (raw == null) return null;
  const m = String(raw).match(/\d+/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(n, 12);
}

/** Rótulo amigável p/ o mapa: "Crédito 3x", "Pix", "—". */
export function rotuloFormaPagamento(forma: FormaPagamento | null | undefined, parcelas: number | null | undefined): string {
  if (!forma) return '—';
  const base = ROTULOS[forma];
  return FORMAS_COM_PARCELAS.has(forma) && parcelas && parcelas > 1 ? `${base} ${parcelas}x` : base;
}
