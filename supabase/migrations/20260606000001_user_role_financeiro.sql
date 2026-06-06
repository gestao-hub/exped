-- 20260606000001_user_role_financeiro.sql
-- Novo papel: financeiro (etapa entre vendas e logística).
-- ADD VALUE precisa ser commitado ANTES de ser usado (RLS na 000004) — migration própria.
alter type public.user_role add value if not exists 'financeiro';
