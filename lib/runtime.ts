import { supabaseUrl } from '@/lib/supabase/env';

/**
 * true se o app está rodando no HUB local (offline-first), false na nuvem.
 * O hub aponta o Supabase pro gateway local (127.0.0.1); a nuvem usa a URL real.
 * `EXPED_HUB=1` (setado pelo maestro do hub) é um override explícito de robustez.
 *
 * Uso: gestão de identidade (colaboradores) só pode escrever na NUVEM (fonte da
 * verdade); no hub a tela fica read-only — identidade só desce pelo sync.
 */
export function isHub(): boolean {
  if (process.env.EXPED_HUB === '1') return true;
  const url = supabaseUrl();
  return url.includes('127.0.0.1') || url.includes('localhost');
}
