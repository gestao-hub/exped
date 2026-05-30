import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { createClient } from '@/lib/supabase/server';
import { PageHeader } from '@/components/layout/page-header';
import { ContentCard, ContentCardTitle } from '@/components/layout/content-card';
import { Button } from '@/components/ui/button';
import { OsNotificacoesPanel, type NotificacaoRow } from '@/components/os-notificacoes-panel';

const BRL = (n: number) => Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dt = (s: string | null) => (s ? format(new Date(s), "dd/MM/yyyy HH:mm", { locale: ptBR }) : '—');
const d = (s: string | null) => (s ? format(new Date(s), 'dd/MM/yyyy', { locale: ptBR }) : '—');

export default async function OsDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: os } = await supabase
    .from('ordens_servico')
    .select('*, itens:os_itens(*), servicos:os_servicos(*)')
    .eq('id', id)
    .single();
  if (!os) notFound();

  const [{ data: empresa }, { data: notifs }] = await Promise.all([
    supabase
      .from('empresas')
      .select('notif_whatsapp_ativo, notif_email_ativo')
      .eq('id', os.empresa_id)
      .single(),
    supabase
      .from('os_notificacoes')
      .select('id, canal, tipo, destino, status, agendada_para, enviada_em, erro')
      .eq('os_id', id)
      .order('created_at', { ascending: false })
      .limit(30),
  ]);
  const canaisAtivos = !!(empresa?.notif_whatsapp_ativo || empresa?.notif_email_ativo);
  const temContato = !!(os.cliente_telefone || os.cliente_email);

  const itens = (os.itens ?? []) as Array<{ id: string; codigo: string | null; descricao: string; quantidade: number; preco_unitario: number; total: number }>;
  const servicos = (os.servicos ?? []) as Array<{ id: string; descricao: string; quantidade: number; valor_unitario: number; total: number; tecnico_nome: string | null }>;

  const Campo = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-sm">{children}</p>
    </div>
  );

  return (
    <>
      <PageHeader
        title={`OS ${os.documento_erp ?? ''}`}
        description={os.cliente_nome}
        actions={
          <Link href="/os">
            <Button variant="outline"><ArrowLeft className="h-4 w-4 mr-1" /> Voltar</Button>
          </Link>
        }
      />

      <ContentCard header={<ContentCardTitle>Dados</ContentCardTitle>}>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 p-1">
          <Campo label="Cliente">{os.cliente_nome}</Campo>
          <Campo label="Telefone">{os.cliente_telefone ?? '—'}</Campo>
          <Campo label="Categoria">{os.categoria ?? '—'}</Campo>
          <Campo label="Status">{os.status}</Campo>
          <Campo label="Objeto / Equipamento">{os.objeto ?? '—'}</Campo>
          <Campo label="Técnico">{os.tecnico_nome ?? '—'}</Campo>
          <Campo label="Abertura">{dt(os.data_abertura)}</Campo>
          <Campo label="Previsão">{dt(os.data_previsao)}</Campo>
          <Campo label="Conclusão">{dt(os.data_conclusao)}</Campo>
          <Campo label="Garantia">{os.garantia_inicio || os.garantia_fim ? `${d(os.garantia_inicio)} a ${d(os.garantia_fim)}` : '—'}</Campo>
          <Campo label="Valor total">{BRL(os.valor_total)}</Campo>
        </div>
      </ContentCard>

      {(os.defeito_relatado || os.diagnostico) && (
        <ContentCard header={<ContentCardTitle>Defeito & Diagnóstico</ContentCardTitle>}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-1">
            <Campo label="Defeito relatado">{os.defeito_relatado ?? '—'}</Campo>
            <Campo label="Diagnóstico">{os.diagnostico ?? '—'}</Campo>
          </div>
        </ContentCard>
      )}

      <ContentCard header={<ContentCardTitle>Peças ({itens.length})</ContentCardTitle>}>
        {itens.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">Sem peças.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase"><tr>
              <th className="text-left px-2 py-1">Código</th><th className="text-left px-2 py-1">Descrição</th>
              <th className="text-right px-2 py-1">Qtd</th><th className="text-right px-2 py-1">Unit.</th><th className="text-right px-2 py-1">Total</th>
            </tr></thead>
            <tbody>{itens.map((it) => (
              <tr key={it.id} className="border-t">
                <td className="px-2 py-1">{it.codigo ?? '—'}</td><td className="px-2 py-1">{it.descricao}</td>
                <td className="px-2 py-1 text-right font-mono">{it.quantidade}</td>
                <td className="px-2 py-1 text-right font-mono">{BRL(it.preco_unitario)}</td>
                <td className="px-2 py-1 text-right font-mono">{BRL(it.total)}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </ContentCard>

      <ContentCard header={<ContentCardTitle>Serviços ({servicos.length})</ContentCardTitle>}>
        {servicos.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">Sem serviços.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase"><tr>
              <th className="text-left px-2 py-1">Serviço</th><th className="text-left px-2 py-1">Técnico</th>
              <th className="text-right px-2 py-1">Qtd</th><th className="text-right px-2 py-1">Unit.</th><th className="text-right px-2 py-1">Total</th>
            </tr></thead>
            <tbody>{servicos.map((sv) => (
              <tr key={sv.id} className="border-t">
                <td className="px-2 py-1">{sv.descricao}</td><td className="px-2 py-1">{sv.tecnico_nome ?? '—'}</td>
                <td className="px-2 py-1 text-right font-mono">{sv.quantidade}</td>
                <td className="px-2 py-1 text-right font-mono">{BRL(sv.valor_unitario)}</td>
                <td className="px-2 py-1 text-right font-mono">{BRL(sv.total)}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </ContentCard>

      <OsNotificacoesPanel
        osId={id}
        canaisAtivos={canaisAtivos}
        temContato={temContato}
        proximaManutencao={{ data: os.data_proxima_manutencao, obs: os.proxima_manutencao_obs }}
        notificacoes={(notifs ?? []) as NotificacaoRow[]}
      />
    </>
  );
}
