'use client';

import { useState } from 'react';
import { Bell, BellRing } from 'lucide-react';
import { type SomId } from '@/lib/alertas/preferencias';
import { SONS_LABEL } from '@/lib/alertas/som';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAlertas } from './alertas-provider';

export function AlertasCenter({ tom = 'claro' }: { tom?: 'claro' | 'escuro' }) {
  const { prefs, atualizar, naoVistos, reconhecer, dispararTeste, desbloquear, seguro, pronto } =
    useAlertas();
  const [aberto, setAberto] = useState(false);

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

  if (!pronto) return null;

  const Icone = prefs.ativado && naoVistos > 0 ? BellRing : Bell;
  const corBotao =
    tom === 'escuro' ? 'text-white hover:bg-white/10' : 'text-[#667085] hover:bg-[#F2F4F7]';

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
        className={`relative inline-flex h-9 w-9 items-center justify-center rounded-lg ${corBotao}`}
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

            {!prefs.ativado ? (
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

            {!seguro && (
              <p className="mb-2 rounded-md bg-[#FFFAEB] p-2 text-[11px] text-[#B54708]">
                ⚠️ Para a notificação do Windows, abra o Exped por{' '}
                <strong>http://localhost:3000</strong> neste PC. Som e piscar funcionam mesmo assim.
              </p>
            )}

            <Linha label="Tocar som" checked={prefs.som} onChange={(v) => atualizar({ som: v })} />
            <div className="my-2 flex items-center justify-between">
              <span className="text-sm text-[#344054]">Som</span>
              <Select
                value={prefs.somId}
                onValueChange={(v) => atualizar({ somId: v as SomId })}
              >
                <SelectTrigger size="sm">
                  <SelectValue placeholder="Selecione" />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(SONS_LABEL) as SomId[]).map((id) => (
                    <SelectItem key={id} value={id}>
                      {SONS_LABEL[id]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Linha
              label="Repetir som até eu ver"
              checked={prefs.repetir}
              onChange={(v) => atualizar({ repetir: v })}
            />
            <Linha
              label="Notificação do Windows"
              checked={prefs.notificacao}
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
