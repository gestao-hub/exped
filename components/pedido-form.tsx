'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Trash2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Separator } from '@/components/ui/separator';
import { criarPedidoAction } from '@/app/(app)/vendas/actions';
import { pedidoFormSchema, type PedidoFormInput } from '@/lib/validators/pedido';

export function PedidoForm({ defaultValues }: { defaultValues: PedidoFormInput }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const form = useForm<PedidoFormInput>({
    resolver: zodResolver(pedidoFormSchema),
    defaultValues,
  });
  const { control, register, handleSubmit, watch, formState: { errors } } = form;
  const { fields: pontos, append: addPonto, remove: removePonto } = useFieldArray({
    control,
    name: 'pontos_retirada',
  });

  function submit(status: 'rascunho' | 'pendente') {
    handleSubmit(
      (values) => {
        startTransition(async () => {
          const r = await criarPedidoAction(values, status);
          if ('error' in r) {
            toast.error(r.error);
            return;
          }
          toast.success(
            status === 'pendente'
              ? `Pedido enviado para logística`
              : 'Rascunho salvo',
          );
          router.push(`/vendas/${r.id}`);
        });
      },
      (errs) => {
        const first = Object.values(errs).flat()[0] as { message?: string } | undefined;
        toast.error(first?.message ?? 'Verifique os campos destacados');
      },
    )();
  }

  return (
    <form className="space-y-6">
      {/* Dados do Pedido */}
      <Card>
        <CardHeader>
          <CardTitle>Dados do Pedido</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Field label="Documento ERP">
            <Input {...register('documento_erp')} placeholder="L4077" />
          </Field>
          <Field label="Data de Emissão">
            <Input type="date" {...register('data_emissao')} />
          </Field>
          <Field label="Data de Entrega">
            <Input type="date" {...register('data_entrega')} />
          </Field>
        </CardContent>
      </Card>

      {/* Cliente */}
      <Card>
        <CardHeader>
          <CardTitle>Cliente</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-6 gap-4">
          <Field label="Código" className="md:col-span-1">
            <Input {...register('cliente_codigo')} />
          </Field>
          <Field label="Nome" required className="md:col-span-3">
            <Input {...register('cliente_nome')} aria-invalid={!!errors.cliente_nome} />
          </Field>
          <Field label="CNPJ/CPF" className="md:col-span-2">
            <Input {...register('cliente_cnpj_cpf')} />
          </Field>

          <Field label="Endereço" className="md:col-span-3">
            <Input {...register('cliente_endereco')} />
          </Field>
          <Field
            label="Bairro"
            className="md:col-span-1 [&_input]:bg-franzoni-orange-50/40 [&_input]:border-franzoni-orange/30"
          >
            <Input {...register('cliente_bairro')} placeholder="Destacado para logística" />
          </Field>
          <Field label="Cidade" className="md:col-span-1">
            <Input {...register('cliente_cidade')} />
          </Field>
          <Field label="UF" className="md:col-span-1">
            <Input {...register('cliente_uf')} maxLength={2} />
          </Field>

          <Field label="CEP" className="md:col-span-2">
            <Input {...register('cliente_cep')} />
          </Field>
          <Field label="Telefone" className="md:col-span-2">
            <Input {...register('cliente_telefone')} />
          </Field>
        </CardContent>
      </Card>

      {/* Pontos de Retirada */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Pontos de Retirada</CardTitle>
          {pontos.length < 2 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                addPonto({
                  tipo: pontos[0]?.tipo === 'loja' ? 'deposito' : 'loja',
                  empresa_nome: '',
                  endereco: '',
                  itens: [],
                })
              }
            >
              <Plus className="h-4 w-4 mr-1" /> Adicionar ponto
            </Button>
          )}
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="0" className="w-full">
            <TabsList>
              {pontos.map((p, i) => (
                <TabsTrigger key={p.id} value={String(i)} className="capitalize">
                  {watch(`pontos_retirada.${i}.tipo`) ?? p.tipo}
                </TabsTrigger>
              ))}
            </TabsList>
            {pontos.map((p, i) => (
              <TabsContent key={p.id} value={String(i)} className="space-y-4 pt-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <Field label="Tipo">
                    <select
                      {...register(`pontos_retirada.${i}.tipo`)}
                      className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                    >
                      <option value="loja">Loja</option>
                      <option value="deposito">Depósito</option>
                    </select>
                  </Field>
                  <Field label="Empresa" className="md:col-span-2">
                    <Input {...register(`pontos_retirada.${i}.empresa_nome`)} />
                  </Field>
                  <Field label="Endereço" className="md:col-span-3">
                    <Input {...register(`pontos_retirada.${i}.endereco`)} />
                  </Field>
                </div>

                <ItensEditor pontoIndex={i} control={control} register={register} />

                {pontos.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => removePonto(i)}
                    className="text-destructive hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4 mr-1" /> Remover ponto
                  </Button>
                )}
              </TabsContent>
            ))}
          </Tabs>
        </CardContent>
      </Card>

      {/* Pagamento e Observações */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Pagamento</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field label="Forma de Pagamento">
              <Input {...register('forma_pagamento')} placeholder="ENTREGA A RECEBER" />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Parcelas">
                <Input {...register('parcelas')} placeholder="10x" />
              </Field>
              <Field label="Valor Total">
                <Input
                  type="number"
                  step="0.01"
                  {...register('valor_total', { valueAsNumber: true })}
                  className="font-mono text-right"
                />
              </Field>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Observações</CardTitle>
          </CardHeader>
          <CardContent>
            <Textarea
              rows={5}
              {...register('observacoes')}
              placeholder="Instruções de entrega, referências, etc."
            />
          </CardContent>
        </Card>
      </div>

      <Separator />

      <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={() => submit('rascunho')}
          disabled={pending}
        >
          Salvar Rascunho
        </Button>
        <Button
          type="button"
          onClick={() => submit('pendente')}
          disabled={pending}
          className="bg-franzoni-orange hover:bg-franzoni-orange-600"
        >
          {pending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          Enviar para Logística
        </Button>
      </div>
    </form>
  );
}

