'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';
import { useTransition, useState } from 'react';
import { Controller, useFieldArray, useForm } from 'react-hook-form';
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
import { criarPedidoAction, atualizarPedidoAction } from '@/app/(app)/vendas/actions';
import { pedidoFormSchema, type PedidoFormInput } from '@/lib/validators/pedido';
import { DatePicker } from '@/components/ui/date-picker';
import { EnderecoSelector } from '@/components/clientes/endereco-selector';
import {
  FORMAS_PAGAMENTO,
  FORMAS_COM_PARCELAS,
  rotuloFormaPagamento,
} from '@/lib/parser/forma-pagamento';

type ErrorLeaf = { path: string; message: string };
function collectErrorLeaves(node: unknown, prefix = ''): ErrorLeaf[] {
  if (!node || typeof node !== 'object') return [];
  const obj = node as Record<string, unknown>;
  // Detecta uma folha: tem .message (string) e .type
  if (typeof obj.message === 'string' && typeof obj.type === 'string') {
    return [{ path: prefix || 'campo', message: obj.message }];
  }
  const out: ErrorLeaf[] = [];
  for (const [key, val] of Object.entries(obj)) {
    if (val == null) continue;
    if (Array.isArray(val)) {
      val.forEach((item, i) => {
        out.push(...collectErrorLeaves(item, prefix ? `${prefix}.${key}[${i}]` : `${key}[${i}]`));
      });
    } else if (typeof val === 'object') {
      out.push(...collectErrorLeaves(val, prefix ? `${prefix}.${key}` : key));
    }
  }
  return out;
}

