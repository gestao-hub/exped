import { cn } from '@/lib/utils';

/**
 * Logo Franzoni placeholder.
 * Substitua por <Image src="/logo.png" .../> quando o PNG estiver em /public.
 */
export function FranzoniLogo({
  className,
  variant = 'light',
}: {
  className?: string;
  variant?: 'light' | 'dark';
}) {
  return (
    <div
      className={cn(
        'inline-flex items-baseline gap-1.5 font-heading font-bold tracking-tight leading-none select-none',
        className,
      )}
    >
      <span
        className={cn(
          'text-franzoni-orange',
          variant === 'dark' ? 'text-franzoni-orange-500' : '',
        )}
      >
        Franzoni
      </span>
      <span
        className={cn(
          'text-xs font-medium uppercase tracking-widest',
          variant === 'dark' ? 'text-franzoni-navy-100' : 'text-white/70',
        )}
      >
        Casa &amp; Construção
      </span>
    </div>
  );
}
