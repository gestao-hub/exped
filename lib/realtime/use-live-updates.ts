'use client';

import { useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';

type LiveSource = { kind: 'sse'; url: string } | { kind: 'channel' };

/**
 * Decide a fonte de eventos ao vivo:
 *  - HUB (atrás do porteiro de rede, __SUPABASE_USE_ORIGIN__) → SSE em /avisos da própria origem.
 *  - NUVEM → canal postgres_changes do Supabase Realtime.
 * Pura (sem efeitos) pra ser testável.
 */
export function resolveLiveSource(empresaId: string): LiveSource {
  const w =
    typeof window !== 'undefined'
      ? (window as Window & { __SUPABASE_USE_ORIGIN__?: boolean })
      : undefined;
  if (w?.__SUPABASE_USE_ORIGIN__) {
    return { kind: 'sse', url: `${window.location.origin}/avisos?empresa=${empresaId}` };
  }
  return { kind: 'channel' };
}

/**
 * Assina mudanças de pedidos/OS da empresa e chama `onChange` (o consumidor faz o
 * debounce/refetch). No hub usa SSE (/avisos); na nuvem usa o canal Realtime.
 * `empresaId` null → não assina (ex.: alertas desligados / sem empresa).
 */
export function useLiveUpdates(empresaId: string | null, onChange: () => void) {
  useEffect(() => {
    if (!empresaId) return;
    const src = resolveLiveSource(empresaId);
    if (src.kind === 'sse') {
      const es = new EventSource(src.url);
      es.addEventListener('changed', () => onChange());
      return () => es.close();
    }
    const supabase = createClient();
    const ch = supabase
      .channel(`live:${empresaId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'pedidos', filter: `empresa_id=eq.${empresaId}` },
        () => onChange(),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'ordens_servico', filter: `empresa_id=eq.${empresaId}` },
        () => onChange(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [empresaId, onChange]);
}
