'use client';

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import { Plus, Star, Pencil, Trash2, Loader2, Check, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createClient } from '@/lib/supabase/client';
import { useConfirm } from '@/components/providers/confirm-provider';
import { cn } from '@/lib/utils';
import {
  criarEnderecoAction,
  atualizarEnderecoAction,
  removerEnderecoAction,
  marcarPadraoAction,
  type EnderecoInput,
} from '@/app/(app)/admin/clientes/enderecos-actions';

export type Endereco = {
  id: string;
  cliente_id: string;
  rotulo: string;
  endereco: string | null;
  bairro: string | null;
  cidade: string | null;
  uf: string | null;
  cep: string | null;
  telefone: string | null;
  is_padrao: boolean;
};

export function deriveEnderecosManagerView<T>(
  clienteId: string,
  loadedClienteId: string | null,
  loadedEnderecos: T[],
  refreshing: boolean,
): { enderecos: T[]; loading: boolean } {
  const hasCurrentCliente = loadedClienteId === clienteId;
  return {
    enderecos: hasCurrentCliente ? loadedEnderecos : [],
    loading: refreshing || !hasCurrentCliente,
  };
}

export function EnderecosManager({
  clienteId,
  canEdit = true,
}: {
  clienteId: string;
  canEdit?: boolean;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [loaded, setLoaded] = useState<{
    clienteId: string | null;
    enderecos: Endereco[];
  }>({ clienteId: null, enderecos: [] });
  const [refreshing, setRefreshing] = useState(true);
  const [editingId, setEditingId] = useState<string | 'new' | null>(null);
  const [pending, start] = useTransition();
  const confirm = useConfirm();
  const { enderecos, loading } = deriveEnderecosManagerView(
    clienteId,
    loaded.clienteId,
    loaded.enderecos,
    refreshing,
  );

  const fetchList = useCallback(async () => {
    setRefreshing(true);
    const { data, error } = await supabase
      .from('cliente_enderecos')
      .select('*')
      .eq('cliente_id', clienteId)
      .order('is_padrao', { ascending: false })
      .order('created_at');
    if (error) toast.error(error.message);
    setLoaded({ clienteId, enderecos: (data ?? []) as Endereco[] });
    setRefreshing(false);
  }, [supabase, clienteId]);

  useEffect(() => {
    let cancelled = false;

    async function fetchInitialList() {
      const { data, error } = await supabase
        .from('cliente_enderecos')
        .select('*')
        .eq('cliente_id', clienteId)
        .order('is_padrao', { ascending: false })
        .order('created_at');
      if (cancelled) return;
      if (error) toast.error(error.message);
      setLoaded({ clienteId, enderecos: (data ?? []) as Endereco[] });
      setRefreshing(false);
    }

    void fetchInitialList();
    return () => {
      cancelled = true;
    };
  }, [supabase, clienteId]);

  function handleSave(input: EnderecoInput, id: string | null) {
    start(async () => {
      const r = id
        ? await atualizarEnderecoAction(id, input)
        : await criarEnderecoAction(clienteId, input);
      if ('error' in r) {
        toast.error(r.error);
        return;
      }
      toast.success(id ? 'Endereço atualizado' : 'Endereço adicionado');
      setEditingId(null);
      await fetchList();
    });
  }

  async function handleRemove(e: Endereco) {
    const ok = await confirm({
      title: 'Excluir este endereço?',
      description: `${e.rotulo}${e.endereco ? ' — ' + e.endereco : ''}`,
      confirmText: 'Excluir',
      variant: 'destructive',
    });
    if (!ok) return;
    start(async () => {
      const r = await removerEnderecoAction(e.id);
      if ('error' in r) {
        toast.error(r.error);
        return;
      }
      toast.success('Endereço removido');
      await fetchList();
    });
  }

  function handleSetPadrao(id: string) {
    start(async () => {
      const r = await marcarPadraoAction(id);
      if ('error' in r) {
        toast.error(r.error);
        return;
      }
      toast.success('Marcado como padrão');
      await fetchList();
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold">Endereços de entrega</h4>
        {canEdit && editingId !== 'new' && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setEditingId('new')}
            disabled={pending}
          >
            <Plus className="h-3.5 w-3.5 mr-1" /> Adicionar
          </Button>
        )}
      </div>

      {editingId === 'new' && (
        <EnderecoForm
          onSubmit={(i) => handleSave(i, null)}
          onCancel={() => setEditingId(null)}
          pending={pending}
        />
      )}

      {loading ? (
        <div className="h-16 rounded animate-pulse bg-muted/40" />
      ) : enderecos.length === 0 && editingId !== 'new' ? (
        <p className="text-xs text-muted-foreground italic py-2">
          Nenhum endereço cadastrado.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {enderecos.map((e) => (
            <li key={e.id}>
              {editingId === e.id ? (
                <EnderecoForm
                  initial={e}
                  onSubmit={(i) => handleSave(i, e.id)}
                  onCancel={() => setEditingId(null)}
                  pending={pending}
                />
              ) : (
                <div className="flex items-start justify-between gap-2 px-3 py-2 rounded-md border border-border/60 bg-muted/30">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">{e.rotulo}</span>
                      {e.is_padrao && (
                        <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-brand/20 text-brand-700">
                          Padrão
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground truncate">
                      {[
                        e.endereco,
                        e.bairro,
                        e.cidade && `${e.cidade}${e.uf ? '/' + e.uf : ''}`,
                        e.cep,
                      ]
                        .filter(Boolean)
                        .join(' · ') || '—'}
                    </p>
                  </div>
                  {canEdit && (
                    <div className="flex gap-0.5 shrink-0">
                      {!e.is_padrao && (
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          title="Marcar como padrão"
                          disabled={pending}
                          onClick={() => handleSetPadrao(e.id)}
                        >
                          <Star className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        title="Editar"
                        disabled={pending}
                        onClick={() => setEditingId(e.id)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-destructive hover:bg-destructive/10"
                        title="Excluir"
                        disabled={pending}
                        onClick={() => handleRemove(e)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EnderecoForm({
  initial,
  onSubmit,
  onCancel,
  pending,
}: {
  initial?: Endereco;
  onSubmit: (input: EnderecoInput) => void;
  onCancel: () => void;
  pending: boolean;
}) {
  const [form, setForm] = useState<EnderecoInput>({
    rotulo: initial?.rotulo ?? '',
    endereco: initial?.endereco ?? null,
    bairro: initial?.bairro ?? null,
    cidade: initial?.cidade ?? null,
    uf: initial?.uf ?? null,
    cep: initial?.cep ?? null,
    telefone: initial?.telefone ?? null,
  });

  const set =
    <K extends keyof EnderecoInput>(k: K) =>
    (v: EnderecoInput[K]) =>
      setForm((f) => ({ ...f, [k]: v }));

  function submit() {
    if (!form.rotulo.trim()) {
      toast.error('Informe um rótulo (ex.: Sede, Obra 1)');
      return;
    }
    onSubmit(form);
  }

  return (
    <div className="p-3 rounded-md border border-brand/30 bg-brand/5 space-y-2">
      <div className="grid grid-cols-1 md:grid-cols-6 gap-2">
        <Field label="Rótulo *" cls="md:col-span-2">
          <Input
            value={form.rotulo}
            placeholder="Ex.: Sede, Obra 1"
            onChange={(e) => set('rotulo')(e.target.value)}
          />
        </Field>
        <Field label="Endereço" cls="md:col-span-4">
          <Input
            value={form.endereco ?? ''}
            onChange={(e) => set('endereco')(e.target.value || null)}
          />
        </Field>
        <Field label="Bairro" cls="md:col-span-2">
          <Input
            value={form.bairro ?? ''}
            onChange={(e) => set('bairro')(e.target.value || null)}
          />
        </Field>
        <Field label="Cidade" cls="md:col-span-2">
          <Input
            value={form.cidade ?? ''}
            onChange={(e) => set('cidade')(e.target.value || null)}
          />
        </Field>
        <Field label="UF" cls="md:col-span-1">
          <Input
            maxLength={2}
            value={form.uf ?? ''}
            onChange={(e) => set('uf')(e.target.value.toUpperCase() || null)}
          />
        </Field>
        <Field label="CEP" cls="md:col-span-1">
          <Input
            value={form.cep ?? ''}
            onChange={(e) => set('cep')(e.target.value || null)}
          />
        </Field>
        <Field label="Telefone" cls="md:col-span-2">
          <Input
            value={form.telefone ?? ''}
            onChange={(e) => set('telefone')(e.target.value || null)}
          />
        </Field>
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" size="sm" variant="outline" onClick={onCancel} disabled={pending}>
          <X className="h-3.5 w-3.5 mr-1" /> Cancelar
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={submit}
          disabled={pending}
          className="bg-brand hover:bg-brand-600"
        >
          {pending ? (
            <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
          ) : (
            <Check className="h-3.5 w-3.5 mr-1" />
          )}
          Salvar
        </Button>
      </div>
    </div>
  );
}

function Field({
  label,
  cls,
  children,
}: {
  label: string;
  cls?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('space-y-1', cls)}>
      <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}
