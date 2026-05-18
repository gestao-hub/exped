import Image from 'next/image';
import { cn } from '@/lib/utils';

/**
 * Logo Franzoni Casa & Construção.
 * - variant="light" (default): texto branco — use em fundos escuros (sidebar)
 * - variant="dark": texto navy — use em fundos claros (login, impressão)
 */
export function FranzoniLogo({
  className,
  variant = 'light',
  size = 40,
}: {
  className?: string;
  variant?: 'light' | 'dark';
  size?: number;
}) {
  const src = variant === 'dark' ? '/logo-dark.png' : '/logo-light.png';
  return (
    <Image
      src={src}
      alt="Franzoni Casa & Construção"
      width={size}
      height={size}
      priority
      className={cn('select-none object-contain', className)}
      style={{ height: size, width: 'auto' }}
    />
  );
}
