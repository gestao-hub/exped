-- 20260606000002_pedido_status_financeiro_transporte.sql
-- Novos status do pipeline:
--   em_financeiro → entre rascunho e pendente (fila do financeiro)
--   em_transporte → entre em_separacao e finalizado (caminhão na rua; só envio/entrega)
-- ADD VALUE precisa ser commitado ANTES de ser usado — migration própria, sem consumo aqui.
alter type public.pedido_status add value if not exists 'em_financeiro';
alter type public.pedido_status add value if not exists 'em_transporte';
