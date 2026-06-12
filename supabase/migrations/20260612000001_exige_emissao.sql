-- 20260612000001_exige_emissao.sql
-- Flag conferida no financeiro: se o pedido exige emissão de nota.
-- `pedidos` é tabela two-way no sync; a coluna entra na allowlist dinâmica do RPC e
-- desce no pull (select *) — sem ação extra necessária.
ALTER TABLE public.pedidos
  ADD COLUMN IF NOT EXISTS exige_emissao boolean NOT NULL DEFAULT false;
