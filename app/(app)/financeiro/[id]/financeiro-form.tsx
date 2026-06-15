'use client';

import * as React from 'react';
import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2, Send, Check } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  financeiroFormSchema,
  type FinanceiroFormInput,
} from '@/lib/validators/financeiro';
import {
  salvarFinanceiroAction,
  liberarParaLogisticaAction,
} from '@/app/(app)/financeiro/actions';
import {
  FORMAS_PAGAMENTO,
  FORMAS_COM_PARCELAS,
  rotuloFormaPagamento,
} from '@/lib/parser/forma-pagamento';
import type { PedidoStatus } from '@/lib/types';

export function FinanceiroForm({
  pedidoId,
  status,
  defaultValues,
}: {
  pedidoId: string;
  status: PedidoStatus;
  defaultValues: FinanceiroFormInput;
}) {
  const router = useRouter();
  const [savePending, startSave] = useTransition();
  const [liberarPending, startLiberar] = useTransition();

  const { control, register, handleSubmit, watch, setValue } = useForm<FinanceiroFormInput>({
    resolver: zodResolver(financeiroFormSchema),
    defaultValues,
  });

  const editavel = status === 'em_financeiro';

  function run(
    action: (id: string, values: FinanceiroFormInput) => Promise<{ error: string } | { ok: true }>,
    start: React.TransitionStartFunction,
    successMsg: string,
  ) {
    handleSubmit((values) => {
      start(async () => {
        const r = await action(pedidoId, values);
        if ('error' in r) {
          toast.error(r.error);
          return;
        }
        toast.success(successMsg);
        router.refresh();
      });
    })();
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between flex-wrap gap-3">
        <CardTitle>Conferência do Financeiro</CardTitle>
        {editavel && (
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => run(salvarFinanceiroAction, startSave, 'Conferência salva')}
              disabled={savePending || liberarPending}
            >
              {savePending ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <Check className="h-4 w-4 mr-1" />
              )}
              Salvar
            </Button>
            <Button
              onClick={() =>
                run(liberarParaLogisticaAction, startLiberar, 'Liberado para logística')
              }
              disabled={savePending || liberarPending}
              className="bg-brand hover:bg-brand-600"
            >
              {liberarPending ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <Send className="h-4 w-4 mr-1" />
              )}
              Liberar para logística
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {!editavel && (
          <p className="text-sm text-muted-foreground">
            Este pedido já foi liberado para a logística. Os dados abaixo são apenas leitura.
          </p>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Forma de Pagamento">
            <Controller
              control={control}
              name="forma_pagamento"
              render={({ field }) => (
                <Select
                  value={field.value ?? ''}
                  disabled={!editavel}
                  onValueChange={(v) => {
                    const forma = v === '' ? null : (v as (typeof FORMAS_PAGAMENTO)[number]);
                    field.onChange(forma);
                    if (!forma || !FORMAS_COM_PARCELAS.has(forma)) {
                      setValue('parcelas', null, { shouldDirty: true });
                    }
                  }}
                >
                  <SelectTrigger className="h-9 w-full">
                    <SelectValue placeholder="—" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">—</SelectItem>
                    {FORMAS_PAGAMENTO.map((f) => (
                      <SelectItem key={f} value={f}>
                        {rotuloFormaPagamento(f, null)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </Field>

          <Field label="Parcelas">
            <Controller
              control={control}
              name="parcelas"
              render={({ field }) => {
                const forma = watch('forma_pagamento');
                const aceitaParcelas = !!forma && FORMAS_COM_PARCELAS.has(forma);
                return (
                  <Select
                    value={field.value == null ? '' : String(field.value)}
                    disabled={!editavel || !aceitaParcelas}
                    onValueChange={(v) => {
                      field.onChange(v === '' ? null : Number(v));
                    }}
                  >
                    <SelectTrigger className="h-9 w-full">
                      <SelectValue placeholder="—" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">—</SelectItem>
                      {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
                        <SelectItem key={n} value={String(n)}>
                          {n}x
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                );
              }}
            />
          </Field>

          <Field label="Frete (R$)">
            <Input
              type="number"
              step="0.01"
              disabled={!editavel}
              {...register('valor_frete', { valueAsNumber: true })}
              className="font-mono text-right"
            />
          </Field>

          <Field label="Valor Total (R$)">
            <Input
              type="number"
              step="0.01"
              disabled={!editavel}
              {...register('valor_total', { valueAsNumber: true })}
              className="font-mono text-right"
            />
          </Field>
        </div>

        <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
          <input
            type="checkbox"
            disabled={!editavel}
            {...register('receber_na_entrega')}
            className="h-4 w-4"
          />
          Receber na entrega
        </label>

        <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
          <input
            type="checkbox"
            disabled={!editavel}
            {...register('exige_emissao')}
            className="h-4 w-4"
          />
          Exige emissão
        </label>
      </CardContent>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  const generatedId = React.useId();
  const child = React.isValidElement(children)
    ? React.cloneElement(children as React.ReactElement<{ id?: string }>, {
        id: (children as React.ReactElement<{ id?: string }>).props.id ?? generatedId,
      })
    : children;
  const htmlFor =
    React.isValidElement(children) &&
    ((children as React.ReactElement<{ id?: string }>).props.id ?? generatedId);
  return (
    <div>
      <Label htmlFor={htmlFor || undefined} className="text-xs text-muted-foreground mb-1.5 block">
        {label}
      </Label>
      {child}
    </div>
  );
}
