import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import type { Database } from '@/lib/types/database';
import { supabaseUrl, supabaseAnonKey, SUPABASE_COOKIE_NAME } from './env';

/**
 * Refresh do JWT + roteamento por role.
 * Rotas públicas: /login, /auth/*, e assets (filtrados pelo matcher do middleware).
 */
const PUBLIC_PATHS = ['/login', '/auth'];

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    supabaseUrl(),
    supabaseAnonKey(),
    {
      cookieOptions: { name: SUPABASE_COOKIE_NAME },
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (toSet) => {
          toSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          toSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // IMPORTANTE: getUser() valida o JWT no servidor (não confia só no cookie).
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  // Não autenticado tentando acessar rota privada → /login
  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }

  // Autenticado em /login → redireciona para área do role
  if (user && pathname === '/login') {
    const { data: profile } = await supabase
      .from('profiles')
      .select('role, is_platform_admin')
      .eq('id', user.id)
      .single();

    const url = request.nextUrl.clone();
    url.pathname =
      profile?.is_platform_admin    ? '/plataforma' :
      profile?.role === 'logistica' ? '/logistica'  :
      profile?.role === 'financeiro'? '/financeiro' :
      profile?.role === 'admin'     ? '/admin'      :
      '/vendas';
    return NextResponse.redirect(url);
  }

  return response;
}
