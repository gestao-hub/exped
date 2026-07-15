import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/types/database';

type ClienteUpsertInput = {
  cnpj_cpf?: string | null;
  codigo_erp?: string | null;
  nome: string;
  endereco?: string | null;
  bairro?: string | null;
  cidade?: string | null;
  uf?: string | null;
  cep?: string | null;
  telefone?: string | null;
};

/**
 * Acha um cliente pelo CNPJ/CPF (chave natural) ou cria um novo.
 * Devolve { id, criou } pra UI poder mostrar feedback ("cliente novo" vs
 * "reutilizando cadastro existente").
 *
 * Estratégia:
 *  - Se tem CNPJ/CPF, é a chave. Procura por isso e cria se não achar.
 *  - Se NÃO tem CNPJ/CPF, sempre cria novo (não dá pra desambiguar por nome).
 *  - Nome do cadastro existente NÃO é sobrescrito (admin edita manual).
 */
export async function upsertCliente(
  supabase: SupabaseClient<Database>,
  input: ClienteUpsertInput,
  empresaId?: string,
): Promise<{ id: string; criou: boolean }> {
  const cnpj = input.cnpj_cpf?.trim() || null;

  if (cnpj) {
    // Em sessão de usuário a RLS já escopa por empresa; no ingest (service_role,
    // sem RLS) precisamos escopar manualmente pra não casar cliente de outra empresa.
    let q = supabase
      .from('clientes')
      .select('id')
      .eq('cnpj_cpf', cnpj)
      .is('deleted_at', null);
    if (empresaId) q = q.eq('empresa_id', empresaId);
    const { data: existente } = await q.maybeSingle();
    if (existente) return { id: existente.id as string, criou: false };
  }

  const insertRow: Database['public']['Tables']['clientes']['Insert'] = {
    cnpj_cpf:        cnpj,
    codigo_erp:      input.codigo_erp ?? null,
    nome:            input.nome,
    endereco_padrao: input.endereco ?? null,
    bairro_padrao:   input.bairro ?? null,
    cidade_padrao:   input.cidade ?? null,
    uf_padrao:       input.uf ?? null,
    cep_padrao:      input.cep ?? null,
    telefone_padrao: input.telefone ?? null,
  };
  // Sessão: omitir → DEFAULT current_empresa_id() preenche. Ingest: explícito.
  if (empresaId) insertRow.empresa_id = empresaId;

  const { data: novo, error } = await supabase
    .from('clientes')
    .insert(insertRow)
    .select('id')
    .single();

  if (error || !novo) {
    throw new Error(`Falha ao criar cliente: ${error?.message ?? 'desconhecido'}`);
  }
  return { id: novo.id as string, criou: true };
}
