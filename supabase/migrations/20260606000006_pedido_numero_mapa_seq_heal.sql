-- 20260606000006_pedido_numero_mapa_seq_heal.sql
-- Auto-heal one-time: alinha pedidos_numero_mapa_seq ao max(numero_mapa) existente.
-- Corrige bancos onde pedidos entraram via sync com numero_mapa EXPLÍCITO e a
-- sequence ficou atrás (→ nextval colidia: duplicate key pedidos_numero_mapa_key,
-- quebrando criação de pedido). Roda no cloud (já corrigido manualmente = no-op) e,
-- principalmente, no Postgres LOCAL do hub quando ele auto-atualizar.
-- NUNCA abaixa a sequence (greatest com o last_value atual). Tabela vazia = no-op.
-- A RECORRÊNCIA é prevenida pela 20260606000005 (sync_push_upsert avança a seq).
do $$
declare m bigint; cur bigint;
begin
  select coalesce(max(numero_mapa), 0) into m from public.pedidos;
  if m > 0 then
    select last_value into cur from public.pedidos_numero_mapa_seq;
    perform setval('public.pedidos_numero_mapa_seq', greatest(m, coalesce(cur, m)), true);
  end if;
end $$;
