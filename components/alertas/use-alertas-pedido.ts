'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { Pedido } from '@/lib/types';
import type { PreferenciasAviso } from '@/lib/alertas/preferencias';
import { criarPlayerSom, LoopSom } from '@/lib/alertas/som';
import { criarPiscaTitulo } from '@/lib/alertas/titulo';

interface Opts {
  userId: string;
  empresaId: string | null;
  prefs: PreferenciasAviso;
  /** Para onde navegar ao clicar na notificação. */
  linkDoPedido: (p: Pedido) => string;
  navegar: (href: string) => void;
}

export function useAlertasPedido({ prefs, linkDoPedido, navegar, empresaId }: Opts) {
  const supabase = useMemo(() => createClient(), []);
  const [naoVistos, setNaoVistos] = useState(0);

  const player = useRef(criarPlayerSom());
  const loop = useRef<LoopSom | null>(null);
  const pisca = useRef(criarPiscaTitulo());

  // refs com os valores atuais pra usar dentro de callbacks estáveis do realtime
  const prefsRef = useRef(prefs);
  const linkRef = useRef(linkDoPedido);
  const navegarRef = useRef(navegar);
  const naoVistosRef = useRef(0);

  // sincroniza refs após cada render (useLayoutEffect = síncrono, antes do browser pintar)
  useLayoutEffect(() => {
    prefsRef.current = prefs;
    linkRef.current = linkDoPedido;
    navegarRef.current = navegar;
  });

  const reconhecer = useCallback(() => {
    naoVistosRef.current = 0;
    setNaoVistos(0);
    loop.current?.parar();
    loop.current = null;
    pisca.current.parar();
  }, []);

  const disparar = useCallback((p: Pedido) => {
    const pr = prefsRef.current;
    // Aba já em foco → só atualiza contagem, sem insistir
    const emFoco = typeof document !== 'undefined' && document.visibilityState === 'visible';
    naoVistosRef.current += 1;
    setNaoVistos(naoVistosRef.current);

    if (pr.som && !emFoco) {
      loop.current?.parar();
      loop.current = new LoopSom(() => player.current.tocar(pr.somId), { repetir: pr.repetir });
      loop.current.iniciar();
    }
    if (!emFoco) pisca.current.piscar(naoVistosRef.current);

    if (pr.notificacao && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      const n = new Notification(`Novo pedido — ${p.cliente_nome ?? 'cliente'}`, {
        body: `Nº ${p.numero_mapa ?? '-'} · R$ ${Number(p.valor_total ?? 0).toFixed(2)}`,
        tag: `pedido-${p.id}`,
      });
      n.onclick = () => {
        window.focus();
        navegarRef.current(linkRef.current(p));
        reconhecer();
        n.close();
      };
    }
  }, [reconhecer]);

  /** Desbloqueia o áudio (chamar num gesto do usuário). Callback estável. */
  const desbloquear = useCallback(() => player.current.desbloquear(), []);

  /** Usado pelo botão "Testar aviso". */
  const dispararTeste = useCallback(() => {
    disparar({
      id: 'teste',
      cliente_nome: 'Cliente Teste',
      numero_mapa: 0,
      valor_total: 0,
      documento_erp: 'TESTE',
    } as unknown as Pedido);
  }, [disparar]);

  // Reconhecer quando a aba volta ao foco / fica visível
  useEffect(() => {
    const onVisivel = () => {
      if (document.visibilityState === 'visible') reconhecer();
    };
    window.addEventListener('focus', reconhecer);
    document.addEventListener('visibilitychange', onVisivel);
    return () => {
      window.removeEventListener('focus', reconhecer);
      document.removeEventListener('visibilitychange', onVisivel);
    };
  }, [reconhecer]);

  // Assinatura realtime — só quando avisos ativados
  useEffect(() => {
    if (!prefs.ativado || !empresaId) return;
    const channel = supabase
      .channel(`pedidos-alertas:${empresaId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'pedidos', filter: `empresa_id=eq.${empresaId}` },
        (payload) => {
          const p = payload.new as Pedido;
          // só pedidos vindos do Hiper (têm documento_erp)
          if (!p.documento_erp) return;
          disparar(p);
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, prefs.ativado, disparar, empresaId]);

  return { naoVistos, reconhecer, dispararTeste, desbloquear };
}
