'use client';

import * as React from 'react';
import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2, Check } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import {
  logisticaFormSchema,
  type LogisticaFormInput,
} from '@/lib/validators/logistica';
import { salvarLogisticaAction } from '@/app/(app)/logistica/actions';
import {
  finalizarPedidoAction,
  iniciarSeparacaoAction,
} from '@/app/(app)/vendas/actions';
import type { PedidoStatus } from '@/lib/types';

export function BaixaForm({
  pedidoId,
  status,
  defaultValues,
}: {
  pedidoId: string;
  status: PedidoStatus;
  defaultValues: LogisticaFormInput;
}) {
  const router = useRouter();
  const [savePending, startSave] = useTransition();
  const [statusPending, startStatus] = useTransition();

  const { register, handleSubmit } = useForm<LogisticaFormInput>({
    resolver: zodResolver(logisticaFormSchema),
    defaultValues,
  });

  function save() {
    handleSubmit((values) => {
      startSave(async () => {
        const r = await salvarLogisticaAction(pedidoId, values);
        if ('error' in r) toast.error(r.error);
        else toast.success('Logística atualizada');
        router.refresh();
      });
    })();
  }

  function changeStatus(action: 'iniciar' | 'finalizar') {
    startStatus(async () => {
      const r = await (action === 'iniciar'
        ? iniciarSeparacaoAction(pedidoId)
        : finalizarPedidoAction(pedidoId));
      if ('error' in r) toast.error(r.error);
      else toast.success(action === 'iniciar' ? 'Separação iniciada' : 'Pedido finalizado');
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between flex-wrap gap-3">
        <CardTitle>Dados de Logística</CardTitle>
        <div className="flex gap-2">
          {status === 'pendente' && (
            <Button
              variant="outline"
              onClick={() => changeStatus('iniciar')}
              disabled={statusPending}
            >
              {statusPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              Iniciar Separação
            </Button>
          )}
          {status === 'em_separacao' && (
            <Button
              onClick={() => changeStatus('finalizar')}
              disabled={statusPending}
              className="bg-status-finalizado hover:bg-status-finalizado/90 text-white"
            >
              {statusPending ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <Check className="h-4 w-4 mr-1" />
              )}
              Marcar como Finalizado
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <FormField label="Pré-Carga">
            <Input {...register('pre_carga')} />
          </FormField>
          <FormField label="Motorista">
            <Input {...register('motorista')} list="motoristas-list" />
          </FormField>
          <FormField label="Veículo">
            <Input {...register('veiculo')} list="veiculos-list" placeholder="ex.: VW 8160 - ABC1234" />
          </FormField>

          <FormField label="Região">
            <Input {...register('regiao')} list="regioes-list" />
          </FormField>
          <FormField label="Km Inicial">
            <Input type="number" step="0.1" {...register('km_inicial', { valueAsNumber: true })} />
          </FormField>
          <FormField label="Km Final">
            <Input type="number" step="0.1" {...register('km_final', { valueAsNumber: true })} />
          </FormField>

          <FormField label="Peso Bruto Total (kg)">
            <Input type="number" step="0.01" {...register('peso_bruto_total', { valueAsNumber: true })} />
          </FormField>
          <FormField label="Peso Líquido Total (kg)">
            <Input type="number" step="0.01" {...register('peso_liquido_total', { valueAsNumber: true })} />
          </FormField>
          <FormField label="Conferente">
            <Input {...register('conferente')} list="conferentes-list" />
          </FormField>
        </div>

        <FormField label="Observações de Logística">
          <Textarea rows={3} {...register('observacoes')} />
        </FormField>


        <Separator />

        <div className="flex justify-end">
          <Button
            onClick={save}
            disabled={savePending}
            className="bg-franzoni-orange hover:bg-franzoni-orange-600"
          >
            {savePending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Salvar
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  const generatedId = React.useId();
  const child = React.isValidElement(children)
    ? React.cloneElement(children as React.ReactElement<{ id?: string }>, {
        id:
          (children as React.ReactElement<{ id?: string }>).props.id ?? generatedId,
      })
    : children;
  const htmlFor =
    React.isValidElement(children) &&
    ((children as React.ReactElement<{ id?: string }>).props.id ?? generatedId);
  return (
    <div>
      <Label
        htmlFor={htmlFor || undefined}
        className="text-xs text-muted-foreground mb-1.5 block"
      >
        {label}
      </Label>
      {child}
    </div>
  );
}