export function PedidoForm({
  defaultValues,
  mode = 'create',
  pedidoId,
}: {
  defaultValues: PedidoFormInput;
  mode?: 'create' | 'edit';
  pedidoId?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Tabs controlado: ao reduzir o nº de pontos (Híbrido→Loja), a aba ativa pode
  // apontar para um índice que deixou de existir e o painel sairia em branco.
  const [abaPonto, setAbaPonto] = useState('0');

  const form = useForm<PedidoFormInput>({
    resolver: zodResolver(pedidoFormSchema),
    defaultValues,
  });
  const { control, register, handleSubmit, watch, setValue, getValues, formState: { errors } } = form;
  const cnpjCpfWatch = watch('cliente_cnpj_cpf');
  const enderecoIdWatch = watch('cliente_endereco_id');
  const endValues = {
    endereco: watch('cliente_endereco') ?? null,
    bairro:   watch('cliente_bairro')   ?? null,
    cidade:   watch('cliente_cidade')   ?? null,
    uf:       watch('cliente_uf')       ?? null,
    cep:      watch('cliente_cep')      ?? null,
    telefone: watch('cliente_telefone') ?? null,
  };
  const { fields: pontos, remove: removePonto } = useFieldArray({
    control,
    name: 'pontos_retirada',
    // keyName padrão é 'id' — colidiria com nosso campo `id` (PK do banco) e o RHF
    // o sobrescreveria/removeria no submit. Usamos uma chave própria pra preservar a PK.
    keyName: '_rhfId',
  });

  // Modo de retirada derivado dos pontos atuais (watch p/ refletir mudanças de tipo).
  const pontosWatch = watch('pontos_retirada');
  const modoRetirada: 'loja' | 'deposito' | 'hibrido' =
    pontosWatch?.some((p) => p?.tipo === 'entrega')
      ? 'hibrido'
      : pontosWatch?.[0]?.tipo === 'deposito'
        ? 'deposito'
        : 'loja';
  // No modo híbrido, o tipo do ponto de retirada (loja vs depósito) é um sub-seletor.
  const tipoRetiradaHibrido: 'loja' | 'deposito' =
    pontosWatch?.find((p) => p?.tipo === 'deposito') ? 'deposito' : 'loja';
  // Frete só faz sentido quando há entrega (envio/híbrido). Mostramos também quando
  // já existe um valor (ex.: veio do Hiper) pra não esconder o dado.
  const freteWatch = watch('valor_frete');
  const mostrarFrete = modoRetirada === 'hibrido' || Number(freteWatch ?? 0) > 0;

  /** Endereço do cliente (default do ponto de entrega no modo híbrido). */
  function enderecoCliente() {
    const partes = [
      getValues('cliente_endereco'),
      getValues('cliente_bairro'),
      getValues('cliente_cidade'),
      getValues('cliente_uf'),
    ].filter((s): s is string => !!s && s.trim() !== '');
    return partes.join(', ');
  }

  /** Junta todos os itens dos pontos atuais num único array. */
  function todosItens() {
    return (getValues('pontos_retirada') ?? []).flatMap((p) => p?.itens ?? []);
  }

  function aplicarModo(novo: 'loja' | 'deposito' | 'hibrido', tipoRetirada?: 'loja' | 'deposito') {
    // Reset da aba ativa: tanto loja/deposito (1 ponto) quanto híbrido (reconstrói
    // os 2 pontos) garantem que índice 0 existe — evita painel em branco.
    setAbaPonto('0');
    const atuais = getValues('pontos_retirada') ?? [];
    if (novo === 'loja' || novo === 'deposito') {
      // 1 ponto único com TODOS os itens consolidados; remove extras.
      const itens = todosItens();
      const base = atuais[0];
      setValue('pontos_retirada', [
        {
          ...(base ?? { empresa_nome: '', endereco: '' }),
          id: base?.id ?? null,
          tipo: novo,
          empresa_nome: base?.empresa_nome ?? '',
          endereco: base?.endereco ?? '',
          itens,
        },
      ], { shouldDirty: true });
      return;
    }
    // Híbrido: ponto de retirada (loja/depósito) + ponto de entrega (endereço do cliente).
    const tr = tipoRetirada ?? tipoRetiradaHibrido;
    const retiradaExistente = atuais.find((p) => p?.tipo === 'loja' || p?.tipo === 'deposito');
    const entregaExistente = atuais.find((p) => p?.tipo === 'entrega');
    setValue('pontos_retirada', [
      {
        id: retiradaExistente?.id ?? null,
        tipo: tr,
        empresa_nome: retiradaExistente?.empresa_nome ?? '',
        endereco: retiradaExistente?.endereco ?? '',
        itens: retiradaExistente?.itens ?? (entregaExistente ? [] : todosItens()),
      },
      {
        id: entregaExistente?.id ?? null,
        tipo: 'entrega',
        empresa_nome: entregaExistente?.empresa_nome || getValues('cliente_nome') || '',
        endereco: entregaExistente?.endereco || enderecoCliente(),
        itens: entregaExistente?.itens ?? [],
      },
    ], { shouldDirty: true });
  }

  function submit(status: 'rascunho' | 'em_financeiro') {
    handleSubmit(
      (values) => {
        startTransition(async () => {
          const r =
            mode === 'edit' && pedidoId
              ? await atualizarPedidoAction(pedidoId, values, status)
              : await criarPedidoAction(values, status);
          if ('error' in r) {
            toast.error(r.error);
            return;
          }
          if ('duplicate' in r) {
            toast.warning(
              `Já existe um pedido com este documento (#${r.existing_numero}). Abrindo o existente.`,
            );
            router.push(`/vendas/${r.existing_id}`);
            return;
          }
          toast.success(
            status === 'em_financeiro'
              ? `Pedido enviado para o financeiro`
              : 'Rascunho salvo',
          );
          router.push(`/vendas/${r.id}`);
        });
      },
      (errs) => {
        // Traversa profundo procurando todos os erros com .message e path
        const leaves = collectErrorLeaves(errs);
        if (leaves.length === 0) {
          toast.error('Verifique os campos do formulário');
          return;
        }
        const first = leaves[0];
        const extras = leaves.length > 1 ? ` (+${leaves.length - 1} outro${leaves.length === 2 ? '' : 's'})` : '';
        toast.error(`${first.path}: ${first.message}${extras}`, { duration: 6000 });
        // Log no console pra inspeção rápida do dev
        if (typeof window !== 'undefined') {
          console.warn('[PedidoForm] erros de validação:', leaves);
        }
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
            <Controller
              control={control}
              name="data_emissao"
              render={({ field }) => (
                <DatePicker
                  value={field.value}
                  onChangeAction={field.onChange}
                  placeholder="Selecionar emissão"
                />
              )}
            />
          </Field>
          <Field label="Data de Entrega">
            <Controller
              control={control}
              name="data_entrega"
              render={({ field }) => (
                <DatePicker
                  value={field.value}
                  onChangeAction={field.onChange}
                  placeholder="Selecionar entrega"
                />
              )}
            />
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

          <EnderecoSelector
            cnpjCpf={cnpjCpfWatch}
            selectedId={enderecoIdWatch}
            currentValues={endValues}
            onPickAction={(ende) => {
              if (ende) {
                setValue('cliente_endereco_id', ende.id, { shouldDirty: true });
                setValue('cliente_endereco', ende.endereco ?? '', { shouldDirty: true });
                setValue('cliente_bairro',   ende.bairro   ?? '', { shouldDirty: true });
                setValue('cliente_cidade',   ende.cidade   ?? '', { shouldDirty: true });
                setValue('cliente_uf',       ende.uf       ?? '', { shouldDirty: true });
                setValue('cliente_cep',      ende.cep      ?? '', { shouldDirty: true });
                setValue('cliente_telefone', ende.telefone ?? '', { shouldDirty: true });
              } else {
                setValue('cliente_endereco_id', null, { shouldDirty: true });
              }
            }}
          />

          <Field label="Endereço" className="md:col-span-3">
            <Input {...register('cliente_endereco')} />
          </Field>
          <Field
            label="Bairro"
            className="md:col-span-1 [&_input]:bg-brand-50/40 [&_input]:border-brand/30"
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
        <CardHeader className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
          <CardTitle>Pontos de Retirada</CardTitle>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <Label className="text-xs text-muted-foreground mb-1.5 block">
                Modo de retirada
              </Label>
              <select
                value={modoRetirada}
                onChange={(e) => aplicarModo(e.target.value as 'loja' | 'deposito' | 'hibrido')}
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
              >
                <option value="loja">Loja</option>
                <option value="deposito">Depósito</option>
                <option value="hibrido">Híbrido (retirada + entrega)</option>
              </select>
            </div>
            {modoRetirada === 'hibrido' && (
              <div>
                <Label className="text-xs text-muted-foreground mb-1.5 block">
                  Ponto de retirada
                </Label>
                <select
                  value={tipoRetiradaHibrido}
                  onChange={(e) =>
                    aplicarModo('hibrido', e.target.value as 'loja' | 'deposito')
                  }
                  className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                >
                  <option value="loja">Loja</option>
                  <option value="deposito">Depósito</option>
                </select>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <Tabs value={abaPonto} onValueChange={setAbaPonto} className="w-full">
            <TabsList>
              {pontos.map((p, i) => (
                <TabsTrigger key={p._rhfId} value={String(i)} className="capitalize">
                  {watch(`pontos_retirada.${i}.tipo`) ?? p.tipo}
                </TabsTrigger>
              ))}
            </TabsList>
            {pontos.map((p, i) => (
              <TabsContent key={p._rhfId} value={String(i)} className="space-y-4 pt-4">
                {/* PK estável do ponto (presente ao editar; ausente ao criar novo) */}
                <input
                  type="hidden"
                  {...register(`pontos_retirada.${i}.id`, {
                    setValueAs: (v: unknown) => (v === '' || v == null ? null : v),
                  })}
                />
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {/* No modo híbrido o tipo por ponto é editável (sub-seletor loja/depósito
                      + ponto de entrega). Fora dele há 1 ponto só e o "Modo de retirada"
                      já define o tipo — trocar aqui para "entrega" criaria um híbrido
                      incoerente sem o par retirada+entrega, então ocultamos o select. */}
                  {modoRetirada === 'hibrido' && (
                    <Field label="Tipo">
                      <select
                        {...register(`pontos_retirada.${i}.tipo`)}
                        className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                      >
                        <option value="loja">Loja</option>
                        <option value="deposito">Depósito</option>
                        <option value="entrega">Entrega</option>
                      </select>
                    </Field>
                  )}
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
                    onClick={() => {
                      removePonto(i);
                      // Garante que a aba ativa continue válida após a remoção
                      // (a lista encolhe de pontos.length para pontos.length - 1).
                      setAbaPonto((atual) =>
                        Number(atual) >= pontos.length - 1
                          ? String(Math.max(0, pontos.length - 2))
                          : atual,
                      );
                    }}
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
              <Controller
                control={control}
                name="forma_pagamento"
                render={({ field }) => (
                  <select
                    value={field.value ?? ''}
                    onChange={(e) => {
                      const v = e.target.value;
                      const forma = v === '' ? null : (v as (typeof FORMAS_PAGAMENTO)[number]);
                      field.onChange(forma);
                      // Forma sem parcelamento → zera parcelas (mantém consistência)
                      if (!forma || !FORMAS_COM_PARCELAS.has(forma)) {
                        setValue('parcelas', null, { shouldDirty: true });
                      }
                    }}
                    onBlur={field.onBlur}
                    className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                  >
                    <option value="">—</option>
                    {FORMAS_PAGAMENTO.map((f) => (
                      <option key={f} value={f}>
                        {rotuloFormaPagamento(f, null)}
                      </option>
                    ))}
                  </select>
                )}
              />
            </Field>
            {/* Independente da forma: o valor é recebido na entrega (motorista cobra). */}
            <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
              <input type="checkbox" {...register('receber_na_entrega')} className="h-4 w-4" />
              Receber na entrega
            </label>
            <div className="grid grid-cols-2 gap-4">
              {mostrarFrete && (
                <Field label="Frete (R$)" className="col-span-2">
                  <Input
                    type="number"
                    step="0.01"
                    {...register('valor_frete', { valueAsNumber: true })}
                    className="font-mono text-right"
                    placeholder="0,00"
                  />
                </Field>
              )}
              <Field label="Parcelas">
                <Controller
                  control={control}
                  name="parcelas"
                  render={({ field }) => {
                    const forma = watch('forma_pagamento');
                    const aceitaParcelas = !!forma && FORMAS_COM_PARCELAS.has(forma);
                    return (
                      <select
                        value={field.value ?? ''}
                        disabled={!aceitaParcelas}
                        onChange={(e) => {
                          const v = e.target.value;
                          field.onChange(v === '' ? null : Number(v));
                        }}
                        onBlur={field.onBlur}
                        className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <option value="">—</option>
                        {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
                          <option key={n} value={n}>
                            {n}x
                          </option>
                        ))}
                      </select>
                    );
                  }}
                />
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
          onClick={() => submit('em_financeiro')}
          disabled={pending}
          className="bg-brand hover:bg-brand-600"
        >
          {pending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          Enviar para Financeiro
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
  const generatedId = React.useId();
  // Se o child é um elemento que aceita `id` (Input, select etc.), clona com id
  // pra que <Label htmlFor=id> aponte corretamente — acessibilidade + RTL screen
  // readers + getByLabel em testes. Controller (RHF) é ignorado de propósito:
  // o id não propagaria pro DatePicker interno.
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
    <div className={className}>
      <Label
        htmlFor={htmlFor || undefined}
        className="text-xs text-muted-foreground mb-1.5 block"
      >
        {label} {required && <span className="text-destructive">*</span>}
      </Label>
      {child}
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
    keyName: '_rhfId', // preserva `id` (PK do banco) — ver comentário em PedidoForm
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
                <tr key={f._rhfId} className="border-t">
                  <td className="px-1 py-1">
                    {/* PK estável do item (presente ao editar; ausente ao criar novo) */}
                    <input
                      type="hidden"
                      {...register(`pontos_retirada.${pontoIndex}.itens.${i}.id`, {
                        setValueAs: (v: unknown) => (v === '' || v == null ? null : v),
                      })}
                    />
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
