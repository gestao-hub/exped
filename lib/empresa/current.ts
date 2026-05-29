import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/types/database';

export type EmpresaAtual = {
  id: string;
  nome: string;
  slug: string;
  logo_url: string | null;
  cor_primaria: string | null;
};

/**
 * Carrega a empresa (tenant) do usuário logado — usada pro white-label
 * (nome/logo/cor). Devolve null se não houver usuário ou empresa associada.
 */
export async function getEmpresaAtual(
  supabase: SupabaseClient<Database>,
): Promise<EmpresaAtual | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: prof } = await supabase
    .from('profiles')
    .select('empresa_id')
    .eq('id', user.id)
    .single();
  if (!prof?.empresa_id) return null;

  const { data: emp } = await supabase
    .from('empresas')
    .select('id, nome, slug, logo_url, cor_primaria')
    .eq('id', prof.empresa_id)
    .single();

  return (emp as EmpresaAtual) ?? null;
}
