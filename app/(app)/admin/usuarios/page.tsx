import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/layout/page-header';
import { ContentCard } from '@/components/layout/content-card';
import { UsuariosTable } from '@/components/usuarios-table';
import { ColaboradorForm } from './colaborador-form';
import { createClient } from '@/lib/supabase/server';
import { isHub } from '@/lib/runtime';
import type { Profile } from '@/lib/types';

export const dynamic = 'force-dynamic';

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
    .order('ativo', { ascending: false })
    .order('role')
    .order('email');

  const list = (profiles ?? []) as Profile[];
  const hub = isHub();
  const ativos = list.filter((p) => p.ativo).length;

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <PageHeader
        title="Equipe"
        description={
          hub
            ? 'Visualização. A gestão da equipe (adicionar/desativar) é feita no Exped na nuvem.'
            : `${ativos} colaborador${ativos === 1 ? '' : 'es'} ativo${ativos === 1 ? '' : 's'}.`
        }
        actions={hub ? undefined : <ColaboradorForm />}
      />

      <ContentCard variant="flush" className="flex flex-col flex-1 min-h-0">
        {error ? (
          <p className="p-6 text-sm text-destructive">{error.message}</p>
        ) : (
          <div className="flex-1 overflow-y-auto min-h-0">
            <UsuariosTable profiles={list} currentUserId={user.id} canManage={!hub} />
          </div>
        )}
      </ContentCard>
    </div>
  );
}
