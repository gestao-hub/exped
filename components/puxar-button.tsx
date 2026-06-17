'use client';

import { useTransition } from 'react';
import { toast } from 'sonner';
import { puxarDoHiperAction } from '@/app/(app)/vendas/actions';

/**
 * Botão "Sincronizar": pede ao agente local (no hub) pra puxar AGORA os pedidos do vendedor
 * logado do Hiper — sem esperar o ciclo automático. Só renderizado no hub (ver vendas/page).
 */
export function PuxarButton() {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await puxarDoHiperAction();
          if (r.ok) toast.success(r.message);
          else toast.error(r.message);
        })
      }
      className="inline-flex min-w-[220px] items-center justify-center gap-2 rounded-xl bg-[#F97316] px-10 py-3.5 text-base font-semibold text-white shadow-sm transition-colors hover:bg-[#EA580C] active:bg-[#C2410C] disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? 'Sincronizando…' : 'Sincronizar'}
    </button>
  );
}
