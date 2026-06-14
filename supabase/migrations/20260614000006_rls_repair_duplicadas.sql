-- 20260614000006_rls_repair_duplicadas.sql
-- REPARO: um descompasso no schema_migrations da nuvem (registrava só as 1ªs migrations)
-- fez um runner re-aplicar políticas RLS antigas POR CIMA das consolidadas (20260614000004/5),
-- duplicando-as em pedidos/profiles/pedido_logistica (advisors initplan + multiple_permissive
-- voltaram). Esta migration CONVERGE essas 3 tabelas pro estado consolidado correto,
-- independentemente do que estiver lá: dropa TODAS as políticas (nomes antigos E novos) e
-- recria só o conjunto consolidado + embrulhado (initplan). Idempotente e re-rodável.

-- ===== pedidos =====
DROP POLICY IF EXISTS "pedidos_admin_all" ON public.pedidos;
DROP POLICY IF EXISTS "pedidos_vendedor_iu" ON public.pedidos;
DROP POLICY IF EXISTS "pedidos_financeiro_u" ON public.pedidos;
DROP POLICY IF EXISTS "pedidos_logistica_u" ON public.pedidos;
DROP POLICY IF EXISTS "pedidos_vendedor_update" ON public.pedidos;
DROP POLICY IF EXISTS "pedidos_read" ON public.pedidos;
DROP POLICY IF EXISTS "pedidos_insert" ON public.pedidos;
DROP POLICY IF EXISTS "pedidos_update" ON public.pedidos;
DROP POLICY IF EXISTS "pedidos_delete" ON public.pedidos;
CREATE POLICY "pedidos_read" ON public.pedidos AS PERMISSIVE FOR SELECT TO public
  USING (
    ( SELECT is_platform_admin())
    OR ((empresa_id = ( SELECT current_empresa_id()))
        AND ((( SELECT current_user_role()) = ANY (ARRAY['admin'::user_role, 'logistica'::user_role, 'financeiro'::user_role]))
             OR (vendedor_id = ( SELECT auth.uid()))))
  );
CREATE POLICY "pedidos_insert" ON public.pedidos AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (
    ( SELECT is_platform_admin())
    OR ((empresa_id = ( SELECT current_empresa_id())) AND (( SELECT current_user_role()) = 'admin'::user_role))
    OR ((empresa_id = ( SELECT current_empresa_id())) AND (( SELECT current_user_role()) = 'vendedor'::user_role) AND (vendedor_id = ( SELECT auth.uid())))
  );
CREATE POLICY "pedidos_update" ON public.pedidos AS PERMISSIVE FOR UPDATE TO public
  USING (
    ( SELECT is_platform_admin())
    OR ((empresa_id = ( SELECT current_empresa_id())) AND (( SELECT current_user_role()) = 'admin'::user_role))
    OR ((empresa_id = ( SELECT current_empresa_id())) AND (( SELECT current_user_role()) = 'financeiro'::user_role) AND (status = 'em_financeiro'::pedido_status))
    OR ((empresa_id = ( SELECT current_empresa_id())) AND (( SELECT current_user_role()) = 'logistica'::user_role))
    OR ((empresa_id = ( SELECT current_empresa_id())) AND (( SELECT current_user_role()) = 'vendedor'::user_role) AND (vendedor_id = ( SELECT auth.uid())) AND (status = ANY (ARRAY['rascunho'::pedido_status, 'em_financeiro'::pedido_status])))
  )
  WITH CHECK (
    ( SELECT is_platform_admin())
    OR ((empresa_id = ( SELECT current_empresa_id())) AND (( SELECT current_user_role()) = 'admin'::user_role))
    OR ((empresa_id = ( SELECT current_empresa_id())) AND (( SELECT current_user_role()) = 'financeiro'::user_role) AND (status = ANY (ARRAY['em_financeiro'::pedido_status, 'pendente'::pedido_status, 'cancelado'::pedido_status])))
    OR ((empresa_id = ( SELECT current_empresa_id())) AND (( SELECT current_user_role()) = 'logistica'::user_role))
    OR ((empresa_id = ( SELECT current_empresa_id())) AND (( SELECT current_user_role()) = 'vendedor'::user_role) AND (vendedor_id = ( SELECT auth.uid())) AND (status = ANY (ARRAY['rascunho'::pedido_status, 'em_financeiro'::pedido_status, 'cancelado'::pedido_status])))
  );
CREATE POLICY "pedidos_delete" ON public.pedidos AS PERMISSIVE FOR DELETE TO public
  USING (
    ( SELECT is_platform_admin())
    OR ((empresa_id = ( SELECT current_empresa_id())) AND (( SELECT current_user_role()) = 'admin'::user_role))
  );

-- ===== profiles =====
DROP POLICY IF EXISTS "profiles_admin_all" ON public.profiles;
DROP POLICY IF EXISTS "profiles_self_read" ON public.profiles;
DROP POLICY IF EXISTS "profiles_self_update" ON public.profiles;
DROP POLICY IF EXISTS "profiles_read" ON public.profiles;
DROP POLICY IF EXISTS "profiles_insert" ON public.profiles;
DROP POLICY IF EXISTS "profiles_update" ON public.profiles;
DROP POLICY IF EXISTS "profiles_delete" ON public.profiles;
CREATE POLICY "profiles_read" ON public.profiles AS PERMISSIVE FOR SELECT TO public
  USING (( SELECT is_platform_admin()) OR (id = ( SELECT auth.uid())) OR ((( SELECT current_user_role()) = 'admin'::user_role) AND (empresa_id = ( SELECT current_empresa_id()))));
CREATE POLICY "profiles_insert" ON public.profiles AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (( SELECT is_platform_admin()) OR ((( SELECT current_user_role()) = 'admin'::user_role) AND (empresa_id = ( SELECT current_empresa_id()))));
CREATE POLICY "profiles_update" ON public.profiles AS PERMISSIVE FOR UPDATE TO public
  USING (( SELECT is_platform_admin()) OR (id = ( SELECT auth.uid())) OR ((( SELECT current_user_role()) = 'admin'::user_role) AND (empresa_id = ( SELECT current_empresa_id()))))
  WITH CHECK (( SELECT is_platform_admin()) OR (id = ( SELECT auth.uid())) OR ((( SELECT current_user_role()) = 'admin'::user_role) AND (empresa_id = ( SELECT current_empresa_id()))));
CREATE POLICY "profiles_delete" ON public.profiles AS PERMISSIVE FOR DELETE TO public
  USING (( SELECT is_platform_admin()) OR ((( SELECT current_user_role()) = 'admin'::user_role) AND (empresa_id = ( SELECT current_empresa_id()))));

-- ===== pedido_logistica =====
DROP POLICY IF EXISTS "logistica_write" ON public.pedido_logistica;
DROP POLICY IF EXISTS "logistica_read" ON public.pedido_logistica;
DROP POLICY IF EXISTS "logistica_insert" ON public.pedido_logistica;
DROP POLICY IF EXISTS "logistica_update" ON public.pedido_logistica;
DROP POLICY IF EXISTS "logistica_delete" ON public.pedido_logistica;
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
