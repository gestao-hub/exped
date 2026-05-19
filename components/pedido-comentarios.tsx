'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { format, formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { MessageCircle, Send, Trash2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { ContentCard, ContentCardTitle } from '@/components/layout/content-card';
import { createClient } from '@/lib/supabase/client';
import {
  addComentarioAction,
  deleteComentarioAction,
} from '@/app/(app)/pedido-comentarios/actions';

type Comentario = {
  id: string;
  pedido_id: string;
  autor_id: string | null;
  texto: string;
  created_at: string;
  autor?: { full_name: string | null; email: string; role: string } | null;
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

export function PedidoComentarios({
  pedidoId,
  initial,
  currentUserId,
}: {
  pedidoId: string;
  initial: Comentario[];
  currentUserId: string;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [comentarios, setComentarios] = useState<Comentario[]>(initial);
  const [texto, setTexto] = useState('');
  const [sending, startSend] = useTransition();

  // Realtime: novos comentários aparecem ao vivo
  useEffect(() => {
    const channel = supabase
      .channel(`comentarios:${pedidoId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'pedido_comentarios',
          filter: `pedido_id=eq.${pedidoId}`,
        },
        async (payload) => {
          if (payload.eventType === 'INSERT') {
            const c = payload.new as Comentario;
            // busca o autor (não vem no payload)
            const { data: autor } = await supabase
              .from('profiles')
              .select('full_name, email, role')
              .eq('id', c.autor_id ?? '')
              .maybeSingle();
            setComentarios((prev) => {
              if (prev.some((p) => p.id === c.id)) return prev;
              return [...prev, { ...c, autor: autor as Comentario['autor'] }];
            });
          } else if (payload.eventType === 'DELETE') {
            setComentarios((prev) => prev.filter((p) => p.id !== (payload.old as Comentario).id));
          }
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, pedidoId]);

  function send() {
    const t = texto.trim();
    if (!t) return;
    startSend(async () => {
      const r = await addComentarioAction({ pedido_id: pedidoId, texto: t });
      if ('error' in r) toast.error(r.error);
      else setTexto('');
    });
  }

  function remove(id: string) {
    if (!window.confirm('Excluir este comentário?')) return;
    deleteComentarioAction(id, pedidoId).then((r) => {
      if ('error' in r) toast.error(r.error);
    });
  }

  return (
    <ContentCard
      className="p-5!"
      header={
        <ContentCardTitle>
          <span className="inline-flex items-center gap-2">
            <MessageCircle className="h-4 w-4" /> Comentários
            {comentarios.length > 0 && (
              <span className="text-xs font-normal text-muted-foreground">
                ({comentarios.length})
              </span>
            )}
          </span>
        </ContentCardTitle>
      }
    >
      <ol className="space-y-3 mb-4">
        {comentarios.length === 0 ? (
          <li className="text-sm text-muted-foreground italic">
            Nenhum comentário ainda. Use este espaço pra alinhar sobre o pedido (substituição
            de item, alterações de endereço, instruções da entrega…).
          </li>
        ) : (
          comentarios.map((c) => {
            const name = c.autor?.full_name || c.autor?.email || 'Usuário';
            const role = c.autor?.role;
            const isMine = c.autor_id === currentUserId;
            return (
              <li key={c.id} className="flex gap-3">
                <Avatar className="h-8 w-8 bg-franzoni-orange/15 ring-1 ring-franzoni-orange/25 shrink-0">
                  <AvatarFallback className="bg-transparent text-xs font-semibold text-franzoni-orange-700">
                    {initials(name)}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-sm font-semibold truncate">{name}</span>
                    {role && (
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground bg-muted/60 px-1.5 py-0.5 rounded">
                        {role}
                      </span>
                    )}
                    <span
                      className="text-xs text-muted-foreground"
                      title={format(new Date(c.created_at), "dd/MM/yyyy HH:mm", { locale: ptBR })}
                    >
                      ·{' '}
                      {formatDistanceToNow(new Date(c.created_at), {
                        locale: ptBR,
                        addSuffix: true,
                      })}
                    </span>
                    {isMine && (
                      <button
                        onClick={() => remove(c.id)}
                        className="ml-auto text-muted-foreground hover:text-destructive transition-colors"
                        aria-label="Excluir comentário"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                  <p className="text-sm whitespace-pre-wrap text-foreground/90 leading-relaxed">
                    {c.texto}
                  </p>
                </div>
              </li>
            );
          })
        )}
      </ol>

      <div className="space-y-2">
        <Textarea
          placeholder="Escreva uma mensagem… (Ctrl+Enter envia)"
          rows={2}
          value={texto}
          disabled={sending}
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              send();
            }
          }}
          className="resize-none"
        />
        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={send}
            disabled={sending || !texto.trim()}
            className="bg-franzoni-orange hover:bg-franzoni-orange-600"
          >
            {sending ? (
              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5 mr-1" />
            )}
            Enviar
          </Button>
        </div>
      </div>
    </ContentCard>
  );
}
