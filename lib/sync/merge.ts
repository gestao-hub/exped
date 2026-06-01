/**
 * Merge campo-a-campo (puro). A nuvem é a autoridade de merge.
 *
 * Por coluna, vence o lado cujo `field_updated_at[col]` é mais recente (ISO 8601,
 * comparável lexicograficamente em UTC). Em empate, favorece `local` (incoming do
 * hub) — escolha determinística pra convergência multi-site.
 *
 * O `field_updated_at` resultante é o máximo por coluna entre os dois lados.
 */

export type SyncRow = Record<string, unknown> & {
  field_updated_at?: Record<string, string>;
};

export function mergeRow(local: SyncRow, remote: SyncRow): SyncRow {
  const lf = local.field_updated_at ?? {};
  const rf = remote.field_updated_at ?? {};
  const out: SyncRow = { ...remote };
  const fua: Record<string, string> = { ...rf };

  for (const k of Object.keys({ ...local, ...remote })) {
    if (k === 'field_updated_at') continue;
    const lt = lf[k] ?? '';
    const rt = rf[k] ?? '';
    if (lt >= rt) {
      out[k] = local[k];
      if (lt) fua[k] = lt;
    } else {
      out[k] = remote[k];
      fua[k] = rt;
    }
  }

  out.field_updated_at = fua;
  return out;
}
