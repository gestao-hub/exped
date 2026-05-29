-- 20260530000005_rls_multitenant_topo.sql
-- RLS por empresa: (papel) AND (empresa_id = current_empresa_id()) OR is_platform_admin()

-- empresas: membro lê a sua; platform admin tudo
drop policy if exists empresas_member_read on public.empresas;
create policy empresas_member_read on public.empresas for select to authenticated
  using (id = public.current_empresa_id() or public.is_platform_admin());
drop policy if exists empresas_platform_all on public.empresas;
create policy empresas_platform_all on public.empresas for all to authenticated
  using (public.is_platform_admin()) with check (public.is_platform_admin());

-- profiles
drop policy if exists "profiles_self_read" on public.profiles;
create policy "profiles_self_read" on public.profiles for select using (
  public.is_platform_admin()
  or id = auth.uid()
  or (current_user_role() = 'admin' and empresa_id = public.current_empresa_id())
);
drop policy if exists "profiles_admin_all" on public.profiles;
create policy "profiles_admin_all" on public.profiles for all using (
  public.is_platform_admin()
  or (current_user_role() = 'admin' and empresa_id = public.current_empresa_id())
) with check (
  public.is_platform_admin()
  or (current_user_role() = 'admin' and empresa_id = public.current_empresa_id())
);

-- Anti-escalonamento: usuário comum não muda role/empresa_id/is_platform_admin de si mesmo.
-- Contexto de servidor/migração (auth.uid() null = service_role / SQL direto) é confiável
-- e passa — é como o onboarding atribui empresa/role ao novo usuário.
create or replace function public.prevent_self_role_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    return new;  -- service_role / migração: confiável
  end if;
  if (new.role is distinct from old.role)
     and not (current_user_role() = 'admin' or public.is_platform_admin()) then
    raise exception 'Você não pode alterar o próprio role';
  end if;
  if (new.empresa_id is distinct from old.empresa_id) and not public.is_platform_admin() then
    raise exception 'Você não pode alterar a empresa do perfil';
  end if;
  if (new.is_platform_admin is distinct from old.is_platform_admin) and not public.is_platform_admin() then
    raise exception 'Você não pode alterar is_platform_admin';
  end if;
  return new;
end $$;

-- Garante o trigger anexado (autossuficiente nesta migration)
drop trigger if exists profiles_prevent_role_change on public.profiles;
create trigger profiles_prevent_role_change
  before update on public.profiles
  for each row execute function public.prevent_self_role_change();

-- pedidos
drop policy if exists "pedidos_read" on public.pedidos;
create policy "pedidos_read" on public.pedidos for select using (
  public.is_platform_admin()
  or (empresa_id = public.current_empresa_id()
      and (current_user_role() in ('admin','logistica') or vendedor_id = auth.uid()))
);
drop policy if exists "pedidos_vendedor_iu" on public.pedidos;
create policy "pedidos_vendedor_iu" on public.pedidos for insert with check (
  empresa_id = public.current_empresa_id()
  and current_user_role() = 'vendedor' and vendedor_id = auth.uid()
);
drop policy if exists "pedidos_vendedor_update" on public.pedidos;
create policy "pedidos_vendedor_update" on public.pedidos for update
  using (empresa_id = public.current_empresa_id() and current_user_role() = 'vendedor'
         and vendedor_id = auth.uid() and status in ('rascunho','pendente'))
  with check (empresa_id = public.current_empresa_id() and current_user_role() = 'vendedor'
         and vendedor_id = auth.uid() and status in ('rascunho','pendente','cancelado'));
drop policy if exists "pedidos_logistica_u" on public.pedidos;
create policy "pedidos_logistica_u" on public.pedidos for update
  using (empresa_id = public.current_empresa_id() and current_user_role() = 'logistica')
  with check (empresa_id = public.current_empresa_id() and current_user_role() = 'logistica');
drop policy if exists "pedidos_admin_all" on public.pedidos;
create policy "pedidos_admin_all" on public.pedidos for all using (
  public.is_platform_admin() or (empresa_id = public.current_empresa_id() and current_user_role() = 'admin')
) with check (
  public.is_platform_admin() or (empresa_id = public.current_empresa_id() and current_user_role() = 'admin')
);

-- clientes
drop policy if exists clientes_read on public.clientes;
create policy clientes_read on public.clientes for select to authenticated
  using (public.is_platform_admin() or empresa_id = public.current_empresa_id());
drop policy if exists clientes_insert on public.clientes;
create policy clientes_insert on public.clientes for insert to authenticated
  with check (empresa_id = public.current_empresa_id());
drop policy if exists clientes_admin_update on public.clientes;
create policy clientes_admin_update on public.clientes for update to authenticated
  using (empresa_id = public.current_empresa_id() and current_user_role() = 'admin')
  with check (empresa_id = public.current_empresa_id() and current_user_role() = 'admin');
drop policy if exists clientes_admin_delete on public.clientes;
create policy clientes_admin_delete on public.clientes for delete to authenticated
  using (empresa_id = public.current_empresa_id() and current_user_role() = 'admin');

-- cliente_enderecos
drop policy if exists enderecos_read on public.cliente_enderecos;
create policy enderecos_read on public.cliente_enderecos for select
  using (public.is_platform_admin() or empresa_id = public.current_empresa_id());
drop policy if exists enderecos_insert on public.cliente_enderecos;
create policy enderecos_insert on public.cliente_enderecos for insert
  with check (empresa_id = public.current_empresa_id());
drop policy if exists enderecos_update on public.cliente_enderecos;
create policy enderecos_update on public.cliente_enderecos for update
  using (empresa_id = public.current_empresa_id() and public.current_user_role() = 'admin')
  with check (empresa_id = public.current_empresa_id() and public.current_user_role() = 'admin');
drop policy if exists enderecos_delete on public.cliente_enderecos;
create policy enderecos_delete on public.cliente_enderecos for delete
  using (empresa_id = public.current_empresa_id() and public.current_user_role() = 'admin');
