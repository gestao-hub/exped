-- 20260617000002_pedidos_sem_vendedor_visivel.sql
-- Pedido SEM vendedor (vendedor_id NULL — ex.: usuário do Hiper não mapeado, que agora entra
-- sem 422) aparece pra TODOS os vendedores na "Meus Pedidos", pro responsável reconhecer e
-- assumir/enviar. Recria pedidos_read e pedidos_update adicionando "OR vendedor_id IS NULL" na
-- cláusula do vendedor. Mesma semântica de 20260614000004; só amplia o vendedor pro caso sem dono.

DROP POLICY IF EXISTS "pedidos_read" ON public.pedidos;
CREATE POLICY "pedidos_read" ON public.pedidos AS PERMISSIVE FOR SELECT TO public
  USING (
    ( SELECT is_platform_admin())
    OR ((empresa_id = ( SELECT current_empresa_id()))
        AND ((( SELECT current_user_role()) = ANY (ARRAY['admin'::user_role, 'logistica'::user_role, 'financeiro'::user_role]))
             OR (vendedor_id = ( SELECT auth.uid()))
             OR (vendedor_id IS NULL)))
  );

DROP POLICY IF EXISTS "pedidos_update" ON public.pedidos;
CREATE POLICY "pedidos_update" ON public.pedidos AS PERMISSIVE FOR UPDATE TO public
  USING (
    ( SELECT is_platform_admin())
    OR ((empresa_id = ( SELECT current_empresa_id())) AND (( SELECT current_user_role()) = 'admin'::user_role))
    OR ((empresa_id = ( SELECT current_empresa_id())) AND (( SELECT current_user_role()) = 'financeiro'::user_role) AND (status = 'em_financeiro'::pedido_status))
    OR ((empresa_id = ( SELECT current_empresa_id())) AND (( SELECT current_user_role()) = 'logistica'::user_role))
    OR ((empresa_id = ( SELECT current_empresa_id())) AND (( SELECT current_user_role()) = 'vendedor'::user_role) AND ((vendedor_id = ( SELECT auth.uid())) OR (vendedor_id IS NULL)) AND (status = ANY (ARRAY['rascunho'::pedido_status, 'em_financeiro'::pedido_status])))
  )
  WITH CHECK (
    ( SELECT is_platform_admin())
    OR ((empresa_id = ( SELECT current_empresa_id())) AND (( SELECT current_user_role()) = 'admin'::user_role))
    OR ((empresa_id = ( SELECT current_empresa_id())) AND (( SELECT current_user_role()) = 'financeiro'::user_role) AND (status = ANY (ARRAY['em_financeiro'::pedido_status, 'pendente'::pedido_status, 'cancelado'::pedido_status])))
    OR ((empresa_id = ( SELECT current_empresa_id())) AND (( SELECT current_user_role()) = 'logistica'::user_role))
    OR ((empresa_id = ( SELECT current_empresa_id())) AND (( SELECT current_user_role()) = 'vendedor'::user_role) AND ((vendedor_id = ( SELECT auth.uid())) OR (vendedor_id IS NULL)) AND (status = ANY (ARRAY['rascunho'::pedido_status, 'em_financeiro'::pedido_status, 'cancelado'::pedido_status])))
  );
