'use client';

import { useEffect, useState } from 'react';

/**
 * Dispara window.print() automaticamente ~400ms após o carregamento,
 * dando tempo para imagens/fontes renderizarem.
 */
export function AutoPrint() {
  useEffect(() => {
    const t = setTimeout(() => window.print(), 400);
    return () => clearTimeout(t);
  }, []);
  return null;
}

export function PrintControls({ defaultGuia = true }: { defaultGuia?: boolean }) {
  // Guia do cliente = 2ª via destacável. A escolha já vem da tela do pedido
  // (?guia=1|0); aqui dá pra trocar e reimprimir se precisar.
  // Inativo → adiciona .sem-via-cliente no body e a 2ª via não é impressa.
  const [guiaCliente, setGuiaCliente] = useState(defaultGuia);

  useEffect(() => {
    document.body.classList.toggle('sem-via-cliente', !guiaCliente);
  }, [guiaCliente]);

  // Limpa a classe ao sair da página de impressão.
  useEffect(() => () => document.body.classList.remove('sem-via-cliente'), []);

  return (
    <div className="no-print p-3 border-b flex items-center justify-between gap-4 bg-muted/30 text-sm">
      <button onClick={() => window.close()} className="underline">
        Fechar
      </button>
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={guiaCliente}
          onChange={(e) => setGuiaCliente(e.target.checked)}
          className="h-4 w-4 accent-franzoni-navy"
        />
        <span>
          Guia do cliente{' '}
          <span className="text-muted-foreground">(2ª via destacável)</span>
        </span>
      </label>
      <button onClick={() => window.print()} className="underline">
        Imprimir novamente
      </button>
    </div>
  );
}
