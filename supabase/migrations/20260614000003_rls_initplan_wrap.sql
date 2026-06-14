-- 20260614000003_rls_initplan_wrap.sql
-- Otimização RLS (advisor: auth_rls_initplan): embrulha as chamadas de função
-- (current_empresa_id/current_user_role/is_platform_admin/auth.uid) em ( SELECT ... )
-- para o Postgres avaliá-las UMA vez por query (initPlan) em vez de 1x por linha.
-- Reescrita SEMANTICAMENTE IDÊNTICA (só muda o plano). Tabelas sem políticas
-- permissivas duplicadas (essas são consolidadas em migration própria).

DROP POLICY IF EXISTS "enderecos_delete" ON public.cliente_enderecos;
CREATE POLICY "enderecos_delete" ON public.cliente_enderecos AS PERMISSIVE FOR DELETE TO public
  USING (((empresa_id = ( SELECT current_empresa_id())) AND (( SELECT current_user_role()) = 'admin'::user_role)));
DROP POLICY IF EXISTS "enderecos_insert" ON public.cliente_enderecos;
CREATE POLICY "enderecos_insert" ON public.cliente_enderecos AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((empresa_id = ( SELECT current_empresa_id())));
DROP POLICY IF EXISTS "enderecos_read" ON public.cliente_enderecos;
CREATE POLICY "enderecos_read" ON public.cliente_enderecos AS PERMISSIVE FOR SELECT TO public
  USING ((( SELECT is_platform_admin()) OR (empresa_id = ( SELECT current_empresa_id()))));
DROP POLICY IF EXISTS "enderecos_update" ON public.cliente_enderecos;
CREATE POLICY "enderecos_update" ON public.cliente_enderecos AS PERMISSIVE FOR UPDATE TO public
  USING (((empresa_id = ( SELECT current_empresa_id())) AND (( SELECT current_user_role()) = 'admin'::user_role)))
  WITH CHECK (((empresa_id = ( SELECT current_empresa_id())) AND (( SELECT current_user_role()) = 'admin'::user_role)));
DROP POLICY IF EXISTS "clientes_admin_delete" ON public.clientes;
CREATE POLICY "clientes_admin_delete" ON public.clientes AS PERMISSIVE FOR DELETE TO authenticated
  USING (((empresa_id = ( SELECT current_empresa_id())) AND (( SELECT current_user_role()) = 'admin'::user_role)));
DROP POLICY IF EXISTS "clientes_insert" ON public.clientes;
CREATE POLICY "clientes_insert" ON public.clientes AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((empresa_id = ( SELECT current_empresa_id())));
DROP POLICY IF EXISTS "clientes_read" ON public.clientes;
CREATE POLICY "clientes_read" ON public.clientes AS PERMISSIVE FOR SELECT TO authenticated
  USING ((( SELECT is_platform_admin()) OR (empresa_id = ( SELECT current_empresa_id()))));
DROP POLICY IF EXISTS "clientes_admin_update" ON public.clientes;
CREATE POLICY "clientes_admin_update" ON public.clientes AS PERMISSIVE FOR UPDATE TO authenticated
  USING (((empresa_id = ( SELECT current_empresa_id())) AND (( SELECT current_user_role()) = 'admin'::user_role)))
  WITH CHECK (((empresa_id = ( SELECT current_empresa_id())) AND (( SELECT current_user_role()) = 'admin'::user_role)));
DROP POLICY IF EXISTS "os_itens_via_os" ON public.os_itens;
CREATE POLICY "os_itens_via_os" ON public.os_itens AS PERMISSIVE FOR ALL TO public
  USING ((( SELECT is_platform_admin()) OR (EXISTS ( SELECT 1
   FROM ordens_servico o
  WHERE ((o.id = os_itens.os_id) AND (o.empresa_id = ( SELECT current_empresa_id())) AND ((( SELECT current_user_role()) = ANY (ARRAY['admin'::user_role, 'logistica'::user_role])) OR (o.vendedor_id = ( SELECT auth.uid()))))))))
  WITH CHECK ((( SELECT is_platform_admin()) OR (EXISTS ( SELECT 1
   FROM ordens_servico o
  WHERE ((o.id = os_itens.os_id) AND (o.empresa_id = ( SELECT current_empresa_id())) AND ((( SELECT current_user_role()) = ANY (ARRAY['admin'::user_role, 'logistica'::user_role])) OR (o.vendedor_id = ( SELECT auth.uid()))))))));
DROP POLICY IF EXISTS "os_notif_admin" ON public.os_notificacoes;
CREATE POLICY "os_notif_admin" ON public.os_notificacoes AS PERMISSIVE FOR ALL TO public
  USING ((( SELECT is_platform_admin()) OR ((empresa_id = ( SELECT current_empresa_id())) AND (( SELECT current_user_role()) = 'admin'::user_role))))
  WITH CHECK ((( SELECT is_platform_admin()) OR ((empresa_id = ( SELECT current_empresa_id())) AND (( SELECT current_user_role()) = 'admin'::user_role))));
DROP POLICY IF EXISTS "os_servicos_via_os" ON public.os_servicos;
CREATE POLICY "os_servicos_via_os" ON public.os_servicos AS PERMISSIVE FOR ALL TO public
  USING ((( SELECT is_platform_admin()) OR (EXISTS ( SELECT 1
   FROM ordens_servico o
  WHERE ((o.id = os_servicos.os_id) AND (o.empresa_id = ( SELECT current_empresa_id())) AND ((( SELECT current_user_role()) = ANY (ARRAY['admin'::user_role, 'logistica'::user_role])) OR (o.vendedor_id = ( SELECT auth.uid()))))))))
  WITH CHECK ((( SELECT is_platform_admin()) OR (EXISTS ( SELECT 1
   FROM ordens_servico o
  WHERE ((o.id = os_servicos.os_id) AND (o.empresa_id = ( SELECT current_empresa_id())) AND ((( SELECT current_user_role()) = ANY (ARRAY['admin'::user_role, 'logistica'::user_role])) OR (o.vendedor_id = ( SELECT auth.uid()))))))));
