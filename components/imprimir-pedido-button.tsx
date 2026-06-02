'use client';

import { useState } from 'react';
import { Printer } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Botão "Imprimir" com o check "Guia do cliente" ao lado — a escolha é feita
 * AQUI (na tela do pedido), antes de abrir a impressão. O valor vai como
 * ?guia=1|0 pra página de impressão, que já abre com 1 ou 2 vias — sem precisar
 * fechar o diálogo e reimprimir.
 */
export function ImprimirPedidoButton({
  id,
  label = 'Imprimir',
}: {
  id: string;
  label?: string;
}) {
  const [guiaCliente, setGuiaCliente] = useState(true);

  return (
    <div className="flex items-center gap-3">
      <label className="flex items-center gap-1.5 text-sm text-muted-foreground cursor-pointer select-none">
        <input
          type="checkbox"
          checked={guiaCliente}
          onChange={(e) => setGuiaCliente(e.target.checked)}
          className="h-4 w-4 accent-franzoni-navy"
        />
        Guia do cliente
      </label>
      <a
        href={`/imprimir/${id}?guia=${guiaCliente ? 1 : 0}`}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(buttonVariants({ variant: 'outline' }))}
      >
        <Printer className="h-4 w-4 mr-1" /> {label}
      </a>
    </div>
  );
}
