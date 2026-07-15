create or replace function public.null_missing_vendedor_id()
returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
begin
  if current_setting('exped.sync', true) = 'on'
     and new.vendedor_id is not null
     and not exists (
       select 1
       from public.profiles p
       where p.id = new.vendedor_id
     ) then
    new.vendedor_id := null;
  end if;

  return new;
end;
$$;

drop trigger if exists pedidos_null_missing_vendedor on public.pedidos;
create trigger pedidos_null_missing_vendedor
before insert or update on public.pedidos
for each row execute function public.null_missing_vendedor_id();

drop trigger if exists ordens_servico_null_missing_vendedor on public.ordens_servico;
create trigger ordens_servico_null_missing_vendedor
before insert or update on public.ordens_servico
for each row execute function public.null_missing_vendedor_id();

revoke all on function public.null_missing_vendedor_id()
from public, anon, authenticated;
