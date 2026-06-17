'use client';

import { useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { puxarDoHiperAction } from '@/app/(app)/vendas/actions';

/**
 * Botão "Puxar": pede ao agente local (no hub) pra sincronizar AGORA os pedidos do
 * vendedor logado — sem esperar o ciclo automático. Só renderizado no hub (ver vendas/page).
 */
export function PuxarButton() {
  const [pending, start] = useTransition();
  return (
    <Button
      type="button"
      size="sm"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await puxarDoHiperAction();
          if (r.ok) toast.success(r.message);
          else toast.error(r.message);
        })
      }
    >
      {pending ? 'Puxando…' : 'Puxar'}
    </Button>
  );
}
