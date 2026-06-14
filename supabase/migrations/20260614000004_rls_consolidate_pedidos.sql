-- 20260614000004_rls_consolidate_pedidos.sql
-- Consolida as políticas de `pedidos` (advisor: multiple_permissive_policies) + embrulha
-- as funções (initplan). Antes: 1 política ALL (admin) + 5 por ação se sobrepunham, fazendo
-- o Postgres avaliar 2-4 políticas permissivas por linha. Agora: UMA política por ação
-- (SELECT/INSERT/UPDATE/DELETE), com a condição de admin embutida via OR. Semântica de
-- acesso PRESERVADA (mesmas regras por papel; CHECKs de status mantidos exatamente).
DROP POLICY IF EXISTS "pedidos_admin_all" ON public.pedidos;
DROP POLICY IF EXISTS "pedidos_read" ON public.pedidos;
DROP POLICY IF EXISTS "pedidos_vendedor_iu" ON public.pedidos;
DROP POLICY IF EXISTS "pedidos_financeiro_u" ON public.pedidos;
DROP POLICY IF EXISTS "pedidos_logistica_u" ON public.pedidos;
DROP POLICY IF EXISTS "pedidos_vendedor_update" ON public.pedidos;

-- SELECT: admin/logística/financeiro veem tudo da empresa; vendedor vê os próprios.
CREATE POLICY "pedidos_read" ON public.pedidos AS PERMISSIVE FOR SELECT TO public
  USING (
    ( SELECT is_platform_admin())
    OR ((empresa_id = ( SELECT current_empresa_id()))
        AND ((( SELECT current_user_role()) = ANY (ARRAY['admin'::user_role, 'logistica'::user_role, 'financeiro'::user_role]))
             OR (vendedor_id = ( SELECT auth.uid()))))
  );

-- INSERT: admin (qualquer) ou vendedor criando o próprio.
CREATE POLICY "pedidos_insert" ON public.pedidos AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (
    ( SELECT is_platform_admin())
    OR ((empresa_id = ( SELECT current_empresa_id())) AND (( SELECT current_user_role()) = 'admin'::user_role))
    OR ((empresa_id = ( SELECT current_empresa_id())) AND (( SELECT current_user_role()) = 'vendedor'::user_role) AND (vendedor_id = ( SELECT auth.uid())))
  );

-- UPDATE: admin; financeiro (só em_financeiro→); logística; vendedor (próprio rascunho/em_financeiro).
-- CHECK preserva os conjuntos de status de destino de cada papel (mais amplos que o USING).
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

-- DELETE: só admin/plataforma (era coberto pela antiga política ALL).
CREATE POLICY "pedidos_delete" ON public.pedidos AS PERMISSIVE FOR DELETE TO public
  USING (
    ( SELECT is_platform_admin())
    OR ((empresa_id = ( SELECT current_empresa_id())) AND (( SELECT current_user_role()) = 'admin'::user_role))
  );
