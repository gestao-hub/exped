-- 20260603180000_multitenant_indices.sql — higiene de índice multi-tenant (aditivo).
--
-- NOTA (medido): a ideia de recriar os índices trigram com empresa_id via btree_gin foi
-- MEDIDA (Postgres local, 20 empresas × 25k pedidos) e DESCARTADA — com empresa_id de alta
-- cardinalidade (~25k linhas/empresa) o composto btree_gin fica MAIS LENTO (25.9ms) que o trgm
-- simples (18.6ms): a posting list de empresa_id no GIN é enorme. Pra termo seletivo o trgm já é
-- seletivo; pra termo comum o planner usa seq-scan com parada antecipada. Os índices trgm
-- originais (pedidos_search_trgm_idx, clientes_nome_trgm) ficam como estão.

-- Índice faltante: RLS de cliente_enderecos filtra empresa_id, sem índice de apoio.
create index if not exists cliente_enderecos_empresa_idx on public.cliente_enderecos (empresa_id);

-- Higiene: dropa índices de coluna única pré-multitenant — cobertos pelos compostos da Fase 1
-- (pedidos_empresa_status_entrega_idx etc., medidos: fila a ~0.3ms). Nenhum código usa pelo nome.
drop index if exists public.pedidos_status_idx;
drop index if exists public.pedidos_bairro_idx;
drop index if exists public.pedidos_data_entrega_idx;
