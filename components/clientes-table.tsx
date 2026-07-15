'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { createClient } from '@/lib/supabase/client';
import { calcularPaginacao, PAGE_SIZE } from '@/lib/pedidos/paginacao';
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
import { useConfirm } from '@/components/providers/confirm-provider';
import { EnderecosManager } from '@/components/clientes/enderecos-manager';
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

type SortKey = 'nome' | 'cnpj_cpf' | 'created_at';

type ClienteQueryRow = Omit<Cliente, 'pedidos_count'> & {
  pedidos?: { count: number }[] | { count: number } | null;
};

export function ClientesTable() {
  const supabase = useMemo(() => createClient(), []);
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [sortBy, setSortBy] = useState<SortKey>('nome');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [tick, setTick] = useState(0);
  const [editing, setEditing] = useState<Cliente | null>(null);

  function toggleSort(key: SortKey) {
    if (sortBy === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortBy(key);
      setSortDir(key === 'created_at' ? 'desc' : 'asc');
    }
  }

  // Debounce da busca (300ms) — evita 1 query por tecla.
  useEffect(() => {
    const id = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(id);
  }, [searchInput]);

  // Volta pra página 1 ao mudar busca/ordenação.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPage(1);
  }, [search, sortBy, sortDir]);

  // Busca a página atual no servidor (offset + count + busca + ordenação).
  useEffect(() => {
    let cancel = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    const from = (Math.max(1, page) - 1) * PAGE_SIZE;
    let query = supabase
      .from('clientes')
      .select('*, pedidos:pedidos(count)', { count: 'exact' })
      .is('deleted_at', null)
      .is('pedidos.deleted_at', null)
      .order(sortBy, { ascending: sortDir === 'asc', nullsFirst: false })
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (search.trim()) {
      const q = `%${search.trim()}%`;
      query = query.or(`nome.ilike.${q},cnpj_cpf.ilike.${q},bairro_padrao.ilike.${q}`);
    }
    query.then(({ data, count, error }) => {
      if (cancel) return;
      if (error) toast.error(error.message);
      const rows: Cliente[] = ((data ?? []) as ClienteQueryRow[]).map((c) => {
        const countObj = Array.isArray(c.pedidos) ? c.pedidos[0] : c.pedidos;
        return { ...c, pedidos_count: countObj?.count ?? 0 } as Cliente;
      });
      setClientes(rows);
      setTotal(count ?? 0);
      setLoading(false);
    });
    return () => {
      cancel = true;
    };
  }, [supabase, page, sortBy, sortDir, search, tick]);

  const refetch = () => setTick((t) => t + 1);

  return (
    <>
      <div className="px-5 py-3 border-b">
        <div className="relative max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Buscar por nome, CNPJ ou bairro…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
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
            <th className="w-24 pr-2 text-right text-[11px] uppercase tracking-wider text-muted-foreground font-medium">
              Pedidos
            </th>
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
          {loading ? (
            <TableRow>
              <TableCell colSpan={5} className="text-center text-muted-foreground py-12">
                Carregando…
              </TableCell>
            </TableRow>
          ) : clientes.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="text-center text-muted-foreground py-12">
                Nenhum cliente {search ? 'pra esta busca' : 'cadastrado ainda'}.
              </TableCell>
            </TableRow>
          ) : (
            clientes.map((c) => (
              <TableRow key={c.id} className="hover:bg-brand/5">
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
                    <DeleteButton id={c.id} count={c.pedidos_count} onDone={refetch} />
                  </div>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      {(() => {
        const { totalPages, hasPrev, hasNext } = calcularPaginacao(page, total);
        return (
          <div className="flex items-center justify-between gap-3 px-5 py-3 text-sm text-muted-foreground border-t">
            <span>
              {total} {total === 1 ? 'cliente' : 'clientes'} · página {Math.min(page, totalPages)} de {totalPages}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={!hasPrev}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="px-3 py-1.5 rounded-md border disabled:opacity-40 disabled:cursor-not-allowed hover:bg-muted/60 transition-colors"
              >
                ‹ Anterior
              </button>
              <button
                type="button"
                disabled={!hasNext}
                onClick={() => setPage((p) => p + 1)}
                className="px-3 py-1.5 rounded-md border disabled:opacity-40 disabled:cursor-not-allowed hover:bg-muted/60 transition-colors"
              >
                Próxima ›
              </button>
            </div>
          </div>
        );
      })()}

      {editing && (
        <EditDialog
          cliente={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refetch();
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
  const confirm = useConfirm();
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10"
      disabled={pending}
      onClick={async () => {
        const description =
          count > 0
            ? `Cliente tem ${count} pedido${count === 1 ? '' : 's'} vinculado${count === 1 ? '' : 's'}. O cadastro será arquivado e os vínculos históricos serão preservados.`
            : 'O cadastro será arquivado e deixará de aparecer nas buscas.';
        const ok = await confirm({
          title: 'Excluir este cliente?',
          description,
          confirmText: 'Excluir',
          variant: 'destructive',
        });
        if (!ok) return;
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
        <div className="pt-2 mt-2 border-t border-border/60">
          <EnderecosManager clienteId={cliente.id} />
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
            className="bg-brand hover:bg-brand-600"
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
