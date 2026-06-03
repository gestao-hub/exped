import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { Database } from '@/lib/types/database';
import { supabaseUrl, supabaseAnonKey, supabaseServiceKey } from './env';

/**
 * Cliente Supabase para Server Components, Route Handlers e Server Actions.
 * Sempre criar um novo client por request (cookies podem mudar).
 */
export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient<Database>(
    supabaseUrl(),
    supabaseAnonKey(),
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (toSet) => {
          try {
            toSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
          } catch {
            // Server Components não podem setar cookies; será feito pelo middleware.
          }
        },
      },
    },
  );
}

/**
 * Cliente Supabase com a service_role key — bypassa RLS.
 * USAR SOMENTE em rotas server-side controladas (admin, seeders, webhooks).
 * Nunca expor essa instância para o cliente.
 */
export function createServiceRoleClient() {
  return createServerClient<Database>(
    supabaseUrl(),
    supabaseServiceKey(),
    {
      cookies: { getAll: () => [], setAll: () => {} },
    },
  );
}
