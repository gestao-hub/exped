'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { X, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cancelarPedidoAction } from '@/app/(app)/vendas/actions';

export function CancelarPedidoButton({ id }: { id: string }) {
  const [pending, start] = useTransition();
  const router = useRouter();

  return (
    <Button
      variant="outline"
      className="text-destructive hover:text-destructive border-destructive/30"
      disabled={pending}
      onClick={() => {
        if (!confirm('Cancelar este pedido?')) return;
        start(async () => {
          const r = await cancelarPedidoAction(id);
          if ('error' in r) {
            toast.error(r.error);
            return;
          }
          toast.success('Pedido cancelado');
          router.refresh();
        });
      }}
    >
      {pending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <X className="h-4 w-4 mr-1" />}
      Cancelar Pedido
    </Button>
  );
}
