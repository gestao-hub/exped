'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Pencil, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/providers/confirm-provider';
import { corrigirPedidoAction } from '@/app/(app)/vendas/actions';

/**
 * "Corrigir pedido" — só aparece quando o pedido está no caixa (em_financeiro).
 * Devolve pra rascunho (sai do caixa) e leva direto pra tela de revisão/edição.
 */
export function CorrigirPedidoButton({ id }: { id: string }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const confirm = useConfirm();

  return (
    <Button
      variant="outline"
      disabled={pending}
      onClick={async () => {
        const ok = await confirm({
          title: 'Corrigir este pedido?',
          description:
            'O pedido sai do caixa e volta para edição. Depois é só revisar e enviar de novo.',
          confirmText: 'Corrigir pedido',
          cancelText: 'Voltar',
        });
        if (!ok) return;
        start(async () => {
          const r = await corrigirPedidoAction(id);
          if ('error' in r) {
            toast.error(r.error);
            return;
          }
          toast.success('Pedido reaberto para edição');
          router.push(`/vendas/${id}/revisar`);
        });
      }}
    >
      {pending ? (
        <Loader2 className="h-4 w-4 mr-1 animate-spin" />
      ) : (
        <Pencil className="h-4 w-4 mr-1" />
      )}
      Corrigir pedido
    </Button>
  );
}
