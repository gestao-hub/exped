import { AppLogo } from '@/components/app-logo';
import { cn } from '@/lib/utils';
import type { EmpresaAtual } from '@/lib/empresa/current';

/**
 * Logo de marca para superfícies ESCURAS (sidebar / header mobile), com white-label:
 *   1. empresa tem logo_url → logo do cliente (white-label)
 *   2. empresa sem logo     → nome do cliente em texto
 *   3. sem empresa (operador / pré-tenant) → logo do Exped (marca do produto)
 *
 * O login fica de fora de propósito: lá ainda não se sabe o tenant → sempre Exped.
 */
export function BrandLogo({
  empresa,
  size = 40,
  className,
}: {
  empresa?: EmpresaAtual | null;
  size?: number;
  className?: string;
}) {
  if (empresa?.logo_url) {
    return (
      // img simples (não next/image) pra aceitar URL relativa do bundle ou externa
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={empresa.logo_url}
        alt={empresa.nome}
        className={cn('w-auto object-contain select-none', className)}
        style={{ height: size }}
      />
    );
  }
  if (empresa) {
    return (
      <span
        className={cn(
          'block font-heading font-bold text-white truncate max-w-[180px]',
          className,
        )}
      >
        {empresa.nome}
      </span>
    );
  }
  return <AppLogo size={size} variant="light" className={className} />;
}
