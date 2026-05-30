import type { CSSProperties } from 'react';

/**
 * Gera overrides do scale de cor "brand" a partir da cor primária do tenant (hex),
 * derivando os tons via color-mix. Aplicado inline num wrapper, re-tinta a UI por empresa.
 * Retorna undefined quando não há cor → mantém o default do globals.css intacto (zero regressão).
 */
export function brandVars(cor: string | null | undefined): CSSProperties | undefined {
  if (!cor || !/^#[0-9a-fA-F]{3,8}$/.test(cor.trim())) return undefined;
  const c = cor.trim();
  const vars: Record<string, string> = {
    '--color-brand': c,
    '--color-brand-50': `color-mix(in srgb, ${c} 12%, white)`,
    '--color-brand-100': `color-mix(in srgb, ${c} 25%, white)`,
    '--color-brand-500': c,
    '--color-brand-600': `color-mix(in srgb, ${c} 82%, black)`,
    '--color-brand-700': `color-mix(in srgb, ${c} 68%, black)`,
  };
  return vars as CSSProperties;
}
