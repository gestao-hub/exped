'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { Send, BellRing, CalendarClock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DatePicker } from '@/components/ui/date-picker';
import { Badge } from '@/components/ui/badge';
import { ContentCard, ContentCardTitle } from '@/components/layout/content-card';
import {
  pedirAutorizacaoAction,
  avisarProntoAction,
  agendarManutencaoAction,
  type NotificarResult,
} from '@/app/(app)/os/[id]/actions';

export type NotificacaoRow = {
  id: string;
  canal: string;
  tipo: string;
  destino: string;
  status: string;
  agendada_para: string;
  enviada_em: string | null;
  erro: string | null;
};

const TIPO_LABEL: Record<string, string> = {
  autorizacao: 'Autorização',
  pronto: 'Pronto p/ retirada',
  lembrete_manutencao: 'Lembrete de manutenção',
};
const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  pendente: 'secondary',
  enviada: 'default',
  falha: 'destructive',
  cancelada: 'outline',
};

export function OsNotificacoesPanel({
  osId,
  canaisAtivos,
  temContato,
  proximaManutencao,
  notificacoes,
}: {
  osId: string;
  canaisAtivos: boolean;
  temContato: boolean;
  proximaManutencao: { data: string | null; obs: string | null };
  notificacoes: NotificacaoRow[];
}) {
  const [pending, startTransition] = useTransition();
  const [data, setData] = useState(proximaManutencao.data ?? '');
  const [obs, setObs] = useState(proximaManutencao.obs ?? '');

  const run = (fn: () => Promise<NotificarResult>, sucesso: string) =>
    startTransition(async () => {
      const r = await fn();
      if ('error' in r) toast.error(r.error);
      else toast.success(`${sucesso} (${r.enfileiradas} ${r.enfileiradas === 1 ? 'canal' : 'canais'}).`);
    });

  const fmt = (s: string | null) => (s ? format(new Date(s), "dd/MM/yy HH:mm", { locale: ptBR }) : '—');
  const bloqueado = !canaisAtivos || !temContato || pending;

  return (
    <ContentCard header={<ContentCardTitle>Notificações & Retenção</ContentCardTitle>}>
      {!canaisAtivos && (
        <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 mb-3">
          Nenhum canal ativo. Ative WhatsApp/e-mail nas configurações da empresa para enviar.
        </p>
      )}
      {canaisAtivos && !temContato && (
        <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 mb-3">
          Esta OS não tem telefone nem e-mail do cliente.
        </p>
      )}

      <div className="flex flex-wrap gap-2 mb-4">
        <Button
          variant="outline" size="sm" disabled={bloqueado}
          onClick={() => run(() => pedirAutorizacaoAction(osId), 'Autorização enfileirada')}
        >
          <Send className="h-4 w-4 mr-1" /> Pedir autorização
        </Button>
        <Button
          variant="outline" size="sm" disabled={bloqueado}
          onClick={() => run(() => avisarProntoAction(osId), 'Aviso enfileirado')}
        >
          <BellRing className="h-4 w-4 mr-1" /> Avisar que está pronto
        </Button>
      </div>

      {/* Agendar próxima manutenção */}
      <div className="border-t pt-3">
        <p className="text-xs uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1">
          <CalendarClock className="h-3.5 w-3.5" /> Próxima manutenção
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="text-[11px] text-muted-foreground block">Data</label>
            <DatePicker value={data} onChangeAction={(iso) => setData(iso ?? '')} placeholder="Data" className="w-40" />
          </div>
          <div className="flex-1 min-w-[180px]">
            <label className="text-[11px] text-muted-foreground block">Descrição</label>
            <Input
              placeholder="Ex.: Troca de óleo (5.000 km)"
              value={obs}
              onChange={(e) => setObs(e.target.value)}
            />
          </div>
          <Button
            size="sm"
            disabled={bloqueado || !data}
            onClick={() =>
              run(() => agendarManutencaoAction(osId, data, obs || null), 'Lembrete agendado')
            }
          >
            Agendar lembrete
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground mt-1">
          O lembrete é enviado automaticamente alguns dias antes da data (configurável na empresa).
        </p>
      </div>

      {/* Histórico */}
      {notificacoes.length > 0 && (
        <div className="border-t mt-4 pt-3">
          <p className="text-xs uppercase tracking-wide text-muted-foreground mb-2">Histórico</p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground text-left">
                <tr>
                  <th className="py-1 pr-3">Tipo</th>
                  <th className="py-1 pr-3">Canal</th>
                  <th className="py-1 pr-3">Destino</th>
                  <th className="py-1 pr-3">Quando</th>
                  <th className="py-1 pr-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {notificacoes.map((n) => (
                  <tr key={n.id} className="border-t align-top">
                    <td className="py-1 pr-3">{TIPO_LABEL[n.tipo] ?? n.tipo}</td>
                    <td className="py-1 pr-3 capitalize">{n.canal}</td>
                    <td className="py-1 pr-3 font-mono">{n.destino}</td>
                    <td className="py-1 pr-3">{fmt(n.enviada_em ?? n.agendada_para)}</td>
                    <td className="py-1 pr-3">
                      <Badge variant={STATUS_VARIANT[n.status] ?? 'outline'}>{n.status}</Badge>
                      {n.status === 'falha' && n.erro && (
                        <span className="block text-[10px] text-destructive mt-0.5 max-w-[200px] truncate" title={n.erro}>
                          {n.erro}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </ContentCard>
  );
}
