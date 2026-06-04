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
import { Badge } from '@/components/ui/badge';
import { SortableHead, type SortDir } from '@/components/ui/sortable-head';
import { RoleSelect } from '@/app/(app)/admin/usuarios/role-select';
import { ColaboradorActions } from '@/app/(app)/admin/usuarios/colaborador-actions';
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
  canManage,
}: {
  profiles: Profile[];
  currentUserId: string;
  canManage: boolean;
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
    <>
      {/* MOBILE: cards verticais */}
      <ul className="md:hidden divide-y divide-border/50">
        {sorted.map((p) => (
          <li key={p.id} className="px-4 py-3 flex items-center gap-3">
            <Avatar className="h-9 w-9 bg-brand/15 ring-1 ring-brand/25 shrink-0">
              <AvatarFallback className="bg-transparent text-xs font-semibold text-brand-700">
                {initials(p.full_name || p.email)}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="font-medium text-sm truncate">{p.full_name || '—'}</p>
              <p className="text-xs text-muted-foreground font-mono truncate">{p.email}</p>
            </div>
            <div className="shrink-0 flex flex-col items-end gap-1">
              {!p.ativo && <Badge variant="secondary">Inativo</Badge>}
              {canManage ? (
                <>
                  <RoleSelect
                    userId={p.id}
                    currentRole={p.role}
                    disabled={p.id === currentUserId || !p.ativo}
                  />
                  <ColaboradorActions userId={p.id} ativo={p.ativo} disabled={p.id === currentUserId} />
                </>
              ) : (
                <span className="text-sm text-muted-foreground">{p.role}</span>
              )}
            </div>
          </li>
        ))}
        {sorted.length === 0 && (
          <li className="text-center text-muted-foreground py-12">Nenhum usuário.</li>
        )}
      </ul>

      {/* DESKTOP: tabela */}
      <Table className="hidden md:table table-fixed w-full">
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
            width="w-32"
            sortKey="created_at"
            current={sortBy}
            dir={sortDir}
            onClickAction={toggleSort}
          >
            Criado em
          </SortableHead>
          <th className="w-48 pr-5 text-right text-xs font-medium text-muted-foreground">
            Status
          </th>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((p) => (
          <TableRow key={p.id} className="hover:bg-brand/5">
            <TableCell className="pl-5 min-w-0">
              <div className="flex items-center gap-3 min-w-0">
                <Avatar className="h-8 w-8 bg-brand/15 ring-1 ring-brand/25 shrink-0">
                  <AvatarFallback className="bg-transparent text-xs font-semibold text-brand-700">
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
              {canManage ? (
                <RoleSelect
                  userId={p.id}
                  currentRole={p.role}
                  disabled={p.id === currentUserId || !p.ativo}
                />
              ) : (
                <span className="text-sm">{p.role}</span>
              )}
            </TableCell>
            <TableCell className="text-sm text-muted-foreground">
              {p.created_at
                ? format(new Date(p.created_at), "dd 'de' MMM yyyy", { locale: ptBR })
                : '—'}
            </TableCell>
            <TableCell className="pr-5">
              <div className="flex items-center justify-end gap-2">
                {!p.ativo && <Badge variant="secondary">Inativo</Badge>}
                {canManage && (
                  <ColaboradorActions userId={p.id} ativo={p.ativo} disabled={p.id === currentUserId} />
                )}
              </div>
            </TableCell>
          </TableRow>
        ))}
        {sorted.length === 0 && (
          <TableRow>
            <TableCell colSpan={5} className="text-center text-muted-foreground py-12">
              Nenhum usuário.
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
    </>
  );
}
