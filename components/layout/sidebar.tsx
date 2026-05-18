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
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { FranzoniLogo } from '@/components/franzoni-logo';
import { useUser } from '@/components/providers/user-provider';
import type { UserRole } from '@/lib/types';
import type { LucideIcon } from 'lucide-react';

type NavItem = { label: string; href: string; icon: LucideIcon };

const NAV: Record<UserRole, NavItem[]> = {
  vendedor: [
    { label: 'Meus Pedidos', href: '/vendas',       icon: Package },
    { label: 'Novo Pedido',  href: '/vendas/novo',  icon: PackagePlus },
    { label: 'Histórico',    href: '/historico',    icon: History },
  ],
  logistica: [
    { label: 'Fila',           href: '/logistica',                                icon: TruckIcon },
    { label: 'Em Separação',   href: '/logistica?status=em_separacao',           icon: ScanLine },
    { label: 'Histórico',      href: '/historico',                                icon: History },
  ],
  admin: [
    { label: 'Dashboard',      href: '/admin',          icon: LayoutDashboard },
    { label: 'Pedidos',        href: '/vendas',         icon: Package },
    { label: 'Novo Pedido',    href: '/vendas/novo',    icon: PackagePlus },
    { label: 'Logística',      href: '/logistica',      icon: TruckIcon },
    { label: 'Histórico',      href: '/historico',      icon: History },
    { label: 'Usuários',       href: '/admin/usuarios', icon: Users },
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
  const items = NAV[profile.role] ?? NAV.vendedor;

  return (
    <aside className="hidden md:flex w-64 shrink-0 flex-col bg-franzoni-navy text-white">
      <div className="px-6 py-6 border-b border-white/10">
        <Link href="/" className="block">
          <FranzoniLogo size={56} />
        </Link>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {items.map((item) => {
          const active =
            pathname === item.href.split('?')[0] ||
            (item.href !== '/' && pathname.startsWith(item.href.split('?')[0] + '/'));
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors',
                active
                  ? 'bg-franzoni-orange text-white shadow-sm'
                  : 'text-white/80 hover:bg-white/5 hover:text-white',
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="truncate">{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="px-3 py-4 border-t border-white/10 space-y-2">
        <div className="flex items-center gap-3 px-2">
          <Avatar className="h-9 w-9 bg-franzoni-orange/20 text-franzoni-orange-100">
            <AvatarFallback className="bg-transparent text-sm font-medium">
              {initials(profile.full_name || profile.email || '?')}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium truncate">{profile.full_name || profile.email}</p>
            <p className="text-xs text-white/60 capitalize">{profile.role}</p>
          </div>
        </div>
        <form action="/auth/signout" method="post">
          <Button
            type="submit"
            variant="ghost"
            size="sm"
            className="w-full justify-start text-white/80 hover:text-white hover:bg-white/5"
          >
            <LogOut className="h-4 w-4 mr-2" /> Sair
          </Button>
        </form>
      </div>
    </aside>
  );
}
