-- Migration 07: índice único parcial em pedidos(documento_erp)
-- Evita criar pedidos duplicados a partir do mesmo documento do ERP.
-- Aplicado apenas a pedidos ativos (não cancelados) — se um pedido
-- foi cancelado, o mesmo documento pode ser re-importado.

create unique index if not exists pedidos_documento_erp_uniq
  on public.pedidos (documento_erp)
  where documento_erp is not null and status <> 'cancelado';
