'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { Pencil, Trash2, Loader2, Search } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { SortableHead, type SortDir } from '@/components/ui/sortable-head';
import {
  updateClienteAction,
  deleteClienteAction,
  type UpdateClienteInput,
} from '@/app/(app)/admin/clientes/actions';

type Cliente = {
  id: string;
  nome: string;
  cnpj_cpf: string | null;
  codigo_erp: string | null;
  endereco_padrao: string | null;
  bairro_padrao: string | null;
  cidade_padrao: string | null;
  uf_padrao: string | null;
  cep_padrao: string | null;
  telefone_padrao: string | null;
  observacoes: string | null;
  created_at: string;
  pedidos_count: number;
};

type SortKey = 'nome' | 'cnpj_cpf' | 'pedidos_count' | 'created_at';

export function ClientesTable({ clientes }: { clientes: Cliente[] }) {
  const router = useRouter();
  const [sortBy, setSortBy] = useState<SortKey>('nome');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Cliente | null>(null);

  function toggleSort(key: SortKey) {
    if (sortBy === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortBy(key);
      setSortDir(key === 'pedidos_count' || key === 'created_at' ? 'desc' : 'asc');
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLocaleLowerCase('pt-BR');
    const arr = q
      ? clientes.filter(
          (c) =>
            c.nome.toLocaleLowerCase('pt-BR').includes(q) ||
            (c.cnpj_cpf ?? '').toLocaleLowerCase().includes(q) ||
            (c.bairro_padrao ?? '').toLocaleLowerCase('pt-BR').includes(q),
        )
      : [...clientes];
    arr.sort((a, b) => {
      let cmp = 0;
      if (sortBy === 'pedidos_count') cmp = a.pedidos_count - b.pedidos_count;
      else if (sortBy === 'created_at') cmp = a.created_at.localeCompare(b.created_at);
      else
        cmp = (a[sortBy] ?? '').toString().localeCompare(
          (b[sortBy] ?? '').toString(),
          'pt-BR',
        );
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [clientes, sortBy, sortDir, search]);

  return (
    <>
      <div className="px-5 py-3 border-b">
        <div className="relative max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Buscar por nome, CNPJ ou bairro…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      <Table className="table-fixed w-full">
        <TableHeader className="sticky top-0 z-10 bg-white/90 dark:bg-zinc-900/90 backdrop-blur-md">
          <TableRow className="hover:bg-transparent">
            <SortableHead
              width="w-[32%] min-w-0 pl-5"
              sortKey="nome"
              current={sortBy}
              dir={sortDir}
              onClickAction={toggleSort}
            >
              Nome
            </SortableHead>
            <SortableHead
              width="w-44 min-w-0"
              sortKey="cnpj_cpf"
              current={sortBy}
              dir={sortDir}
              onClickAction={toggleSort}
            >
              CNPJ/CPF
            </SortableHead>
            <SortableHead
              width="w-24"
              sortKey="pedidos_count"
              current={sortBy}
              dir={sortDir}
              onClickAction={toggleSort}
              align="right"
            >
              Pedidos
            </SortableHead>
            <SortableHead
              width="w-32"
              sortKey="created_at"
              current={sortBy}
              dir={sortDir}
              onClickAction={toggleSort}
            >
              Criado em
            </SortableHead>
            <th className="w-24 pr-5" aria-label="Ações" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="text-center text-muted-foreground py-12">
                Nenhum cliente {search ? 'pra esta busca' : 'cadastrado ainda'}.
              </TableCell>
            </TableRow>
          ) : (
            filtered.map((c) => (
              <TableRow key={c.id} className="hover:bg-franzoni-orange/5">
                <TableCell className="pl-5 min-w-0 font-medium truncate" title={c.nome}>
                  {c.nome}
                </TableCell>
                <TableCell
                  className="font-mono text-xs text-muted-foreground truncate"
                  title={c.cnpj_cpf ?? ''}
                >
                  {c.cnpj_cpf || '—'}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {c.pedidos_count}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {format(new Date(c.created_at), "dd 'de' MMM yyyy", { locale: ptBR })}
                </TableCell>
                <TableCell className="text-right pr-5">
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => setEditing(c)}
                      aria-label="Editar"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <DeleteButton id={c.id} count={c.pedidos_count} onDone={() => router.refresh()} />
                  </div>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      {editing && (
        <EditDialog
          cliente={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      )}
    </>
  );
}

function DeleteButton({
  id,
  count,
  onDone,
}: {
  id: string;
  count: number;
  onDone: () => void;
}) {
  const [pending, start] = useTransition();
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10"
      disabled={pending}
      onClick={() => {
        const msg =
          count > 0
            ? `Cliente tem ${count} pedido${count === 1 ? '' : 's'} vinculado${count === 1 ? '' : 's'}. Os pedidos não serão apagados, mas perderão o vínculo. Continuar?`
            : 'Excluir este cliente?';
        if (!window.confirm(msg)) return;
        start(async () => {
          const r = await deleteClienteAction(id);
          if ('error' in r) toast.error(r.error);
          else {
            toast.success('Cliente excluído');
            onDone();
          }
        });
      }}
      aria-label="Excluir"
    >
      {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
    </Button>
  );
}

function EditDialog({
  cliente,
  onClose,
  onSaved,
}: {
  cliente: Cliente;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<UpdateClienteInput>({
    id: cliente.id,
    nome: cliente.nome,
    cnpj_cpf: cliente.cnpj_cpf,
    codigo_erp: cliente.codigo_erp,
    endereco_padrao: cliente.endereco_padrao,
    bairro_padrao: cliente.bairro_padrao,
    cidade_padrao: cliente.cidade_padrao,
    uf_padrao: cliente.uf_padrao,
    cep_padrao: cliente.cep_padrao,
    telefone_padrao: cliente.telefone_padrao,
    observacoes: cliente.observacoes,
  });
  const [pending, start] = useTransition();

  const set =
    <K extends keyof UpdateClienteInput>(k: K) =>
    (v: UpdateClienteInput[K]) =>
      setForm((f) => ({ ...f, [k]: v }));

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Editar Cliente</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-1 md:grid-cols-6 gap-3 py-2 text-sm">
          <Field label="Nome" cls="md:col-span-4">
            <Input value={form.nome} onChange={(e) => set('nome')(e.target.value)} />
          </Field>
          <Field label="CNPJ/CPF" cls="md:col-span-2">
            <Input
              value={form.cnpj_cpf ?? ''}
              onChange={(e) => set('cnpj_cpf')(e.target.value || null)}
            />
          </Field>
          <Field label="Endereço padrão" cls="md:col-span-4">
            <Input
              value={form.endereco_padrao ?? ''}
              onChange={(e) => set('endereco_padrao')(e.target.value || null)}
            />
          </Field>
          <Field label="Bairro" cls="md:col-span-2">
            <Input
              value={form.bairro_padrao ?? ''}
              onChange={(e) => set('bairro_padrao')(e.target.value || null)}
            />
          </Field>
          <Field label="Cidade" cls="md:col-span-3">
            <Input
              value={form.cidade_padrao ?? ''}
              onChange={(e) => set('cidade_padrao')(e.target.value || null)}
            />
          </Field>
          <Field label="UF" cls="md:col-span-1">
            <Input
              maxLength={2}
              value={form.uf_padrao ?? ''}
              onChange={(e) => set('uf_padrao')(e.target.value.toUpperCase() || null)}
            />
          </Field>
          <Field label="CEP" cls="md:col-span-2">
            <Input
              value={form.cep_padrao ?? ''}
              onChange={(e) => set('cep_padrao')(e.target.value || null)}
            />
          </Field>
          <Field label="Telefone" cls="md:col-span-3">
            <Input
              value={form.telefone_padrao ?? ''}
              onChange={(e) => set('telefone_padrao')(e.target.value || null)}
            />
          </Field>
          <Field label="Código ERP" cls="md:col-span-3">
            <Input
              value={form.codigo_erp ?? ''}
              onChange={(e) => set('codigo_erp')(e.target.value || null)}
            />
          </Field>
          <Field label="Observações" cls="md:col-span-6">
            <Textarea
              rows={3}
              value={form.observacoes ?? ''}
              onChange={(e) => set('observacoes')(e.target.value || null)}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancelar
          </Button>
          <Button
            onClick={() => {
              start(async () => {
                const r = await updateClienteAction(form);
                if ('error' in r) toast.error(r.error);
                else {
                  toast.success('Cliente atualizado');
                  onSaved();
                }
              });
            }}
            disabled={pending}
            className="bg-franzoni-orange hover:bg-franzoni-orange-600"
          >
            {pending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, cls, children }: { label: string; cls?: string; children: React.ReactNode }) {
  return (
    <div className={cls}>
      <Label className="text-xs text-muted-foreground mb-1.5 block">{label}</Label>
      {children}
    </div>
  );
}
