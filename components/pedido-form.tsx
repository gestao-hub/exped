'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';
import { useTransition } from 'react';
import { Controller, useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Trash2, Loader2, Store, Truck } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { criarPedidoAction, atualizarPedidoAction } from '@/app/(app)/vendas/actions';
import { pedidoFormSchema, type PedidoFormInput } from '@/lib/validators/pedido';
import { sincronizarDestinos, normalizarParaForm } from '@/lib/pedidos/sincronizar-destinos';
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

  // Forma de trabalho do form: a modalidade vive POR ITEM (coluna na tabela) e é a
  // fonte da verdade. Internamente consolidamos tudo em 2 "pontos" de trabalho —
  // [0]=loja (carrega TODOS os itens, a tabela única) e [1]=entrega (só guarda o
  // destino de entrega). No submit, `sincronizarDestinos` reconstrói os pontos reais
  // a partir das modalidades dos itens. Normalização feita uma vez (defaultValues é
  // estável; o form mantém o estado a partir daqui).
  const initialDefaults = React.useMemo(() => {
    const { loja, entrega, imediato } = normalizarParaForm(defaultValues.pontos_retirada);
    // [0]=loja (todos os itens), [1]=entrega (só destino), [2]=imediato (só a PK do
    // ponto-container, pra UPDATE in-place). O card Destino só usa os índices 0 e 1.
    return { ...defaultValues, pontos_retirada: [loja, entrega, imediato] };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const form = useForm<PedidoFormInput>({
    resolver: zodResolver(pedidoFormSchema),
    defaultValues: initialDefaults,
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
  // Modalidades em uso, derivadas dos itens (a coluna Modalidade é a fonte da verdade).
  // O índice 0 (`loja`) carrega TODOS os itens; o índice 1 (`entrega`) só guarda o
  // destino de entrega. Observamos os itens do ponto 0 pra recalcular os blocos do
  // card Destino quando o operador troca a modalidade de uma linha.
  const itensWatch = watch('pontos_retirada.0.itens');
  const temItemLoja = (itensWatch ?? []).some((it) => it?.modalidade === 'loja');
  const temItemEntrega = (itensWatch ?? []).some((it) => it?.modalidade === 'entrega');
  // Frete é nível-pedido (valor_frete). Mostra quando há entrega ou já há um valor.
  const freteWatch = watch('valor_frete');
  const mostrarFrete = temItemEntrega || Number(freteWatch ?? 0) > 0;

  /**
   * Reconstrói `pontos_retirada` a partir das modalidades dos itens + os dados dos
   * destinos (ponto loja[0], entrega[1] e imediato[2] da forma de trabalho). Grava o
   * resultado no form ANTES de validar, pra que o resolver veja a forma canônica que
   * a persistência espera. A regra `min(1)` do schema é satisfeita naturalmente:
   * havendo qualquer item, sai ao menos 1 ponto (loja, entrega OU imediato).
   */
  function rebuildPontos() {
    const trabalho = getValues('pontos_retirada') ?? [];
    const lojaInfo = trabalho[0];
    const entregaInfo = trabalho[1];
    const imediatoInfo = trabalho[2];
    const itens = lojaInfo?.itens ?? [];

    const pontos = sincronizarDestinos({
      itens,
      loja: { id: lojaInfo?.id, empresa_nome: lojaInfo?.empresa_nome, endereco: lojaInfo?.endereco },
      entrega: {
        id: entregaInfo?.id,
        empresa_nome: entregaInfo?.empresa_nome,
        endereco: entregaInfo?.endereco,
      },
      // Carrega a PK do ponto-container imediato (se já existia) pra UPDATE in-place.
      imediato: { id: imediatoInfo?.id },
    });

    setValue('pontos_retirada', pontos, { shouldDirty: true, shouldValidate: false });
  }

  function submit(status: 'rascunho' | 'em_financeiro') {
    // Re-deriva os pontos das modalidades dos itens ANTES de validar/enviar.
    rebuildPontos();
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

      {/* Itens — a modalidade (Imediato/Loja/Entrega) é escolhida POR ITEM na coluna
          Modalidade; o card Destino abaixo deriva dos itens. */}
      <Card>
        <CardHeader>
          <CardTitle>Itens</CardTitle>
        </CardHeader>
        <CardContent>
          {/* PKs estáveis dos pontos de trabalho (loja[0] e entrega[1]) — preservadas
              pra reconciliação fazer UPDATE in-place ao salvar. */}
          <input
            type="hidden"
            {...register('pontos_retirada.0.id', {
              setValueAs: (v: unknown) => (v === '' || v == null ? null : v),
            })}
          />
          <input
            type="hidden"
            {...register('pontos_retirada.1.id', {
              setValueAs: (v: unknown) => (v === '' || v == null ? null : v),
            })}
          />
          <ItensEditor pontoIndex={0} control={control} register={register} />
        </CardContent>
      </Card>

      {/* Destino — derivado das modalidades dos itens. Só aparece o bloco da
          modalidade em uso (Loja se houver item Loja; Entrega se houver item Entrega).
          Pedido só com itens Imediato não tem destino. */}
      {(temItemLoja || temItemEntrega) && (
        <Card>
          <CardHeader>
            <CardTitle>Destino</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {temItemLoja && (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Store className="h-4 w-4 text-brand" /> Retirada na loja
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <Field label="Empresa / Loja" className="md:col-span-1">
                    <Input {...register('pontos_retirada.0.empresa_nome')} />
                  </Field>
                  <Field label="Endereço" className="md:col-span-2">
                    <Input {...register('pontos_retirada.0.endereco')} />
                  </Field>
                </div>
              </div>
            )}

            {temItemLoja && temItemEntrega && <Separator />}

            {temItemEntrega && (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Truck className="h-4 w-4 text-brand" /> Entrega
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <Field label="Destinatário" className="md:col-span-1">
                    <Input {...register('pontos_retirada.1.empresa_nome')} />
                  </Field>
                  <Field label="Endereço de entrega" className="md:col-span-2">
                    <Input {...register('pontos_retirada.1.endereco')} />
                  </Field>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  O frete é informado no card Pagamento (nível do pedido).
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

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
              modalidade: 'loja', // item novo nasce Loja (padrão); operador ajusta
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
                <th className="text-left  px-2 py-2 w-32">Modalidade</th>
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
                    {/* Modalidade do item = fonte da verdade de como o cliente recebe.
                        O card Destino abaixo deriva dos valores desta coluna. */}
                    <Controller
                      control={control}
                      name={`pontos_retirada.${pontoIndex}.itens.${i}.modalidade`}
                      render={({ field }) => (
                        <select
                          value={field.value ?? 'loja'}
                          onChange={field.onChange}
                          onBlur={field.onBlur}
                          className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm"
                        >
                          <option value="imediato">Imediato</option>
                          <option value="loja">Loja</option>
                          <option value="entrega">Entrega</option>
                        </select>
                      )}
                    />
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
                    <div className="flex items-center justify-end gap-0.5">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => remove(i)}
                        aria-label="Remover item"
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
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
