import { PageHeader } from '@/components/layout/page-header';
import { ContentCard } from '@/components/layout/content-card';
import { ClientesTable } from '@/components/clientes-table';

export const dynamic = 'force-dynamic';

export default function ClientesPage() {
  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <PageHeader
        title="Clientes"
        description="Cadastro de clientes — criados automaticamente quando o vendedor sobe um PDF."
      />

      <ContentCard variant="flush" className="flex flex-col flex-1 min-h-0">
        <div className="flex-1 overflow-y-auto min-h-0">
          <ClientesTable />
        </div>
      </ContentCard>
    </div>
  );
}
