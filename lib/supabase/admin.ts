import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/types/database';

/**
 * Client com service_role — IGNORA RLS. Usar SOMENTE em código server-side
 * confiável (ex.: endpoint de ingestão autenticado por segredo, onboarding de
 * empresa). NUNCA expor ao browser nem importar em componente client.
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE service_role não configurado (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
  }
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
