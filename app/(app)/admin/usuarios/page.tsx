import { redirect } from 'next/navigation';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { PageHeader } from '@/components/layout/page-header';
import { ContentCard } from '@/components/layout/content-card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { createClient } from '@/lib/supabase/server';
import type { Profile } from '@/lib/types';
import { RoleSelect } from './role-select';

export const dynamic = 'force-dynamic';

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

export default async function UsuariosPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: me } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();
  if (me?.role !== 'admin') redirect('/vendas');

  const { data: profiles, error } = await supabase
    .from('profiles')
    .select('*')
    .order('role')
    .order('email');

  const list = (profiles ?? []) as Profile[];

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <PageHeader
        title="Usuários"
        description={`${list.length} usuário${list.length === 1 ? '' : 's'} ativos. Para criar novos, rode scripts/seed-users.ts ou crie via Supabase Dashboard.`}
      />

      <ContentCard variant="flush" className="flex flex-col flex-1 min-h-0">
        {error ? (
          <p className="p-6 text-sm text-destructive">{error.message}</p>
        ) : (
          <div className="flex-1 overflow-y-auto min-h-0">
          <Table className="table-fixed w-full">
            <TableHeader className="sticky top-0 z-10 bg-white/90 dark:bg-zinc-900/90 backdrop-blur-md">
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[32%] min-w-0 pl-5">Nome</TableHead>
                <TableHead className="w-[34%] min-w-0">E-mail</TableHead>
                <TableHead className="w-40">Role</TableHead>
                <TableHead className="w-36 pr-5">Criado em</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((p) => (
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
                  <TableCell className="text-muted-foreground font-mono text-xs truncate" title={p.email}>
                    {p.email}
                  </TableCell>
                  <TableCell>
                    <RoleSelect
                      userId={p.id}
                      currentRole={p.role}
                      disabled={p.id === user.id}
                    />
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground pr-5">
                    {p.created_at
                      ? format(new Date(p.created_at), "dd 'de' MMM yyyy", { locale: ptBR })
                      : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          </div>
        )}
      </ContentCard>
    </div>
  );
}
