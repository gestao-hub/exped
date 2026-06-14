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
      // HUB: o servidor SSE (/avisos) já filtra por empresa no fanout; sem auth no client.
      const es = new EventSource(src.url);
      es.addEventListener('changed', () => onChange());
      return () => es.close();
    }

    // NUVEM: canal postgres_changes. O Realtime APLICA RLS no stream — a conexão precisa
    // do token da sessão, senão conecta como anon e a RLS bloqueia TODOS os eventos de
    // pedidos (nada chega → a lista só atualiza no F5). O @supabase/ssr não propaga o
    // token pro realtime automaticamente, então setamos manualmente (e re-setamos quando
    // o token renova). Sem isto o auto-aparecer não funciona na nuvem.
    const supabase = createClient();
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let cancelled = false;

    const subscribe = async () => {
      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      const token = data.session?.access_token;
      if (token) supabase.realtime.setAuth(token);
      channel = supabase
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
    };
    void subscribe();

    // Renovação de token (a cada ~1h): re-autentica o realtime pra não parar de receber.
    const { data: authSub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.access_token) supabase.realtime.setAuth(session.access_token);
    });

    return () => {
      cancelled = true;
      authSub.subscription.unsubscribe();
      if (channel) supabase.removeChannel(channel);
    };
  }, [empresaId, onChange]);
}
