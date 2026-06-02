'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useUser } from '@/components/providers/user-provider';
import type { Pedido } from '@/lib/types';
import {
  carregar,
  salvar,
  PREFERENCIAS_PADRAO,
  type PreferenciasAviso,
} from '@/lib/alertas/preferencias';
import { useAlertasPedido } from './use-alertas-pedido';

interface AlertasContextValue {
  prefs: PreferenciasAviso;
  atualizar: (patch: Partial<PreferenciasAviso>) => void;
  naoVistos: number;
  reconhecer: () => void;
  dispararTeste: () => void;
  desbloquear: () => Promise<void>;
  seguro: boolean;
  pronto: boolean;
}

const Ctx = createContext<AlertasContextValue | null>(null);

function linkDoPedido(role: string, p: Pedido): string {
  if (p.id === 'teste') return '#';
  return role === 'vendedor' ? `/vendas/${p.id}` : `/logistica/${p.id}`;
}

/** Monta UMA vez no layout: roda o hook de aviso e expõe estado/ações via contexto. */
export function AlertasProvider({ children }: { children: ReactNode }) {
  const { profile } = useUser();
  const router = useRouter();
  const [estado, setEstado] = useState<{ prefs: PreferenciasAviso; seguro: boolean; pronto: boolean }>({
    prefs: PREFERENCIAS_PADRAO,
    seguro: true,
    pronto: false,
  });

  useEffect(() => {
    // Inicialização client-only (localStorage + isSecureContext); o gate !pronto
    // evita mismatch de hidratação. setState no mount é intencional aqui.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEstado({
      prefs: carregar(profile.id),
      seguro: typeof window !== 'undefined' ? window.isSecureContext : true,
      pronto: true,
    });
  }, [profile.id]);

  const { naoVistos, reconhecer, dispararTeste, desbloquear } = useAlertasPedido({
    userId: profile.id,
    prefs: estado.prefs,
    linkDoPedido: (p) => linkDoPedido(profile.role, p),
    navegar: (href) => {
      if (href !== '#') router.push(href);
    },
  });

  function atualizar(patch: Partial<PreferenciasAviso>) {
    setEstado((prev) => {
      const novo = { ...prev.prefs, ...patch };
      salvar(profile.id, novo);
      return { ...prev, prefs: novo };
    });
  }

  return (
    <Ctx.Provider
      value={{
        prefs: estado.prefs,
        atualizar,
        naoVistos,
        reconhecer,
        dispararTeste,
        desbloquear,
        seguro: estado.seguro,
        pronto: estado.pronto,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useAlertas() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAlertas deve ser usado dentro de <AlertasProvider>');
  return c;
}
