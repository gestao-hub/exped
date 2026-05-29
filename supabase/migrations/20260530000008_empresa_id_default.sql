-- 20260530000008_empresa_id_default.sql
-- empresa_id se autopreenche com a empresa do usuário logado (current_empresa_id()),
-- mantendo o código de insert existente funcionando sem alteração. O endpoint de
-- ingestão (service_role, sem auth.uid()) seta empresa_id explicitamente.
alter table public.pedidos           alter column empresa_id set default public.current_empresa_id();
alter table public.clientes          alter column empresa_id set default public.current_empresa_id();
alter table public.cliente_enderecos alter column empresa_id set default public.current_empresa_id();
