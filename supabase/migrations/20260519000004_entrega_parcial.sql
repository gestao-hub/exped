-- Migration 11: entrega parcial
-- Motorista pode entregar parte do pedido (ex.: faltou produto no caminhão),
-- voltar mais tarde com o restante. Sistema decide status automaticamente.

-- Novo valor no enum (precisa ser commitado antes de ser usado;
-- ENUM ADD VALUE não rola em transação aberta com uso posterior)
alter type pedido_status add value if not exists 'parcialmente_entregue';

-- Quantidade entregue (acumulada — soma a cada nova "Registrar Entrega")
alter table public.pedido_itens
  add column if not exists quantidade_entregue numeric(14,3) not null default 0;

-- Garantia: não pode entregar mais do que foi pedido
do $$ begin
  alter table public.pedido_itens
    add constraint pedido_itens_qtd_entregue_chk
    check (quantidade_entregue >= 0 and quantidade_entregue <= quantidade);
exception when duplicate_object then null; end $$;
