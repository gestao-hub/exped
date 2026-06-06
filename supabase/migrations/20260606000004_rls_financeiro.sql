-- 20260606000004_rls_financeiro.sql
-- RLS do papel financeiro. Espelha o padrão multitenant (000005/000006):
--   financeiro LÊ todos os pedidos da empresa (como logística)
--   financeiro ATUALIZA pedido só enquanto status='em_financeiro' (pagamento/frete)
--     e pode movê-lo para 'pendente' (libera p/ logística) ou 'cancelado'.
-- Depende dos enums adicionados em 000001 (financeiro) e 000002 (em_financeiro).

-- ============================ pedidos ============================
drop policy if exists "pedidos_read" on public.pedidos;
create policy "pedidos_read" on public.pedidos for select using (
  public.is_platform_admin()
  or (empresa_id = public.current_empresa_id()
      and (current_user_role() in ('admin','logistica','financeiro') or vendedor_id = auth.uid()))
);

-- Vendedor: só age ANTES da logística — edita rascunho, envia rascunho→em_financeiro,
-- e pode cancelar enquanto rascunho/em_financeiro. NÃO escreve em pedido já 'pendente'
-- (fila da logística) nem consegue voltar pendente→em_financeiro (bypass do financeiro).
-- Depois que o financeiro libera, só logística/admin agem (pedidos_logistica_u / admin_all).
drop policy if exists "pedidos_vendedor_update" on public.pedidos;
create policy "pedidos_vendedor_update" on public.pedidos for update
  using (empresa_id = public.current_empresa_id() and current_user_role() = 'vendedor'
         and vendedor_id = auth.uid() and status in ('rascunho','em_financeiro'))
  with check (empresa_id = public.current_empresa_id() and current_user_role() = 'vendedor'
         and vendedor_id = auth.uid() and status in ('rascunho','em_financeiro','cancelado'));

-- Financeiro: atualiza o pedido na sua fila e o libera p/ logística.
drop policy if exists "pedidos_financeiro_u" on public.pedidos;
create policy "pedidos_financeiro_u" on public.pedidos for update
  using (empresa_id = public.current_empresa_id() and current_user_role() = 'financeiro'
         and status = 'em_financeiro')
  with check (empresa_id = public.current_empresa_id() and current_user_role() = 'financeiro'
         and status in ('em_financeiro','pendente','cancelado'));

-- ============================ filhos (read p/ financeiro) ============================
drop policy if exists "pontos_via_pedido" on public.pedido_pontos_retirada;
create policy "pontos_via_pedido" on public.pedido_pontos_retirada for all using (
  public.is_platform_admin() or exists (
    select 1 from public.pedidos p where p.id = pedido_id
      and p.empresa_id = public.current_empresa_id()
      and (current_user_role() in ('admin','logistica','financeiro') or p.vendedor_id = auth.uid()))
) with check (
  public.is_platform_admin() or exists (
    select 1 from public.pedidos p where p.id = pedido_id
      and p.empresa_id = public.current_empresa_id()
      and (current_user_role() in ('admin','logistica','financeiro') or p.vendedor_id = auth.uid()))
);

drop policy if exists "itens_via_ponto" on public.pedido_itens;
create policy "itens_via_ponto" on public.pedido_itens for all using (
  public.is_platform_admin() or exists (
    select 1 from public.pedido_pontos_retirada pr
    join public.pedidos p on p.id = pr.pedido_id
    where pr.id = ponto_retirada_id and p.empresa_id = public.current_empresa_id()
      and (current_user_role() in ('admin','logistica','financeiro') or p.vendedor_id = auth.uid()))
) with check (
  public.is_platform_admin() or exists (
    select 1 from public.pedido_pontos_retirada pr
    join public.pedidos p on p.id = pr.pedido_id
    where pr.id = ponto_retirada_id and p.empresa_id = public.current_empresa_id()
      and (current_user_role() in ('admin','logistica','financeiro') or p.vendedor_id = auth.uid()))
);

drop policy if exists "logistica_read" on public.pedido_logistica;
create policy "logistica_read" on public.pedido_logistica for select using (
  public.is_platform_admin() or exists (
    select 1 from public.pedidos p where p.id = pedido_id
      and p.empresa_id = public.current_empresa_id()
      and (current_user_role() in ('admin','logistica','financeiro') or p.vendedor_id = auth.uid()))
);

drop policy if exists "eventos_read" on public.pedido_eventos;
create policy "eventos_read" on public.pedido_eventos for select using (
  public.is_platform_admin() or exists (
    select 1 from public.pedidos p where p.id = pedido_id
      and p.empresa_id = public.current_empresa_id()
      and (current_user_role() in ('admin','logistica','financeiro') or p.vendedor_id = auth.uid()))
);
