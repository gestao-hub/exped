-- 20260614000005_rls_consolidate_demais.sql
-- Consolida políticas permissivas duplicadas (advisor: multiple_permissive_policies) +
-- embrulha funções (initplan) nas demais tabelas. Padrão: a antiga política ALL vira
-- políticas por ação, removendo a sobreposição com a política de SELECT. Semântica preservada.

-- ===== profiles =====
DROP POLICY IF EXISTS "profiles_admin_all" ON public.profiles;
DROP POLICY IF EXISTS "profiles_self_read" ON public.profiles;
DROP POLICY IF EXISTS "profiles_self_update" ON public.profiles;
CREATE POLICY "profiles_read" ON public.profiles AS PERMISSIVE FOR SELECT TO public
  USING (( SELECT is_platform_admin()) OR (id = ( SELECT auth.uid())) OR ((( SELECT current_user_role()) = 'admin'::user_role) AND (empresa_id = ( SELECT current_empresa_id()))));
CREATE POLICY "profiles_insert" ON public.profiles AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (( SELECT is_platform_admin()) OR ((( SELECT current_user_role()) = 'admin'::user_role) AND (empresa_id = ( SELECT current_empresa_id()))));
CREATE POLICY "profiles_update" ON public.profiles AS PERMISSIVE FOR UPDATE TO public
  USING (( SELECT is_platform_admin()) OR (id = ( SELECT auth.uid())) OR ((( SELECT current_user_role()) = 'admin'::user_role) AND (empresa_id = ( SELECT current_empresa_id()))))
  WITH CHECK (( SELECT is_platform_admin()) OR (id = ( SELECT auth.uid())) OR ((( SELECT current_user_role()) = 'admin'::user_role) AND (empresa_id = ( SELECT current_empresa_id()))));
CREATE POLICY "profiles_delete" ON public.profiles AS PERMISSIVE FOR DELETE TO public
  USING (( SELECT is_platform_admin()) OR ((( SELECT current_user_role()) = 'admin'::user_role) AND (empresa_id = ( SELECT current_empresa_id()))));

-- ===== empresas =====
DROP POLICY IF EXISTS "empresas_platform_all" ON public.empresas;
DROP POLICY IF EXISTS "empresas_member_read" ON public.empresas;
CREATE POLICY "empresas_read" ON public.empresas AS PERMISSIVE FOR SELECT TO authenticated
  USING ((id = ( SELECT current_empresa_id())) OR ( SELECT is_platform_admin()));
CREATE POLICY "empresas_insert" ON public.empresas AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (( SELECT is_platform_admin()));
CREATE POLICY "empresas_update" ON public.empresas AS PERMISSIVE FOR UPDATE TO authenticated
  USING (( SELECT is_platform_admin())) WITH CHECK (( SELECT is_platform_admin()));
CREATE POLICY "empresas_delete" ON public.empresas AS PERMISSIVE FOR DELETE TO authenticated
  USING (( SELECT is_platform_admin()));

-- ===== dispositivos =====
DROP POLICY IF EXISTS "dispositivos_platform_write" ON public.dispositivos;
DROP POLICY IF EXISTS "dispositivos_read" ON public.dispositivos;
CREATE POLICY "dispositivos_read" ON public.dispositivos AS PERMISSIVE FOR SELECT TO authenticated
  USING (( SELECT is_platform_admin()) OR ((empresa_id = ( SELECT current_empresa_id())) AND (( SELECT current_user_role()) = 'admin'::user_role)));
CREATE POLICY "dispositivos_insert" ON public.dispositivos AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (( SELECT is_platform_admin()));
CREATE POLICY "dispositivos_update" ON public.dispositivos AS PERMISSIVE FOR UPDATE TO authenticated
  USING (( SELECT is_platform_admin())) WITH CHECK (( SELECT is_platform_admin()));
CREATE POLICY "dispositivos_delete" ON public.dispositivos AS PERMISSIVE FOR DELETE TO authenticated
  USING (( SELECT is_platform_admin()));

-- ===== hiper_vendedor_map =====
DROP POLICY IF EXISTS "hiper_vendedor_map_platform_write" ON public.hiper_vendedor_map;
DROP POLICY IF EXISTS "hiper_vendedor_map_read" ON public.hiper_vendedor_map;
CREATE POLICY "hiper_vendedor_map_read" ON public.hiper_vendedor_map AS PERMISSIVE FOR SELECT TO authenticated
  USING (( SELECT is_platform_admin()) OR ((empresa_id = ( SELECT current_empresa_id())) AND (( SELECT current_user_role()) = 'admin'::user_role)));
