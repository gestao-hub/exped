'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, BellRing } from 'lucide-react';
import { useUser } from '@/components/providers/user-provider';
import type { Pedido } from '@/lib/types';
import {
  carregar,
  salvar,
  PREFERENCIAS_PADRAO,
  type PreferenciasAviso,
  type SomId,
} from '@/lib/alertas/preferencias';
import { SONS_LABEL } from '@/lib/alertas/som';
import { useAlertasPedido } from './use-alertas-pedido';

function linkDoPedido(role: string, p: Pedido): string {
  if (p.id === 'teste') return '#';
  return role === 'vendedor' ? `/vendas/${p.id}` : `/logistica/${p.id}`;
}

export function AlertasCenter({ tom = 'claro' }: { tom?: 'claro' | 'escuro' }) {
  const { profile } = useUser();
  const router = useRouter();
  const [aberto, setAberto] = useState(false);
  const [estado, setEstado] = useState<{
    prefs: PreferenciasAviso;
    seguro: boolean;
    pronto: boolean;
  }>({
    prefs: PREFERENCIAS_PADRAO,
    seguro: true,
    pronto: false,
  });

  // Inicialização client-only (localStorage + isSecureContext); o gate !pronto
  // evita mismatch de hidratação. setState no mount é intencional aqui.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEstado({
      prefs: carregar(profile.id),
      seguro: typeof window !== 'undefined' ? window.isSecureContext : true,
      pronto: true,
    });
  }, [profile.id]);

  const { naoVistos, dispararTeste, desbloquear, reconhecer } = useAlertasPedido({
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

  /** Liga o master: gesto do usuário → desbloqueia áudio + pede permissão de notificação. */
  async function ativar() {
    await desbloquear();
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      try {
        await Notification.requestPermission();
      } catch {
        /* ignora */
      }
    }
    atualizar({ ativado: true });
  }

  async function testar() {
    await desbloquear();
    dispararTeste();
  }

  if (!estado.pronto) return null;

  const Icone = estado.prefs.ativado && naoVistos > 0 ? BellRing : Bell;

  const btnClass =
    tom === 'escuro'
      ? 'relative inline-flex h-9 w-9 items-center justify-center rounded-lg text-white hover:bg-white/10'
      : 'relative inline-flex h-9 w-9 items-center justify-center rounded-lg text-[#667085] hover:bg-[#F2F4F7]';

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => {
          setAberto((v) => {
            if (!v) reconhecer();
            return !v;
          });
        }}
        className={btnClass}
        aria-label="Avisos de pedido"
      >
        <Icone className="h-5 w-5" />
        {naoVistos > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#D92D20] px-1 text-[10px] font-semibold text-white">
            {naoVistos}
          </span>
        )}
      </button>

      {aberto && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setAberto(false)} />
          <div className="absolute right-0 z-50 mt-2 w-72 rounded-xl border border-[#EAECF0] bg-white p-3 shadow-lg">
            <p className="mb-2 text-sm font-semibold text-[#1D2939]">Avisos de pedido novo</p>

            {!estado.prefs.ativado ? (
              <button
                type="button"
                onClick={ativar}
                className="mb-2 w-full rounded-lg bg-[#039855] px-3 py-2 text-sm font-medium text-white"
              >
                Ativar avisos
              </button>
            ) : (
              <p className="mb-2 text-xs text-[#039855]">✅ Avisos ativos</p>
            )}

            {!estado.seguro && (
              <p className="mb-2 rounded-md bg-[#FFFAEB] p-2 text-[11px] text-[#B54708]">
                ⚠️ Para a notificação do Windows, abra o Exped por{' '}
                <strong>http://localhost:3000</strong> neste PC. Som e piscar funcionam mesmo assim.
              </p>
            )}

            <Linha label="Tocar som" checked={estado.prefs.som} onChange={(v) => atualizar({ som: v })} />
            <div className="my-2 flex items-center justify-between">
              <span className="text-sm text-[#344054]">Som</span>
              <select
                value={estado.prefs.somId}
                onChange={(e) => atualizar({ somId: e.target.value as SomId })}
                className="rounded-md border border-[#D0D5DD] px-2 py-1 text-sm"
              >
                {(Object.keys(SONS_LABEL) as SomId[]).map((id) => (
                  <option key={id} value={id}>
                    {SONS_LABEL[id]}
                  </option>
                ))}
              </select>
            </div>
            <Linha
              label="Repetir som até eu ver"
              checked={estado.prefs.repetir}
              onChange={(v) => atualizar({ repetir: v })}
            />
            <Linha
              label="Notificação do Windows"
              checked={estado.prefs.notificacao}
              onChange={(v) => atualizar({ notificacao: v })}
            />

            <button
              type="button"
              onClick={testar}
              className="mt-3 w-full rounded-lg border border-[#D0D5DD] px-3 py-2 text-sm font-medium text-[#344054] hover:bg-[#F9FAFB]"
            >
              Testar aviso
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Linha({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between py-1.5 text-sm text-[#344054]">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}
