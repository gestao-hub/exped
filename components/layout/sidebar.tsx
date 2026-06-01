'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Package,
  PackagePlus,
  TruckIcon,
  History,
  Users,
  UsersRound,
  LogOut,
  Moon,
  Sun,
  Lightbulb,
  Building2,
  Wrench,
  Settings,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { BrandLogo } from '@/components/layout/brand-logo';
import { useUser } from '@/components/providers/user-provider';
import type { UserRole } from '@/lib/types';
import type { EmpresaAtual } from '@/lib/empresa/current';
import type { LucideIcon } from 'lucide-react';

type NavItem = { label: string; href: string; icon: LucideIcon };
type NavSection = { title: string; items: NavItem[] };

const NAV: Record<UserRole, NavSection[]> = {
  vendedor: [
    {
      title: 'Operação',
      items: [
        { label: 'Meus Pedidos', href: '/vendas',      icon: Package },
        { label: 'Novo Pedido',  href: '/vendas/novo', icon: PackagePlus },
      ],
    },
    {
      title: 'Consulta',
      items: [{ label: 'Histórico', href: '/historico', icon: History }],
    },
    {
      title: 'Ajuda',
      items: [{ label: 'Tutorial', href: '/tutorial', icon: Lightbulb }],
    },
  ],
  logistica: [
    {
      title: 'Operação',
      items: [{ label: 'Fila', href: '/logistica', icon: TruckIcon }],
    },
    {
      title: 'Consulta',
      items: [{ label: 'Histórico', href: '/historico', icon: History }],
    },
    {
      title: 'Ajuda',
      items: [{ label: 'Tutorial', href: '/tutorial', icon: Lightbulb }],
    },
  ],
  admin: [
    {
      title: 'Principal',
      items: [{ label: 'Dashboard', href: '/admin', icon: LayoutDashboard }],
    },
    {
      title: 'Operação',
      items: [
        { label: 'Pedidos',     href: '/vendas',      icon: Package },
        { label: 'Novo Pedido', href: '/vendas/novo', icon: PackagePlus },
        { label: 'Logística',   href: '/logistica',   icon: TruckIcon },
      ],
    },
    {
      title: 'Consulta',
      items: [{ label: 'Histórico', href: '/historico', icon: History }],
    },
    {
      title: 'Admin',
      items: [
        { label: 'Clientes', href: '/admin/clientes', icon: UsersRound },
        { label: 'Usuários', href: '/admin/usuarios', icon: Users },
      ],
    },
    {
      title: 'Ajuda',
      items: [{ label: 'Tutorial', href: '/tutorial', icon: Lightbulb }],
    },
  ],
};

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

/**
 * Encontra o item de menu que corresponde ao pathname atual com o
 * prefixo MAIS LONGO. Evita o caso em que /admin (dashboard) e
 * /admin/usuarios ficam ambos ativos quando você está em /admin/usuarios.
 */
function findActiveHref(pathname: string, sections: NavSection[]): string | null {
  let bestHref: string | null = null;
  let bestLen = -1;
  for (const section of sections) {
    for (const item of section.items) {
      const target = item.href.split('?')[0];
      const matches = pathname === target || (target !== '/' && pathname.startsWith(target + '/'));
      if (matches && target.length > bestLen) {
        bestLen = target.length;
        bestHref = item.href;
      }
    }
  }
  return bestHref;
}

export function Sidebar({ empresa }: { empresa?: EmpresaAtual | null }) {
  const { profile } = useUser();
  const pathname = usePathname();
  const { setTheme, resolvedTheme } = useTheme();
  // Operador (platform admin) tem sidebar enxuta — só "Plataforma".
  const sections = profile.is_platform_admin ? [] : (NAV[profile.role] ?? NAV.vendedor);
  const activeHref = findActiveHref(pathname, sections);

  return (
    <aside className="hidden md:flex w-64 shrink-0 flex-col sidebar-surface text-white">
      {/* Logo — compacto, sem ar extra */}
      <div className="px-3 pt-3 pb-3 flex items-center justify-center border-b border-white/6">
        <Link href="/" className="block text-center transition-opacity hover:opacity-90">
          <BrandLogo empresa={empresa} size={64} className="mx-auto" />
        </Link>
      </div>

      {/* Nav — itens em card-glass com seções */}
      <nav className="flex-1 py-2 overflow-y-auto sidebar-nav">
        {sections.map((section, sIdx) => (
          <div key={section.title} className={cn('px-2', sIdx > 0 && 'mt-1')}>
            <p className="nav-section-label">{section.title}</p>
            <ul className="space-y-1">
              {section.items.map((item) => {
                const active = item.href === activeHref;
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link href={item.href} className="nav-card-glass" data-active={active}>
                      <Icon className="h-4 w-4 shrink-0" />
                      <span className="truncate">{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
        {empresa?.usa_os && !profile.is_platform_admin && (
          <div className="px-2 mt-1">
            <p className="nav-section-label">Serviços</p>
            <ul className="space-y-1">
              <li>
                <Link href="/os" className="nav-card-glass" data-active={pathname.startsWith('/os')}>
                  <Wrench className="h-4 w-4 shrink-0" />
                  <span className="truncate">Ordens de Serviço</span>
                </Link>
              </li>
              {profile.role === 'admin' && (
                <li>
                  <Link href="/configuracoes" className="nav-card-glass" data-active={pathname.startsWith('/configuracoes')}>
                    <Settings className="h-4 w-4 shrink-0" />
                    <span className="truncate">Configurações</span>
                  </Link>
                </li>
              )}
            </ul>
          </div>
        )}
        {profile.is_platform_admin && (
          <div className="px-2 mt-1">
            <p className="nav-section-label">Operador</p>
            <ul className="space-y-1">
              <li>
                <Link href="/plataforma" className="nav-card-glass" data-active={pathname.startsWith('/plataforma')}>
                  <Building2 className="h-4 w-4 shrink-0" />
                  <span className="truncate">Plataforma</span>
                </Link>
              </li>
            </ul>
          </div>
        )}
      </nav>

      {/* Footer: user + theme + logout */}
      <div className="border-t border-white/6 px-3 py-3 space-y-2">
        <div className="flex items-center gap-3 px-1">
          <Avatar className="h-8 w-8 bg-brand/20 ring-1 ring-brand/35">
            <AvatarFallback className="bg-transparent text-xs font-semibold text-brand-100">
              {initials(profile.full_name || profile.email || '?')}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium truncate text-white/95 leading-tight">
              {profile.full_name || profile.email}
            </p>
            <p className="text-[11px] text-white/50 capitalize leading-tight mt-0.5">
              {profile.role}
            </p>
          </div>
        </div>

        <div className="flex gap-1.5">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Alternar tema"
            className="h-8 w-8 text-white/70 hover:text-white hover:bg-white/8"
            onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
          >
            {resolvedTheme === 'dark' ? (
              <Sun className="h-4 w-4" />
            ) : (
              <Moon className="h-4 w-4" />
            )}
          </Button>
          <form action="/auth/signout" method="post" className="flex-1">
            <Button
              type="submit"
              variant="ghost"
              size="sm"
              className="w-full justify-start text-white/75 hover:text-white hover:bg-white/8"
            >
              <LogOut className="h-4 w-4 mr-2" /> Sair
            </Button>
          </form>
        </div>
      </div>
    </aside>
  );
}
