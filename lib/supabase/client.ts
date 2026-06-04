import { createBrowserClient } from '@supabase/ssr';
import type { Database } from '@/lib/types/database';

/**
 * Cliente Supabase para uso em Client Components e código que roda no browser.
 * Resolve a URL/chave de window.__SUPABASE_* (injetado em runtime pelo layout) e,
 * como fallback, de NEXT_PUBLIC_SUPABASE_URL/ANON_KEY.
 */
export function createClient() {
  // window.__SUPABASE_* é injetado pelo layout a partir do runtime do servidor (gateway local /
  // nuvem na Vercel). Prioriza ele sobre process.env pra nunca usar um valor assado no build.
  // No hub (atrás do porteiro de rede), __SUPABASE_USE_ORIGIN__ manda usar a própria origem
  // (https://<ip-do-servidor>) — assim cada máquina da LAN fala com o servidor certo. Na
  // nuvem, usa a URL injetada (__SUPABASE_URL__). Prioriza sobre process.env (nunca assado).
  const win =
    typeof window !== 'undefined'
      ? (window as Window & { __SUPABASE_URL__?: string; __SUPABASE_USE_ORIGIN__?: boolean })
      : undefined;
  const url =
    (win?.__SUPABASE_USE_ORIGIN__ ? window.location.origin : win?.__SUPABASE_URL__) ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    '';
  const key =
    (typeof window !== 'undefined' ? (window as Window & { __SUPABASE_ANON_KEY__?: string }).__SUPABASE_ANON_KEY__ : '') ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    '';
  return createBrowserClient<Database>(url, key);
}