CREATE POLICY "hiper_vendedor_map_insert" ON public.hiper_vendedor_map AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (( SELECT is_platform_admin()));
CREATE POLICY "hiper_vendedor_map_update" ON public.hiper_vendedor_map AS PERMISSIVE FOR UPDATE TO authenticated
  USING (( SELECT is_platform_admin())) WITH CHECK (( SELECT is_platform_admin()));
CREATE POLICY "hiper_vendedor_map_delete" ON public.hiper_vendedor_map AS PERMISSIVE FOR DELETE TO authenticated
  USING (( SELECT is_platform_admin()));

-- ===== ordens_servico =====
DROP POLICY IF EXISTS "os_admin_all" ON public.ordens_servico;
DROP POLICY IF EXISTS "os_read" ON public.ordens_servico;
CREATE POLICY "os_read" ON public.ordens_servico AS PERMISSIVE FOR SELECT TO public
  USING (( SELECT is_platform_admin()) OR ((empresa_id = ( SELECT current_empresa_id())) AND ((( SELECT current_user_role()) = ANY (ARRAY['admin'::user_role, 'logistica'::user_role])) OR (vendedor_id = ( SELECT auth.uid())))));
CREATE POLICY "os_insert" ON public.ordens_servico AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (( SELECT is_platform_admin()) OR ((empresa_id = ( SELECT current_empresa_id())) AND (( SELECT current_user_role()) = 'admin'::user_role)));
CREATE POLICY "os_update" ON public.ordens_servico AS PERMISSIVE FOR UPDATE TO public
  USING (( SELECT is_platform_admin()) OR ((empresa_id = ( SELECT current_empresa_id())) AND (( SELECT current_user_role()) = 'admin'::user_role)))
  WITH CHECK (( SELECT is_platform_admin()) OR ((empresa_id = ( SELECT current_empresa_id())) AND (( SELECT current_user_role()) = 'admin'::user_role)));
CREATE POLICY "os_delete" ON public.ordens_servico AS PERMISSIVE FOR DELETE TO public
  USING (( SELECT is_platform_admin()) OR ((empresa_id = ( SELECT current_empresa_id())) AND (( SELECT current_user_role()) = 'admin'::user_role)));

-- ===== pedido_logistica =====
DROP POLICY IF EXISTS "logistica_write" ON public.pedido_logistica;
DROP POLICY IF EXISTS "logistica_read" ON public.pedido_logistica;
CREATE POLICY "logistica_read" ON public.pedido_logistica AS PERMISSIVE FOR SELECT TO public
  USING (( SELECT is_platform_admin()) OR (EXISTS ( SELECT 1 FROM pedidos p
    WHERE ((p.id = pedido_logistica.pedido_id) AND (p.empresa_id = ( SELECT current_empresa_id())) AND ((( SELECT current_user_role()) = ANY (ARRAY['admin'::user_role, 'logistica'::user_role, 'financeiro'::user_role])) OR (p.vendedor_id = ( SELECT auth.uid())))))));
CREATE POLICY "logistica_insert" ON public.pedido_logistica AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (( SELECT is_platform_admin()) OR ((( SELECT current_user_role()) = ANY (ARRAY['admin'::user_role, 'logistica'::user_role])) AND (EXISTS ( SELECT 1 FROM pedidos p
    WHERE ((p.id = pedido_logistica.pedido_id) AND (p.empresa_id = ( SELECT current_empresa_id())))))));
CREATE POLICY "logistica_update" ON public.pedido_logistica AS PERMISSIVE FOR UPDATE TO public
  USING (( SELECT is_platform_admin()) OR ((( SELECT current_user_role()) = ANY (ARRAY['admin'::user_role, 'logistica'::user_role])) AND (EXISTS ( SELECT 1 FROM pedidos p
    WHERE ((p.id = pedido_logistica.pedido_id) AND (p.empresa_id = ( SELECT current_empresa_id())))))))
  WITH CHECK (( SELECT is_platform_admin()) OR ((( SELECT current_user_role()) = ANY (ARRAY['admin'::user_role, 'logistica'::user_role])) AND (EXISTS ( SELECT 1 FROM pedidos p
    WHERE ((p.id = pedido_logistica.pedido_id) AND (p.empresa_id = ( SELECT current_empresa_id())))))));
CREATE POLICY "logistica_delete" ON public.pedido_logistica AS PERMISSIVE FOR DELETE TO public
  USING (( SELECT is_platform_admin()) OR ((( SELECT current_user_role()) = ANY (ARRAY['admin'::user_role, 'logistica'::user_role])) AND (EXISTS ( SELECT 1 FROM pedidos p
    WHERE ((p.id = pedido_logistica.pedido_id) AND (p.empresa_id = ( SELECT current_empresa_id())))))));
