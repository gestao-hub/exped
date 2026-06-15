'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { Loader2, MapPin, Plus, Check, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  matchEndereco,
  useEnderecosDoCliente,
  type ClienteEndereco,
} from '@/lib/hooks/use-enderecos-do-cliente';
import {
  criarEnderecoAction,
  type EnderecoInput,
} from '@/app/(app)/admin/clientes/enderecos-actions';

type SnapshotValues = {
  endereco: string | null;
  bairro: string | null;
  cidade: string | null;
  uf: string | null;
  cep: string | null;
  telefone: string | null;
};

export function EnderecoSelector({
  cnpjCpf,
  selectedId,
  currentValues,
  onPickAction,
  disabled,
}: {
  cnpjCpf: string | null | undefined;
  selectedId: string | null | undefined;
  currentValues: SnapshotValues;
  /** Chamado quando usuário escolhe um endereço cadastrado, ou null pra "Outro". */
  onPickAction: (endereco: ClienteEndereco | null) => void;
  disabled?: boolean;
}) {
  const { cliente, enderecos, loading, refetch } = useEnderecosDoCliente(cnpjCpf);
  const [showAddDialog, setShowAddDialog] = useState(false);
  // Garante que auto-match só roda uma vez por carregamento de lista
  const matchedRef = useRef<string | null>(null);

  // Auto-match: ao carregar enderecos, se nenhum estiver selecionado, tenta casar
  // com o endereço atual do formulário (vindo do PDF).
  useEffect(() => {
    if (loading) return;
    if (enderecos.length === 0) return;
    if (selectedId) return;
    const key = cliente?.id ?? '';
    if (matchedRef.current === key) return;
    matchedRef.current = key;
    const m = matchEndereco(currentValues.endereco, currentValues.cep, enderecos);
    if (m) onPickAction(m);
    // intencionalmente sem currentValues nas deps — só queremos auto-match na
    // carga; mudanças subsequentes do form são do próprio usuário.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, enderecos, cliente?.id]);

  // Sem CNPJ/CPF → não renderiza nada (fluxo legado preservado)
  const key = (cnpjCpf ?? '').trim();
  if (!key) return null;

  return (
    <div className="md:col-span-6">
      <div className="flex items-end gap-2 flex-wrap">
        <div className="flex-1 min-w-[220px]">
          <Label className="text-xs text-muted-foreground mb-1.5 block flex items-center gap-1.5">
            <MapPin className="h-3.5 w-3.5" />
            Endereço de entrega
            {loading && <Loader2 className="h-3 w-3 animate-spin" />}
          </Label>
          <Select
            value={selectedId ?? ''}
            items={{
              '': '— Outro endereço (digitar abaixo) —',
              ...Object.fromEntries(
                enderecos.map((e) => [e.id, `${e.rotulo}${e.is_padrao ? ' ★' : ''} — ${resumo(e)}`]),
              ),
            }}
            disabled={disabled || loading}
            onValueChange={(id) => {
              if (!id) {
                onPickAction(null);
                return;
              }
              const ende = enderecos.find((x) => x.id === id);
              if (ende) onPickAction(ende);
            }}
          >
            <SelectTrigger className="w-full h-9">
              <SelectValue placeholder="— Outro endereço (digitar abaixo) —" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">— Outro endereço (digitar abaixo) —</SelectItem>
              {enderecos.map((e) => (
                <SelectItem key={e.id} value={e.id}>
                  {e.rotulo}
                  {e.is_padrao ? ' ★' : ''} — {resumo(e)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {!selectedId && cliente && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => setShowAddDialog(true)}
          >
            <Plus className="h-3.5 w-3.5 mr-1" /> Salvar como novo endereço
          </Button>
        )}
      </div>
      {!cliente && enderecos.length === 0 && !loading && (
        <p className="text-[11px] text-muted-foreground mt-1">
          Primeiro pedido deste documento — endereço será cadastrado ao enviar.
        </p>
      )}

      {showAddDialog && cliente && (
        <AddEnderecoDialog
          clienteId={cliente.id}
          initial={currentValues}
          onClose={() => setShowAddDialog(false)}
          onCreated={async (id) => {
            setShowAddDialog(false);
            refetch();
            // Após refetch, seleciona o novo (re-roda quando enderecos atualizar)
            // garante seleção imediata: cria um objeto temporário
            const novo: ClienteEndereco = {
              id,
              cliente_id: cliente.id,
              rotulo: 'novo',
              endereco: currentValues.endereco,
              bairro: currentValues.bairro,
              cidade: currentValues.cidade,
              uf: currentValues.uf,
              cep: currentValues.cep,
              telefone: currentValues.telefone,
              is_padrao: false,
            };
            onPickAction(novo);
          }}
        />
      )}
    </div>
  );
}

function resumo(e: ClienteEndereco): string {
  const parts = [
    e.endereco,
    e.bairro,
    e.cidade && `${e.cidade}${e.uf ? '/' + e.uf : ''}`,
  ].filter(Boolean);
  return parts.join(' · ') || 'sem dados';
}

function AddEnderecoDialog({
  clienteId,
  initial,
  onClose,
  onCreated,
}: {
  clienteId: string;
  initial: SnapshotValues;
  onClose: () => void;
  onCreated: (id: string) => void | Promise<void>;
}) {
  const [pending, start] = useTransition();
  const [form, setForm] = useState<EnderecoInput>({
    rotulo: '',
    endereco: initial.endereco,
    bairro: initial.bairro,
    cidade: initial.cidade,
    uf: initial.uf,
    cep: initial.cep,
    telefone: initial.telefone,
  });

  const set =
    <K extends keyof EnderecoInput>(k: K) =>
    (v: EnderecoInput[K]) =>
      setForm((f) => ({ ...f, [k]: v }));

  function save() {
    if (!form.rotulo.trim()) {
      toast.error('Dê um rótulo (ex.: Sede, Obra 1)');
      return;
    }
    start(async () => {
      const r = await criarEnderecoAction(clienteId, form);
      if ('error' in r) {
        toast.error(r.error);
        return;
      }
      toast.success('Endereço salvo no cliente');
      await onCreated(r.id);
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Salvar como novo endereço</DialogTitle>
          <DialogDescription>
            Dê um rótulo (ex.: <em>Sede, Obra 1, Depósito Norte</em>) pra reaproveitar nas
            próximas entregas. Você pode editar os campos antes de salvar.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 md:grid-cols-6 gap-3 py-2">
          <FieldLite label="Rótulo *" cls="md:col-span-2">
            <Input
              value={form.rotulo}
              placeholder="Ex.: Obra 1"
              onChange={(e) => set('rotulo')(e.target.value)}
            />
          </FieldLite>
          <FieldLite label="Endereço" cls="md:col-span-4">
            <Input
              value={form.endereco ?? ''}
              onChange={(e) => set('endereco')(e.target.value || null)}
            />
          </FieldLite>
          <FieldLite label="Bairro" cls="md:col-span-2">
            <Input
              value={form.bairro ?? ''}
              onChange={(e) => set('bairro')(e.target.value || null)}
            />
          </FieldLite>
          <FieldLite label="Cidade" cls="md:col-span-2">
            <Input
              value={form.cidade ?? ''}
              onChange={(e) => set('cidade')(e.target.value || null)}
            />
          </FieldLite>
          <FieldLite label="UF" cls="md:col-span-1">
            <Input
              maxLength={2}
              value={form.uf ?? ''}
              onChange={(e) => set('uf')(e.target.value.toUpperCase() || null)}
            />
          </FieldLite>
          <FieldLite label="CEP" cls="md:col-span-1">
            <Input
              value={form.cep ?? ''}
              onChange={(e) => set('cep')(e.target.value || null)}
            />
          </FieldLite>
          <FieldLite label="Telefone" cls="md:col-span-2">
            <Input
              value={form.telefone ?? ''}
              onChange={(e) => set('telefone')(e.target.value || null)}
            />
          </FieldLite>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            <X className="h-4 w-4 mr-1" /> Cancelar
          </Button>
          <Button
            onClick={save}
            disabled={pending}
            className="bg-brand hover:bg-brand-600"
          >
            {pending ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <Check className="h-4 w-4 mr-1" />
            )}
            Salvar endereço
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FieldLite({
  label,
  cls,
  children,
}: {
  label: string;
  cls?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cls}>
      <Label className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 block">
        {label}
      </Label>
      {children}
    </div>
  );
}
