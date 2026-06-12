-- 20260612000001_exige_emissao.sql
-- Flag conferida no financeiro: se o pedido exige emissão de nota.
ALTER TABLE public.pedidos
  ADD COLUMN IF NOT EXISTS exige_emissao boolean NOT NULL DEFAULT false;
