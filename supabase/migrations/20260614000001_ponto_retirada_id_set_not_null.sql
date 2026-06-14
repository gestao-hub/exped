-- 20260614000001_ponto_retirada_id_set_not_null.sql
-- Converge pedido_itens.ponto_retirada_id para NOT NULL (idempotente / auto-curativa).
--
-- Por quê: uma versão INTERMEDIÁRIA da branch (20260612000002, antes do fix) chegou a
-- rodar `ALTER COLUMN ponto_retirada_id DROP NOT NULL`. Ambientes (hub/dev/teste) que
-- aplicaram aquela versão ficaram com a coluna NULLABLE — e `db push` não re-roda uma
-- migration já aplicada nem restaura a constraint sozinho. A versão corrigida da 002 só
-- MANTÉM o NOT NULL em aplicações novas (a base já cria a coluna NOT NULL em
-- 20260518000003), mas NÃO cura quem já ficou nullable. Esta migration nova roda nesses
-- ambientes e restaura a invariante; em ambiente que nunca afrouxou, é no-op.
--
-- O sync DEPENDE dessa invariante: item com FK nula some no pull (INNER JOIN no ponto) e
-- trava o push. O design ancora TODO item a um ponto-container (inclusive 'imediato'),
-- então não deve existir item com FK nula — a guarda abaixo falha EM VOZ ALTA se existir,
-- em vez de mascarar dados órfãos (red flag do protocolo de migrations).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.pedido_itens WHERE ponto_retirada_id IS NULL) THEN
    RAISE EXCEPTION 'Abortado: há pedido_itens com ponto_retirada_id NULL — realocar a um ponto-container antes de aplicar NOT NULL';
  END IF;
END $$;

ALTER TABLE public.pedido_itens ALTER COLUMN ponto_retirada_id SET NOT NULL;
