'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FranzoniLogo } from '@/components/franzoni-logo';
import { useUser } from '@/components/providers/user-provider';
import type { UserRole } from '@/lib/types';
import {
  LayoutDashboard,
  Package,
  PackagePlus,
  TruckIcon,
  History,
  Users,
  UsersRound,
  LogOut,
  Lightbulb,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

type NavItem = { label: string; href: string; icon: LucideIcon };

const NAV: Record<UserRole, NavItem[]> = {
  vendedor: [
    { label: 'Meus Pedidos', href: '/vendas',      icon: Package },
    { label: 'Novo Pedido',  href: '/vendas/novo', icon: PackagePlus },
    { label: 'Histórico',    href: '/historico',   icon: History },
    { label: 'Tutorial',     href: '/tutorial',    icon: Lightbulb },
  ],
  logistica: [
    { label: 'Fila',         href: '/logistica',                       icon: TruckIcon },
    { label: 'Histórico',    href: '/historico',                       icon: History },
    { label: 'Tutorial',     href: '/tutorial',                        icon: Lightbulb },
  ],
  admin: [
    { label: 'Dashboard',    href: '/admin',          icon: LayoutDashboard },
    { label: 'Pedidos',      href: '/vendas',         icon: Package },
    { label: 'Novo Pedido',  href: '/vendas/novo',    icon: PackagePlus },
    { label: 'Logística',    href: '/logistica',      icon: TruckIcon },
    { label: 'Histórico',    href: '/historico',      icon: History },
    { label: 'Clientes',     href: '/admin/clientes', icon: UsersRound },
    { label: 'Usuários',     href: '/admin/usuarios', icon: Users },
    { label: 'Tutorial',     href: '/tutorial',       icon: Lightbulb },
  ],
};

export function MobileHeader() {
  const [open, setOpen] = useState(false);
  const { profile } = useUser();
  const pathname = usePathname();
  const items = NAV[profile.role] ?? NAV.vendedor;

  return (
    <>
      <header className="md:hidden sticky top-0 z-30 sidebar-surface text-white px-3 py-2 flex items-center justify-between border-b border-white/8">
        <Link href="/" className="flex items-center">
          <FranzoniLogo size={36} variant="light" />
        </Link>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Menu"
          className="text-white hover:bg-white/8"
          onClick={() => setOpen(true)}
        >
          <Menu className="h-5 w-5" />
        </Button>
      </header>

      {open && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          />
          <aside className="relative ml-auto w-72 max-w-[85vw] sidebar-surface text-white flex flex-col">
            <div className="px-4 pt-6 pb-4 flex items-center justify-between border-b border-white/8">
              <FranzoniLogo size={64} variant="light" />
              <Button
                variant="ghost"
                size="icon"
                aria-label="Fechar"
                className="text-white hover:bg-white/8"
                onClick={() => setOpen(false)}
              >
                <X className="h-5 w-5" />
              </Button>
            </div>

            <nav className="flex-1 py-3 space-y-1 overflow-y-auto">
              {(() => {
                // Calcula o href ativo pelo prefixo mais longo
                let bestHref: string | null = null;
                let bestLen = -1;
                for (const it of items) {
                  const t = it.href.split('?')[0];
                  const m = pathname === t || (t !== '/' && pathname.startsWith(t + '/'));
                  if (m && t.length > bestLen) { bestLen = t.length; bestHref = it.href; }
                }
                return items.map((item) => {
                const active = item.href === bestHref;
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setOpen(false)}
                    className="nav-card-glass"
                    data-active={active}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="truncate">{item.label}</span>
                  </Link>
                );
                });
              })()}
            </nav>

            <form action="/auth/signout" method="post" className="p-3 border-t border-white/8">
              <Button
                type="submit"
                variant="ghost"
                size="sm"
                className="w-full justify-start text-white/80 hover:text-white hover:bg-white/8"
              >
                <LogOut className="h-4 w-4 mr-2" /> Sair
              </Button>
            </form>
          </aside>
        </div>
      )}
    </>
  );
}
