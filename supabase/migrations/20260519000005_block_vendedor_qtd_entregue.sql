-- Migration 12: bloqueia vendedor de alterar quantidade_entregue
-- Defesa em profundidade: action server-side já bloqueia, mas vendedor
-- com conhecimento técnico poderia chamar PostgREST direto (RLS atual
-- permite UPDATE por owner). Trigger barra no banco.

create or replace function public.prevent_vendedor_qtd_entregue()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.current_user_role() = 'vendedor'
     and new.quantidade_entregue is distinct from old.quantidade_entregue then
    raise exception 'Vendedor não pode alterar quantidade entregue (somente logística/admin via Registrar Entrega)';
  end if;
  return new;
end $$;

drop trigger if exists pedido_itens_block_vendedor_qtd_entregue on public.pedido_itens;
create trigger pedido_itens_block_vendedor_qtd_entregue
  before update on public.pedido_itens
  for each row execute function public.prevent_vendedor_qtd_entregue();
