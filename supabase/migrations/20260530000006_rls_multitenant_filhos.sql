-- 20260530000006_rls_multitenant_filhos.sql
-- Filhos herdam a empresa via EXISTS no pedido (+ is_platform_admin).

drop policy if exists "pontos_via_pedido" on public.pedido_pontos_retirada;
create policy "pontos_via_pedido" on public.pedido_pontos_retirada for all using (
  public.is_platform_admin() or exists (
    select 1 from public.pedidos p where p.id = pedido_id
      and p.empresa_id = public.current_empresa_id()
      and (current_user_role() in ('admin','logistica') or p.vendedor_id = auth.uid()))
) with check (
  public.is_platform_admin() or exists (
    select 1 from public.pedidos p where p.id = pedido_id
      and p.empresa_id = public.current_empresa_id()
      and (current_user_role() in ('admin','logistica') or p.vendedor_id = auth.uid()))
);

drop policy if exists "itens_via_ponto" on public.pedido_itens;
create policy "itens_via_ponto" on public.pedido_itens for all using (
  public.is_platform_admin() or exists (
    select 1 from public.pedido_pontos_retirada pr
    join public.pedidos p on p.id = pr.pedido_id
    where pr.id = ponto_retirada_id and p.empresa_id = public.current_empresa_id()
      and (current_user_role() in ('admin','logistica') or p.vendedor_id = auth.uid()))
) with check (
  public.is_platform_admin() or exists (
    select 1 from public.pedido_pontos_retirada pr
    join public.pedidos p on p.id = pr.pedido_id
    where pr.id = ponto_retirada_id and p.empresa_id = public.current_empresa_id()
      and (current_user_role() in ('admin','logistica') or p.vendedor_id = auth.uid()))
);

drop policy if exists "logistica_read" on public.pedido_logistica;
create policy "logistica_read" on public.pedido_logistica for select using (
  public.is_platform_admin() or exists (
    select 1 from public.pedidos p where p.id = pedido_id
      and p.empresa_id = public.current_empresa_id()
      and (current_user_role() in ('admin','logistica') or p.vendedor_id = auth.uid()))
);
drop policy if exists "logistica_write" on public.pedido_logistica;
create policy "logistica_write" on public.pedido_logistica for all
  using (public.is_platform_admin() or (current_user_role() in ('admin','logistica')
    and exists (select 1 from public.pedidos p where p.id = pedido_id and p.empresa_id = public.current_empresa_id())))
  with check (public.is_platform_admin() or (current_user_role() in ('admin','logistica')
    and exists (select 1 from public.pedidos p where p.id = pedido_id and p.empresa_id = public.current_empresa_id())));

drop policy if exists "eventos_read" on public.pedido_eventos;
create policy "eventos_read" on public.pedido_eventos for select using (
  public.is_platform_admin() or exists (
    select 1 from public.pedidos p where p.id = pedido_id
      and p.empresa_id = public.current_empresa_id()
      and (current_user_role() in ('admin','logistica') or p.vendedor_id = auth.uid()))
);
drop policy if exists "eventos_insert" on public.pedido_eventos;
create policy "eventos_insert" on public.pedido_eventos for insert with check (
  public.is_platform_admin() or exists (
    select 1 from public.pedidos p where p.id = pedido_id
      and p.empresa_id = public.current_empresa_id()
      and (current_user_role() in ('admin','logistica') or p.vendedor_id = auth.uid()))
);

drop policy if exists comentarios_read on public.pedido_comentarios;
create policy comentarios_read on public.pedido_comentarios for select to authenticated using (
  public.is_platform_admin() or exists (
    select 1 from public.pedidos p where p.id = pedido_comentarios.pedido_id
      and p.empresa_id = public.current_empresa_id())
);
drop policy if exists comentarios_insert on public.pedido_comentarios;
create policy comentarios_insert on public.pedido_comentarios for insert to authenticated with check (
  autor_id = auth.uid() and exists (
    select 1 from public.pedidos p where p.id = pedido_comentarios.pedido_id
      and p.empresa_id = public.current_empresa_id())
);
-- comentarios_delete permanece (autor ou admin)
