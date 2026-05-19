'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Check, PackageCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { registrarEntregaAction } from '@/app/(app)/vendas/actions';

type ItemLike = {
  id: string;
  codigo: string;
  descricao: string;
  quantidade: number;
  quantidade_entregue: number;
  unidade: string;
};

export function RegistrarEntregaDialog({
  pedidoId,
  itens,
  trigger,
}: {
  pedidoId: string;
  itens: ItemLike[];
  trigger: React.ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [valores, setValores] = useState<Record<string, string>>({});

  // Itens com saldo > 0 (ainda há o que entregar)
  const itensPendentes = useMemo(
    () =>
      itens
        .map((i) => ({
          ...i,
          restante: Math.max(0, Number(i.quantidade) - Number(i.quantidade_entregue)),
        }))
        .filter((i) => i.restante > 0),
    [itens],
  );

  function preencherTudo() {
    const next: Record<string, string> = {};
    for (const i of itensPendentes) next[i.id] = String(i.restante);
    setValores(next);
  }

  function salvar() {
    const items = itensPendentes
      .map((i) => ({
        id: i.id,
        entregue_agora: Math.max(0, Math.min(i.restante, Number(valores[i.id] || 0))),
      }))
      .filter((i) => i.entregue_agora > 0);

    if (items.length === 0) {
      toast.error('Informe a quantidade entregue em pelo menos um item');
      return;
    }

    start(async () => {
      const r = await registrarEntregaAction({ pedido_id: pedidoId, itens: items });
      if ('error' in r) {
        toast.error(r.error);
        return;
      }
      const msg =
        r.status === 'finalizado'
          ? 'Pedido entregue por completo! Status: finalizado'
          : r.status === 'parcialmente_entregue'
          ? 'Entrega registrada parcialmente. Pedido permanece na fila pra próxima viagem.'
          : 'Entrega registrada';
      toast.success(msg);
      setValores({});
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <span onClick={() => setOpen(true)}>{trigger}</span>
      <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PackageCheck className="h-5 w-5 text-franzoni-orange" />
            Registrar Entrega
          </DialogTitle>
          <DialogDescription>
            Informe quanto foi entregue NESTA viagem (não o acumulado). Se entregou tudo, use
            &quot;Preencher tudo&quot;. Saldo pendente fica pra próxima viagem.
          </DialogDescription>
        </DialogHeader>

        {itensPendentes.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Todos os itens já foram entregues.
          </p>
        ) : (
          <div className="space-y-3 max-h-[50vh] overflow-y-auto pr-1">
            <div className="flex justify-end">
              <Button type="button" size="sm" variant="outline" onClick={preencherTudo}>
                Preencher tudo (entregar restante)
              </Button>
            </div>
            {itensPendentes.map((i) => (
              <div
                key={i.id}
                className="grid grid-cols-12 gap-3 items-center border border-border/60 rounded-md px-3 py-2.5"
              >
                <div className="col-span-6 min-w-0">
                  <p className="text-sm font-medium truncate" title={i.descricao}>
                    {i.descricao}
                  </p>
                  <p className="text-xs text-muted-foreground font-mono">
                    Código {i.codigo} · {i.unidade}
                  </p>
                </div>
                <div className="col-span-3 text-xs text-muted-foreground">
                  <div>
                    Pedido <span className="font-mono">{Number(i.quantidade)}</span>
                  </div>
                  <div>
                    Já entregue <span className="font-mono">{Number(i.quantidade_entregue)}</span>
                  </div>
                  <div>
                    Restante <span className="font-mono font-semibold text-foreground">{i.restante}</span>
                  </div>
                </div>
                <div className="col-span-3">
                  <Label className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 block">
                    Entregue agora
                  </Label>
                  <Input
                    type="number"
                    step="0.001"
                    min={0}
                    max={i.restante}
                    value={valores[i.id] ?? ''}
                    onChange={(e) => setValores((v) => ({ ...v, [i.id]: e.target.value }))}
                    className="h-9 text-right font-mono"
                    placeholder="0"
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            Cancelar
          </Button>
          <Button
            onClick={salvar}
            disabled={pending || itensPendentes.length === 0}
            className="bg-franzoni-orange hover:bg-franzoni-orange-600"
          >
            {pending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Check className="h-4 w-4 mr-2" />
            )}
            Registrar entrega
          </Button>
        </DialogFooter>
      </DialogContent>
      </Dialog>
    </>
  );
}
