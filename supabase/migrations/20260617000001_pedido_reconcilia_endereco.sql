-- 20260617000001_pedido_reconcilia_endereco.sql
-- Reconciliação de cliente_endereco_id no pedido (espelha o tratamento de cliente_id).
--
-- Motivo: `cliente_enderecos` NÃO está no registro de sync (lib/sync/tables.ts /
-- hub/sync-tables.mjs), mas pedidos.cliente_endereco_id tem FK -> cliente_enderecos.
-- Endereços salvos nascem no hub com ids locais que não sobem; ao empurrar um pedido
-- com cliente_endereco_id preenchido, o upsert na nuvem violava a FK (Postgres 23503)
-- e derrubava o LOTE INTEIRO do push (SYNC_LIMIT=500), travando o cursor de pedidos.
--
-- Tratamento (igual ao já existente para cliente_id em pedido_reconcilia_cliente): se o
-- endereço referenciado não existe, solta o vínculo (o endereço continua denormalizado
-- em texto no próprio pedido). Mantém integridade (sem referência solta) e não bloqueia
-- o sync. Camada de segurança que continua valendo mesmo depois de cliente_enderecos
-- virar tabela de sync (cobre corrida de ordem / endereço apagado).
--
-- Aplicado direto em prod (nuvem louaguxcohfeicxxqggw) em 2026-06-17 via Management API
-- (dry-run BEGIN/ROLLBACK + apply). Este arquivo alinha o source-of-truth.

CREATE OR REPLACE FUNCTION public.pedido_reconcilia_cliente()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.cliente_id is not null
     and not exists (select 1 from public.clientes where id = new.cliente_id) then
    if nullif(new.cliente_cnpj_cpf,'') is not null then
      -- casa por DÍGITOS (tolera formato: "026.984.799-57" vs "02698479957")
      select id into new.cliente_id
      from public.clientes
      where empresa_id = new.empresa_id
        and regexp_replace(coalesce(cnpj_cpf,''), '\D', '', 'g')
            = regexp_replace(new.cliente_cnpj_cpf, '\D', '', 'g')
      limit 1;
    else
      new.cliente_id := null;
    end if;
    -- ainda inexistente (CNPJ não casou) → solta o vínculo (dados ficam no pedido)
    if new.cliente_id is not null
       and not exists (select 1 from public.clientes where id = new.cliente_id) then
      new.cliente_id := null;
    end if;
  end if;

  -- Reconcilia cliente_endereco_id: endereço criado no hub e ainda não sincronizado
  -- → solta o vínculo (endereço fica denormalizado no próprio pedido).
  if new.cliente_endereco_id is not null
     and not exists (select 1 from public.cliente_enderecos where id = new.cliente_endereco_id) then
    new.cliente_endereco_id := null;
  end if;

  return new;
end $function$;