DROP POLICY IF EXISTS "comentarios_delete" ON public.pedido_comentarios;
CREATE POLICY "comentarios_delete" ON public.pedido_comentarios AS PERMISSIVE FOR DELETE TO authenticated
  USING (((autor_id = ( SELECT auth.uid())) OR (( SELECT current_user_role()) = 'admin'::user_role)));
DROP POLICY IF EXISTS "comentarios_insert" ON public.pedido_comentarios;
CREATE POLICY "comentarios_insert" ON public.pedido_comentarios AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((autor_id = ( SELECT auth.uid())) AND (EXISTS ( SELECT 1
   FROM pedidos p
  WHERE ((p.id = pedido_comentarios.pedido_id) AND (p.empresa_id = ( SELECT current_empresa_id())))))));
DROP POLICY IF EXISTS "comentarios_read" ON public.pedido_comentarios;
CREATE POLICY "comentarios_read" ON public.pedido_comentarios AS PERMISSIVE FOR SELECT TO authenticated
  USING ((( SELECT is_platform_admin()) OR (EXISTS ( SELECT 1
   FROM pedidos p
  WHERE ((p.id = pedido_comentarios.pedido_id) AND (p.empresa_id = ( SELECT current_empresa_id())))))));
DROP POLICY IF EXISTS "eventos_insert" ON public.pedido_eventos;
CREATE POLICY "eventos_insert" ON public.pedido_eventos AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((( SELECT is_platform_admin()) OR (EXISTS ( SELECT 1
   FROM pedidos p
  WHERE ((p.id = pedido_eventos.pedido_id) AND (p.empresa_id = ( SELECT current_empresa_id())) AND ((( SELECT current_user_role()) = ANY (ARRAY['admin'::user_role, 'logistica'::user_role])) OR (p.vendedor_id = ( SELECT auth.uid()))))))));
DROP POLICY IF EXISTS "eventos_read" ON public.pedido_eventos;
CREATE POLICY "eventos_read" ON public.pedido_eventos AS PERMISSIVE FOR SELECT TO public
  USING ((( SELECT is_platform_admin()) OR (EXISTS ( SELECT 1
   FROM pedidos p
  WHERE ((p.id = pedido_eventos.pedido_id) AND (p.empresa_id = ( SELECT current_empresa_id())) AND ((( SELECT current_user_role()) = ANY (ARRAY['admin'::user_role, 'logistica'::user_role, 'financeiro'::user_role])) OR (p.vendedor_id = ( SELECT auth.uid()))))))));
DROP POLICY IF EXISTS "itens_via_ponto" ON public.pedido_itens;
CREATE POLICY "itens_via_ponto" ON public.pedido_itens AS PERMISSIVE FOR ALL TO public
  USING ((( SELECT is_platform_admin()) OR (EXISTS ( SELECT 1
   FROM (pedido_pontos_retirada pr
     JOIN pedidos p ON ((p.id = pr.pedido_id)))
  WHERE ((pr.id = pedido_itens.ponto_retirada_id) AND (p.empresa_id = ( SELECT current_empresa_id())) AND ((( SELECT current_user_role()) = ANY (ARRAY['admin'::user_role, 'logistica'::user_role, 'financeiro'::user_role])) OR (p.vendedor_id = ( SELECT auth.uid()))))))))
  WITH CHECK ((( SELECT is_platform_admin()) OR (EXISTS ( SELECT 1
   FROM (pedido_pontos_retirada pr
     JOIN pedidos p ON ((p.id = pr.pedido_id)))
  WHERE ((pr.id = pedido_itens.ponto_retirada_id) AND (p.empresa_id = ( SELECT current_empresa_id())) AND ((( SELECT current_user_role()) = ANY (ARRAY['admin'::user_role, 'logistica'::user_role, 'financeiro'::user_role])) OR (p.vendedor_id = ( SELECT auth.uid()))))))));
DROP POLICY IF EXISTS "pontos_via_pedido" ON public.pedido_pontos_retirada;
CREATE POLICY "pontos_via_pedido" ON public.pedido_pontos_retirada AS PERMISSIVE FOR ALL TO public
  USING ((( SELECT is_platform_admin()) OR (EXISTS ( SELECT 1
   FROM pedidos p
  WHERE ((p.id = pedido_pontos_retirada.pedido_id) AND (p.empresa_id = ( SELECT current_empresa_id())) AND ((( SELECT current_user_role()) = ANY (ARRAY['admin'::user_role, 'logistica'::user_role, 'financeiro'::user_role])) OR (p.vendedor_id = ( SELECT auth.uid()))))))))
  WITH CHECK ((( SELECT is_platform_admin()) OR (EXISTS ( SELECT 1
   FROM pedidos p
  WHERE ((p.id = pedido_pontos_retirada.pedido_id) AND (p.empresa_id = ( SELECT current_empresa_id())) AND ((( SELECT current_user_role()) = ANY (ARRAY['admin'::user_role, 'logistica'::user_role, 'financeiro'::user_role])) OR (p.vendedor_id = ( SELECT auth.uid()))))))));
DROP POLICY IF EXISTS "provisioning_codes_platform" ON public.provisioning_codes;
CREATE POLICY "provisioning_codes_platform" ON public.provisioning_codes AS PERMISSIVE FOR ALL TO authenticated
  USING (( SELECT is_platform_admin()))
  WITH CHECK (( SELECT is_platform_admin()));
