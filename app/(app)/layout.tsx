import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { Sidebar } from '@/components/layout/sidebar';
import { MobileHeader } from '@/components/layout/mobile-header';
import { UserProvider } from '@/components/providers/user-provider';
import { getEmpresaAtual } from '@/lib/empresa/current';
import type { Profile } from '@/lib/types';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();

  if (!profile) redirect('/auth/signout');

  const empresa = await getEmpresaAtual(supabase);

  return (
    <UserProvider profile={profile as Profile}>
      <div className="flex h-screen overflow-hidden">
        <Sidebar empresa={empresa} />
        <div className="flex-1 flex flex-col min-w-0">
          <MobileHeader />
          <main className="flex-1 min-h-0 overflow-y-auto px-4 md:px-8 py-6 md:py-8">
            <div className="mx-auto max-w-7xl w-full flex flex-col gap-6 min-h-[calc(100vh-3rem-4rem)] md:min-h-[calc(100vh-4rem)]">
              {children}
            </div>
          </main>
        </div>
      </div>
    </UserProvider>
  );
}
