-- 20260614000002_fk_indexes.sql
-- Índices nas foreign keys que não tinham cobertura (advisor: unindexed_foreign_keys).
-- Acelera joins e exclusões em cascata sob volume. Idempotente (IF NOT EXISTS).
CREATE INDEX IF NOT EXISTS hiper_vendedor_map_vendedor_idx ON public.hiper_vendedor_map (vendedor_id);
CREATE INDEX IF NOT EXISTS ordens_servico_cliente_idx       ON public.ordens_servico (cliente_id);
CREATE INDEX IF NOT EXISTS ordens_servico_vendedor_idx      ON public.ordens_servico (vendedor_id);
CREATE INDEX IF NOT EXISTS pedido_comentarios_autor_idx     ON public.pedido_comentarios (autor_id);
CREATE INDEX IF NOT EXISTS pedido_eventos_usuario_idx       ON public.pedido_eventos (usuario_id);
CREATE INDEX IF NOT EXISTS pedido_logistica_updated_by_idx  ON public.pedido_logistica (updated_by);
CREATE INDEX IF NOT EXISTS provisioning_codes_created_by_idx ON public.provisioning_codes (created_by);
CREATE INDEX IF NOT EXISTS provisioning_codes_used_disp_idx ON public.provisioning_codes (used_dispositivo_id);
