-- 20260612000002_modalidade_item.sql
-- Modalidade por item (fonte da verdade de como o cliente recebe cada item).
-- Idempotente (padrão do repo): CREATE TYPE protegido + ADD COLUMN IF NOT EXISTS.
DO $$ BEGIN
  CREATE TYPE public.modalidade_item AS ENUM ('imediato', 'loja', 'entrega');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

ALTER TABLE public.pedido_itens
  ADD COLUMN IF NOT EXISTS modalidade public.modalidade_item NOT NULL DEFAULT 'loja';

-- Backfill: deriva do tipo do ponto atual (entrega→entrega; loja/deposito→loja).
-- Idempotente (re-rodar dá o mesmo resultado).
UPDATE public.pedido_itens i
   SET modalidade = CASE WHEN p.tipo = 'entrega' THEN 'entrega'::public.modalidade_item
                         ELSE 'loja'::public.modalidade_item END
  FROM public.pedido_pontos_retirada p
 WHERE i.ponto_retirada_id = p.id;

-- NÃO afrouxamos ponto_retirada_id: a coluna SEGUE NOT NULL de propósito.
-- O item 'imediato' NÃO fica com FK nula — ele vive num ponto-container tipo='imediato'
-- (ver 20260612000003 + lib/pedidos/sincronizar-destinos.ts). O sync escopa pedido_itens
-- por empresa VIA esse FK (pull faz INNER JOIN no ponto; push rejeita FK nula). Deixar a
-- coluna nullable seria um footgun: um item com FK nula sumiria silenciosamente no pull e
-- travaria o push. Mantendo NOT NULL, o banco garante a invariante de que o sync depende.
