-- Supabase deixou de expor automaticamente tabelas novas do schema public.
-- As grants abaixo liberam a Data API de forma explicita; RLS continua sendo
-- a camada que decide quais linhas cada usuario autenticado pode acessar.
grant usage on schema public to authenticated, service_role;

grant select, insert, update on table
  public.cliente_enderecos,
  public.clientes,
  public.dispositivos,
  public.empresas,
  public.hiper_vendedor_map,
  public.ordens_servico,
  public.os_itens,
  public.os_notificacoes,
  public.os_servicos,
  public.pedido_comentarios,
  public.pedido_eventos,
  public.pedido_itens,
  public.pedido_logistica,
  public.pedido_pontos_retirada,
  public.pedidos,
  public.profiles,
  public.provisioning_codes
to authenticated;

-- Enderecos e comentarios ainda possuem remocao explicita na UI. Itens e pontos
-- usam tombstones; o papel autenticado nunca recebe hard delete do historico.
revoke delete on table
  public.clientes,
  public.dispositivos,
  public.empresas,
  public.hiper_vendedor_map,
  public.ordens_servico,
  public.os_itens,
  public.os_notificacoes,
  public.os_servicos,
  public.pedido_eventos,
  public.pedido_itens,
  public.pedido_logistica,
  public.pedido_pontos_retirada,
  public.pedidos,
  public.profiles,
  public.provisioning_codes
from authenticated;

grant delete on table
  public.cliente_enderecos,
  public.pedido_comentarios
to authenticated;

-- As politicas legadas FOR ALL misturavam leitura e escrita. Separa as operacoes:
-- financeiro permanece read-only; vendedor edita somente o proprio rascunho;
-- admin/logistica nao alteram filhos de pedido ja historico.
drop policy if exists "itens_via_ponto" on public.pedido_itens;
drop policy if exists "pedido_itens_delete_operacional" on public.pedido_itens;
drop policy if exists "pedido_itens_select_tenant" on public.pedido_itens;
drop policy if exists "pedido_itens_insert_operacional" on public.pedido_itens;
drop policy if exists "pedido_itens_update_operacional" on public.pedido_itens;

create policy "pedido_itens_select_tenant"
on public.pedido_itens
for select
to authenticated
using (
  (select is_platform_admin())
  or exists (
    select 1
    from public.pedido_pontos_retirada pr
    join public.pedidos p on p.id = pr.pedido_id
    where pr.id = pedido_itens.ponto_retirada_id
      and p.empresa_id = (select current_empresa_id())
      and (
        (select current_user_role()) = any (
          array['admin'::user_role, 'logistica'::user_role, 'financeiro'::user_role]
        )
        or p.vendedor_id = (select auth.uid())
      )
  )
);

create policy "pedido_itens_insert_operacional"
on public.pedido_itens
for insert
to authenticated
with check (
  (select is_platform_admin())
  or exists (
    select 1
    from public.pedido_pontos_retirada pr
    join public.pedidos p on p.id = pr.pedido_id
    where pr.id = pedido_itens.ponto_retirada_id
      and pr.deleted_at is null
      and p.empresa_id = (select current_empresa_id())
      and p.deleted_at is null
      and (
        (
          (select current_user_role()) = any (array['admin'::user_role, 'logistica'::user_role])
          and p.status not in ('finalizado'::pedido_status, 'cancelado'::pedido_status)
        )
        or (
          (select current_user_role()) = 'vendedor'::user_role
          and p.vendedor_id = (select auth.uid())
          and p.status = 'rascunho'::pedido_status
        )
      )
  )
);

create policy "pedido_itens_update_operacional"
on public.pedido_itens
for update
to authenticated
using (
  (select is_platform_admin())
  or exists (
    select 1
    from public.pedido_pontos_retirada pr
    join public.pedidos p on p.id = pr.pedido_id
    where pr.id = pedido_itens.ponto_retirada_id
      and pr.deleted_at is null
      and p.empresa_id = (select current_empresa_id())
      and p.deleted_at is null
      and (
        (
          (select current_user_role()) = any (array['admin'::user_role, 'logistica'::user_role])
          and p.status not in ('finalizado'::pedido_status, 'cancelado'::pedido_status)
        )
        or (
          (select current_user_role()) = 'vendedor'::user_role
          and p.vendedor_id = (select auth.uid())
          and p.status = 'rascunho'::pedido_status
        )
      )
  )
)
with check (
  (select is_platform_admin())
  or exists (
    select 1
    from public.pedido_pontos_retirada pr
    join public.pedidos p on p.id = pr.pedido_id
    where pr.id = pedido_itens.ponto_retirada_id
      and pr.deleted_at is null
      and p.empresa_id = (select current_empresa_id())
      and p.deleted_at is null
      and (
        (
          (select current_user_role()) = any (array['admin'::user_role, 'logistica'::user_role])
          and p.status not in ('finalizado'::pedido_status, 'cancelado'::pedido_status)
        )
        or (
          (select current_user_role()) = 'vendedor'::user_role
          and p.vendedor_id = (select auth.uid())
          and p.status = 'rascunho'::pedido_status
        )
      )
  )
);

