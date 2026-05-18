'use client';

import { useMemo, useState } from 'react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { SortableHead, type SortDir } from '@/components/ui/sortable-head';
import { RoleSelect } from '@/app/(app)/admin/usuarios/role-select';
import type { Profile } from '@/lib/types';

type SortKey = 'full_name' | 'email' | 'role' | 'created_at';

const ROLE_ORDER: Record<string, number> = { admin: 0, logistica: 1, vendedor: 2 };

function initials(name: string) {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? '')
      .join('') || '?'
  );
}

export function UsuariosTable({
  profiles,
  currentUserId,
}: {
  profiles: Profile[];
  currentUserId: string;
}) {
  const [sortBy, setSortBy] = useState<SortKey>('role');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  function toggleSort(key: SortKey) {
    if (sortBy === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(key);
      setSortDir(key === 'created_at' ? 'desc' : 'asc');
    }
  }

  const sorted = useMemo(() => {
    const copy = [...profiles];
    copy.sort((a, b) => {
      let cmp = 0;
      if (sortBy === 'role') {
        cmp = (ROLE_ORDER[a.role] ?? 99) - (ROLE_ORDER[b.role] ?? 99);
      } else if (sortBy === 'created_at') {
        cmp = (a.created_at ?? '').localeCompare(b.created_at ?? '');
      } else {
        const av = ((a[sortBy] as string) ?? '').toLocaleLowerCase('pt-BR');
        const bv = ((b[sortBy] as string) ?? '').toLocaleLowerCase('pt-BR');
        cmp = av.localeCompare(bv, 'pt-BR');
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return copy;
  }, [profiles, sortBy, sortDir]);

  return (
    <Table className="table-fixed w-full">
      <TableHeader className="sticky top-0 z-10 bg-white/90 dark:bg-zinc-900/90 backdrop-blur-md">
        <TableRow className="hover:bg-transparent">
          <SortableHead
            width="w-[32%] min-w-0 pl-5"
            sortKey="full_name"
            current={sortBy}
            dir={sortDir}
            onClickAction={toggleSort}
          >
            Nome
          </SortableHead>
          <SortableHead
            width="w-[34%] min-w-0"
            sortKey="email"
            current={sortBy}
            dir={sortDir}
            onClickAction={toggleSort}
          >
            E-mail
          </SortableHead>
          <SortableHead
            width="w-40"
            sortKey="role"
            current={sortBy}
            dir={sortDir}
            onClickAction={toggleSort}
          >
            Role
          </SortableHead>
          <SortableHead
            width="w-36 pr-5"
            sortKey="created_at"
            current={sortBy}
            dir={sortDir}
            onClickAction={toggleSort}
          >
            Criado em
          </SortableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((p) => (
          <TableRow key={p.id} className="hover:bg-franzoni-orange/5">
            <TableCell className="pl-5 min-w-0">
              <div className="flex items-center gap-3 min-w-0">
                <Avatar className="h-8 w-8 bg-franzoni-orange/15 ring-1 ring-franzoni-orange/25 shrink-0">
                  <AvatarFallback className="bg-transparent text-xs font-semibold text-franzoni-orange-700">
                    {initials(p.full_name || p.email)}
                  </AvatarFallback>
                </Avatar>
                <span className="font-medium truncate" title={p.full_name || ''}>
                  {p.full_name || '—'}
                </span>
              </div>
            </TableCell>
            <TableCell
              className="text-muted-foreground font-mono text-xs truncate"
              title={p.email}
            >
              {p.email}
            </TableCell>
            <TableCell>
              <RoleSelect
                userId={p.id}
                currentRole={p.role}
                disabled={p.id === currentUserId}
              />
            </TableCell>
            <TableCell className="text-sm text-muted-foreground pr-5">
              {p.created_at
                ? format(new Date(p.created_at), "dd 'de' MMM yyyy", { locale: ptBR })
                : '—'}
            </TableCell>
          </TableRow>
        ))}
        {sorted.length === 0 && (
          <TableRow>
            <TableCell colSpan={4} className="text-center text-muted-foreground py-12">
              Nenhum usuário.
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}
