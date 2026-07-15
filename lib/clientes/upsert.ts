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

type IngestClienteResolution = { id: string; criou: boolean };
type IngestClienteRpcClient = {
  rpc(
    name: 'resolve_cliente_ingest',
    args: { p_empresa: string; p_cliente: ClienteUpsertInput },
  ): Promise<{ data: unknown; error: { message?: string } | null }>;
};

/**
 * Acha um cliente pelo CNPJ/CPF (chave natural) ou cria um novo.
 * Devolve { id, criou } pra UI poder mostrar feedback ("cliente novo" vs
 * "reutilizando cadastro existente").
 *
 * Estratégia:
 *  - Sessão de usuário: CNPJ/CPF é a chave; sem documento, cria novo.
 *  - Ingest: a RPC resolve por documento normalizado ou código ERP e serializa a criação.
 *  - Nome do cadastro existente NÃO é sobrescrito (admin edita manual).
 */
export async function upsertCliente(
  supabase: SupabaseClient<Database>,
  input: ClienteUpsertInput,
  empresaId?: string,
): Promise<{ id: string; criou: boolean }> {
  const cnpj = input.cnpj_cpf?.trim() || null;
  const codigo = input.codigo_erp?.trim() || null;

  // O ingest usa service_role e sempre informa a empresa. A RPC serializa pela
  // chave natural, normaliza CPF/CNPJ e impede duas requisicoes concorrentes de
  // criarem cadastros diferentes para o mesmo cliente.
  if (empresaId) {
    const { data, error } = await (supabase as unknown as IngestClienteRpcClient).rpc(
      'resolve_cliente_ingest',
      {
        p_empresa: empresaId,
        p_cliente: { ...input, cnpj_cpf: cnpj, codigo_erp: codigo },
      },
    );
    if (error) throw new Error(`Falha ao resolver cliente: ${error.message ?? 'desconhecido'}`);
    if (!data || typeof data !== 'object' || typeof (data as { id?: unknown }).id !== 'string') {
      throw new Error('Falha ao resolver cliente: resposta inválida');
    }
    const resolved = data as IngestClienteResolution;
    return { id: resolved.id, criou: resolved.criou === true };
  }

  if (cnpj) {
    // Em sessão de usuário a RLS já restringe a consulta à empresa atual.
    const q = supabase
      .from('clientes')
      .select('id')
      .eq('cnpj_cpf', cnpj)
      .is('deleted_at', null);
    const { data: existente } = await q.maybeSingle();
    if (existente) return { id: existente.id as string, criou: false };
  }

  const insertRow: Database['public']['Tables']['clientes']['Insert'] = {
    cnpj_cpf:        cnpj,
    codigo_erp:      codigo,
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
