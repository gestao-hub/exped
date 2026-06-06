-- 20260606000003_pedido_saiu_entrega_em.sql
-- Carimbo de quando o pedido saiu para entrega (alimenta a aba "Em transporte").
-- Null = ainda não saiu. Preenchido por marcarSaiuEntregaAction.
alter table public.pedidos
  add column if not exists saiu_entrega_em timestamptz;
