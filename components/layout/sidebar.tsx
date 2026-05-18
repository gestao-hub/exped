'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Package,
  PackagePlus,
  TruckIcon,
  ScanLine,
  History,
  Users,
  LogOut,
  Moon,
  Sun,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { FranzoniLogo } from '@/components/franzoni-logo';
import { useUser } from '@/components/providers/user-provider';
import type { UserRole } from '@/lib/types';
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
  ],
  logistica: [
    {
      title: 'Operação',
      items: [
        { label: 'Fila',         href: '/logistica',                      icon: TruckIcon },
        { label: 'Em Separação', href: '/logistica?status=em_separacao', icon: ScanLine },
      ],
    },
    {
      title: 'Consulta',
      items: [{ label: 'Histórico', href: '/historico', icon: History }],
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
      items: [{ label: 'Usuários', href: '/admin/usuarios', icon: Users }],
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

export function Sidebar() {
  const { profile } = useUser();
  const pathname = usePathname();
  const { setTheme, resolvedTheme } = useTheme();
  const sections = NAV[profile.role] ?? NAV.vendedor;

  return (
    <aside className="hidden md:flex w-64 shrink-0 flex-col sidebar-surface text-white">
      {/* Logo — compacto, sem ar extra */}
      <div className="px-3 pt-3 pb-3 flex items-center justify-center border-b border-white/6">
        <Link href="/" className="block transition-opacity hover:opacity-90">
          <FranzoniLogo size={80} variant="light" />
        </Link>
      </div>

      {/* Nav — itens em card-glass com seções */}
      <nav className="flex-1 py-2 overflow-y-auto">
        {sections.map((section, sIdx) => (
          <div key={section.title} className={cn('px-2', sIdx > 0 && 'mt-1.5')}>
            <p className="nav-section-label">{section.title}</p>
            <ul className="space-y-1">
              {section.items.map((item) => {
                const targetPath = item.href.split('?')[0];
                const active =
                  pathname === targetPath ||
                  (targetPath !== '/' && pathname.startsWith(targetPath + '/'));
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
      </nav>

      {/* Footer: user + theme + logout */}
      <div className="border-t border-white/6 px-3 py-3 space-y-2">
        <div className="flex items-center gap-3 px-1">
          <Avatar className="h-8 w-8 bg-franzoni-orange/20 ring-1 ring-franzoni-orange/35">
            <AvatarFallback className="bg-transparent text-xs font-semibold text-franzoni-orange-100">
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
