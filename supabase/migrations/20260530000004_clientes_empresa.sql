-- 20260530000004_clientes_empresa.sql
alter table public.clientes
  add column if not exists empresa_id uuid references public.empresas(id) on delete restrict;
update public.clientes set empresa_id = '00000000-0000-0000-0000-0000000f0001' where empresa_id is null;
alter table public.clientes alter column empresa_id set not null;
create index if not exists clientes_empresa_idx on public.clientes(empresa_id);

-- cnpj_cpf único POR EMPRESA
alter table public.clientes drop constraint if exists clientes_cnpj_cpf_uniq;
drop index if exists public.clientes_cnpj_cpf_uniq;
create unique index clientes_cnpj_cpf_uniq
  on public.clientes (empresa_id, cnpj_cpf) where cnpj_cpf is not null;

-- cliente_enderecos herda a empresa do cliente
alter table public.cliente_enderecos
  add column if not exists empresa_id uuid references public.empresas(id) on delete restrict;
update public.cliente_enderecos ce
  set empresa_id = c.empresa_id
  from public.clientes c where c.id = ce.cliente_id and ce.empresa_id is null;
alter table public.cliente_enderecos alter column empresa_id set not null;
create index if not exists cliente_enderecos_empresa_idx on public.cliente_enderecos(empresa_id);
