import { PageHeader } from '@/components/layout/page-header';
import { ContentCard } from '@/components/layout/content-card';
import { ClientesTable } from '@/components/clientes-table';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

type ClienteRow = {
  id: string;
  nome: string;
  cnpj_cpf: string | null;
  codigo_erp: string | null;
  endereco_padrao: string | null;
  bairro_padrao: string | null;
  cidade_padrao: string | null;
  uf_padrao: string | null;
  cep_padrao: string | null;
  telefone_padrao: string | null;
  observacoes: string | null;
  created_at: string;
  pedidos_count: number;
};

export default async function ClientesPage() {
  const supabase = await createClient();

  const { data: clientes } = await supabase
    .from('clientes')
    .select('*, pedidos:pedidos(count)')
    .order('nome');

  const rows: ClienteRow[] = (clientes ?? []).map((c) => {
    const countObj = Array.isArray(c.pedidos) ? c.pedidos[0] : null;
    return {
      id: c.id as string,
      nome: c.nome as string,
      cnpj_cpf: c.cnpj_cpf as string | null,
      codigo_erp: c.codigo_erp as string | null,
      endereco_padrao: c.endereco_padrao as string | null,
      bairro_padrao: c.bairro_padrao as string | null,
      cidade_padrao: c.cidade_padrao as string | null,
      uf_padrao: c.uf_padrao as string | null,
      cep_padrao: c.cep_padrao as string | null,
      telefone_padrao: c.telefone_padrao as string | null,
      observacoes: c.observacoes as string | null,
      created_at: c.created_at as string,
      pedidos_count: (countObj as { count?: number } | null)?.count ?? 0,
    };
  });

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <PageHeader
        title="Clientes"
        description={`${rows.length} cliente${rows.length === 1 ? '' : 's'} cadastrado${rows.length === 1 ? '' : 's'}. Criados automaticamente quando vendedor sobe um PDF.`}
      />

      <ContentCard variant="flush" className="flex flex-col flex-1 min-h-0">
        <div className="flex-1 overflow-y-auto min-h-0">
          <ClientesTable clientes={rows} />
        </div>
      </ContentCard>
    </div>
  );
}
