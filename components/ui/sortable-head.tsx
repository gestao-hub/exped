'use client';

import { ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import { TableHead } from '@/components/ui/table';
import { cn } from '@/lib/utils';

export type SortDir = 'asc' | 'desc';

/**
 * TableHead clicável que mostra o estado de ordenação.
 * Genérico em K para o caller definir o tipo da chave.
 */
export function SortableHead<K extends string>({
  children,
  sortKey,
  current,
  dir,
  onClickAction,
  width,
  align = 'left',
}: {
  children: React.ReactNode;
  sortKey: K;
  current: K;
  dir: SortDir;
  onClickAction: (k: K) => void;
  width?: string;
  align?: 'left' | 'right';
}) {
  const active = current === sortKey;
  const Icon = !active ? ArrowUpDown : dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <TableHead className={cn(width, align === 'right' && 'text-right')}>
      <button
        type="button"
        onClick={() => onClickAction(sortKey)}
        className={cn(
          'inline-flex items-center gap-1.5 select-none',
          'hover:text-foreground transition-colors',
          active ? 'text-foreground font-semibold' : 'text-muted-foreground',
          align === 'right' && 'flex-row-reverse',
        )}
      >
        <span>{children}</span>
        <Icon className={cn('h-3.5 w-3.5', active ? 'opacity-100' : 'opacity-40')} />
      </button>
    </TableHead>
  );
}