drop policy if exists "pontos_via_pedido" on public.pedido_pontos_retirada;
drop policy if exists "pedido_pontos_delete_operacional" on public.pedido_pontos_retirada;
drop policy if exists "pedido_pontos_select_tenant" on public.pedido_pontos_retirada;
drop policy if exists "pedido_pontos_insert_operacional" on public.pedido_pontos_retirada;
drop policy if exists "pedido_pontos_update_operacional" on public.pedido_pontos_retirada;

create policy "pedido_pontos_select_tenant"
on public.pedido_pontos_retirada
for select
to authenticated
using (
  (select is_platform_admin())
  or exists (
    select 1
    from public.pedidos p
    where p.id = pedido_pontos_retirada.pedido_id
      and p.empresa_id = (select current_empresa_id())
      and (
        (select current_user_role()) = any (
          array['admin'::user_role, 'logistica'::user_role, 'financeiro'::user_role]
        )
        or p.vendedor_id = (select auth.uid())
      )
  )
);

create policy "pedido_pontos_insert_operacional"
on public.pedido_pontos_retirada
for insert
to authenticated
with check (
  (select is_platform_admin())
  or exists (
    select 1
    from public.pedidos p
    where p.id = pedido_pontos_retirada.pedido_id
      and p.empresa_id = (select current_empresa_id())
      and p.deleted_at is null
      and (
        (
          (select current_user_role()) = any (array['admin'::user_role, 'logistica'::user_role])
          and p.status not in ('finalizado'::pedido_status, 'cancelado'::pedido_status)
        )
        or (
          (select current_user_role()) = 'vendedor'::user_role
          and p.vendedor_id = (select auth.uid())
          and p.status = 'rascunho'::pedido_status
        )
      )
  )
);

create policy "pedido_pontos_update_operacional"
on public.pedido_pontos_retirada
for update
to authenticated
using (
  (select is_platform_admin())
  or exists (
    select 1
    from public.pedidos p
    where p.id = pedido_pontos_retirada.pedido_id
      and p.empresa_id = (select current_empresa_id())
      and p.deleted_at is null
      and (
        (
          (select current_user_role()) = any (array['admin'::user_role, 'logistica'::user_role])
          and p.status not in ('finalizado'::pedido_status, 'cancelado'::pedido_status)
        )
        or (
          (select current_user_role()) = 'vendedor'::user_role
          and p.vendedor_id = (select auth.uid())
          and p.status = 'rascunho'::pedido_status
        )
      )
  )
)
with check (
  (select is_platform_admin())
  or exists (
    select 1
    from public.pedidos p
    where p.id = pedido_pontos_retirada.pedido_id
      and p.empresa_id = (select current_empresa_id())
      and p.deleted_at is null
      and (
        (
          (select current_user_role()) = any (array['admin'::user_role, 'logistica'::user_role])
          and p.status not in ('finalizado'::pedido_status, 'cancelado'::pedido_status)
        )
        or (
          (select current_user_role()) = 'vendedor'::user_role
          and p.vendedor_id = (select auth.uid())
          and p.status = 'rascunho'::pedido_status
        )
      )
  )
);

-- O admin so remove comentarios de pedidos da propria empresa. Autores tambem
-- precisam continuar pertencendo ao tenant do pedido.
drop policy if exists "comentarios_delete" on public.pedido_comentarios;
create policy "comentarios_delete"
on public.pedido_comentarios
for delete
to authenticated
using (
  (select is_platform_admin())
  or exists (
    select 1
    from public.pedidos p
    where p.id = pedido_comentarios.pedido_id
      and p.empresa_id = (select current_empresa_id())
      and (
        pedido_comentarios.autor_id = (select auth.uid())
        or (select current_user_role()) = 'admin'::user_role
      )
  )
);

grant select, insert, update, delete on table
  public.cliente_enderecos,
  public.clientes,
  public.dispositivos,
  public.empresas,
  public.hiper_vendedor_map,
  public.ordens_servico,
  public.os_itens,
  public.os_notificacoes,
  public.os_servicos,
  public.pedido_comentarios,
  public.pedido_eventos,
  public.pedido_itens,
  public.pedido_logistica,
  public.pedido_pontos_retirada,
  public.pedidos,
  public.profiles,
  public.provisioning_codes
to service_role;

grant usage, select on all sequences in schema public
to authenticated, service_role;
