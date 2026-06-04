'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useLiveUpdates } from '@/lib/realtime/use-live-updates';
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

  // Detecção de pedido novo por busca (high-water mark) — funciona no hub (SSE) e na nuvem
  // (canal), via useLiveUpdates. Ao receber o sinal "mudou", busca os pedidos do Hiper mais
  // recentes e alerta os que passaram do último visto (não usa o payload do evento, que o SSE
  // não tem). O primeiro fetch só fixa a baseline (não alerta pedidos pré-existentes).
  const hwmRef = useRef<string>('');
  const primedRef = useRef(false);

  const checarNovos = useCallback(async () => {
    if (!empresaId) return;
    const { data } = await supabase
      .from('pedidos')
      .select('id, cliente_nome, numero_mapa, valor_total, documento_erp, created_at')
      .eq('empresa_id', empresaId)
      .not('documento_erp', 'is', null)
      .order('created_at', { ascending: false })
      .limit(20);
    const rows = (data ?? []) as Pedido[];
    if (!primedRef.current) {
      hwmRef.current = rows[0]?.created_at ?? '';
      primedRef.current = true;
      return;
    }
    const novos = rows.filter((p) => (p.created_at ?? '') > hwmRef.current).reverse(); // cronológico
    for (const p of novos) disparar(p);
    if (rows[0]?.created_at && rows[0].created_at > hwmRef.current) hwmRef.current = rows[0].created_at;
  }, [supabase, empresaId, disparar]);

  // Baseline quando ativa/troca de empresa (re-fixa o high-water sem alertar).
  useEffect(() => {
    primedRef.current = false;
    hwmRef.current = '';
    if (prefs.ativado && empresaId) checarNovos();
  }, [prefs.ativado, empresaId, checarNovos]);

  // Sinal ao vivo → re-checa. Só assina quando avisos ativados.
  useLiveUpdates(prefs.ativado ? empresaId : null, checarNovos);

  return { naoVistos, reconhecer, dispararTeste, desbloquear };
}
