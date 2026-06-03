export const PAGE_SIZE = 50;

export type Paginacao = { from: number; to: number; totalPages: number; hasPrev: boolean; hasNext: boolean };

/**
 * Calcula o range pro `.range(from, to)` do supabase-js + flags de navegação.
 * Clampa `page` em [1, totalPages] (evita ficar preso numa página que não existe
 * mais quando um filtro reduz o total).
 */
export function calcularPaginacao(page: number, total: number, pageSize = PAGE_SIZE): Paginacao {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.min(Math.max(1, Math.floor(page) || 1), totalPages);
  const from = (p - 1) * pageSize;
  return { from, to: from + pageSize - 1, totalPages, hasPrev: p > 1, hasNext: p < totalPages };
}
