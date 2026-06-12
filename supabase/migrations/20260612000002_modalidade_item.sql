-- 20260612000002_modalidade_item.sql
-- Modalidade por item (fonte da verdade) + ponto_retirada_id (destino) nullable.
CREATE TYPE public.modalidade_item AS ENUM ('imediato', 'loja', 'entrega');

ALTER TABLE public.pedido_itens
  ADD COLUMN modalidade public.modalidade_item NOT NULL DEFAULT 'loja';

-- Backfill: deriva do tipo do ponto atual (entrega→entrega; loja/deposito→loja).
UPDATE public.pedido_itens i
   SET modalidade = CASE WHEN p.tipo = 'entrega' THEN 'entrega'::public.modalidade_item
                         ELSE 'loja'::public.modalidade_item END
  FROM public.pedido_pontos_retirada p
 WHERE i.ponto_retirada_id = p.id;

ALTER TABLE public.pedido_itens
  ALTER COLUMN ponto_retirada_id DROP NOT NULL;