function Field({
  label,
  required,
  className,
  children,
}: {
  label: string;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <Label className="text-xs text-muted-foreground mb-1.5 block">
        {label} {required && <span className="text-destructive">*</span>}
      </Label>
      {children}
    </div>
  );
}

function ItensEditor({
  pontoIndex,
  control,
  register,
}: {
  pontoIndex: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  control: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register: any;
}) {
  const { fields, append, remove } = useFieldArray({
    control,
    name: `pontos_retirada.${pontoIndex}.itens`,
  });

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium">Itens ({fields.length})</h4>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            append({
              codigo: '',
              descricao: '',
              quantidade: 1,
              unidade: 'UN',
              preco_unitario: 0,
              desconto: 0,
              total: 0,
              referencia: null,
            })
          }
        >
          <Plus className="h-4 w-4 mr-1" /> Adicionar item
        </Button>
      </div>

      {fields.length === 0 ? (
        <p className="text-sm text-muted-foreground italic py-4 text-center border border-dashed rounded-md">
          Nenhum item.
        </p>
      ) : (
        <div className="border rounded-md overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left  px-2 py-2 w-20">Código</th>
                <th className="text-left  px-2 py-2">Descrição</th>
                <th className="text-right px-2 py-2 w-20">Qtd</th>
                <th className="text-left  px-2 py-2 w-16">Un</th>
                <th className="text-right px-2 py-2 w-28">Unitário</th>
                <th className="text-right px-2 py-2 w-28">Total</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {fields.map((f, i) => (
                <tr key={f.id} className="border-t">
                  <td className="px-1 py-1">
                    <Input {...register(`pontos_retirada.${pontoIndex}.itens.${i}.codigo`)} className="h-8" />
                  </td>
                  <td className="px-1 py-1">
                    <Input {...register(`pontos_retirada.${pontoIndex}.itens.${i}.descricao`)} className="h-8" />
                  </td>
                  <td className="px-1 py-1">
                    <Input
                      type="number"
                      step="0.001"
                      {...register(`pontos_retirada.${pontoIndex}.itens.${i}.quantidade`, { valueAsNumber: true })}
                      className="h-8 text-right font-mono"
                    />
                  </td>
                  <td className="px-1 py-1">
                    <Input {...register(`pontos_retirada.${pontoIndex}.itens.${i}.unidade`)} className="h-8" />
                  </td>
                  <td className="px-1 py-1">
                    <Input
                      type="number"
                      step="0.01"
                      {...register(`pontos_retirada.${pontoIndex}.itens.${i}.preco_unitario`, { valueAsNumber: true })}
                      className="h-8 text-right font-mono"
                    />
                  </td>
                  <td className="px-1 py-1">
                    <Input
                      type="number"
                      step="0.01"
                      {...register(`pontos_retirada.${pontoIndex}.itens.${i}.total`, { valueAsNumber: true })}
                      className="h-8 text-right font-mono"
                    />
                  </td>
                  <td className="px-1 py-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => remove(i)}
                      aria-label="Remover item"
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
