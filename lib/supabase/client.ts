import { createBrowserClient } from '@supabase/ssr';
import type { Database } from '@/lib/types/database';

/**
 * Cliente Supabase para uso em Client Components e código que roda no browser.
 * Lê NEXT_PUBLIC_SUPABASE_URL e NEXT_PUBLIC_SUPABASE_ANON_KEY.
 */
export function createClient() {
  // window.__SUPABASE_* é injetado pelo layout a partir do runtime do servidor (gateway local /
  // nuvem na Vercel). Prioriza ele sobre process.env pra nunca usar um valor assado no build.
  const url =
    (typeof window !== 'undefined' ? (window as Window & { __SUPABASE_URL__?: string }).__SUPABASE_URL__ : '') ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    '';
  const key =
    (typeof window !== 'undefined' ? (window as Window & { __SUPABASE_ANON_KEY__?: string }).__SUPABASE_ANON_KEY__ : '') ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    '';
  return createBrowserClient<Database>(url, key);
}
