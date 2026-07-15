/**
 * Espelho MÍNIMO do registro de sync da nuvem (`lib/sync/tables.ts`).
 *
 * MANTER SINCRONIZADO MANUALMENTE com lib/sync/tables.ts. Qualquer mudança lá
 * (nova tabela, mudança de pk/dir/parent) deve ser refletida aqui.
 *
 * Direção:
 *  - `two-way`: o hub faz push (local→nuvem) e pull (nuvem→local).
 *  - `down`:    só descem (config/login). O hub NÃO faz push (a nuvem recusa 403).
 *
 * 8 two-way + 4 down (12 no total), igual à nuvem.
 */

/** @typedef {{ name: string, pk: string|string[], dir: 'two-way'|'down', parent?: { table: string, fk: string } }} SyncTable */

/** @type {SyncTable[]} */
export const SYNC_TABLES = [
  // Tabelas de configuração/referência: descem primeiro (sem dependências locais).
  { name: 'empresas', pk: 'id', dir: 'down' },
  { name: 'profiles', pk: 'id', dir: 'down' },
  { name: 'hiper_vendedor_map', pk: ['empresa_id', 'hiper_usuario_id'], dir: 'down' },
  { name: 'dispositivos', pk: 'id', dir: 'down' },
  // Tabelas two-way: dependem de empresas/profiles já presentes.
  { name: 'clientes', pk: 'id', dir: 'two-way' },
  { name: 'pedidos', pk: 'id', dir: 'two-way' },
  { name: 'pedido_pontos_retirada', pk: 'id', dir: 'two-way', parent: { table: 'pedidos', fk: 'pedido_id' } },
  { name: 'pedido_itens', pk: 'id', dir: 'two-way', parent: { table: 'pedido_pontos_retirada', fk: 'ponto_retirada_id' } },
  { name: 'ordens_servico', pk: 'id', dir: 'two-way' },
  { name: 'os_itens', pk: 'id', dir: 'two-way', parent: { table: 'ordens_servico', fk: 'os_id' } },
  { name: 'os_servicos', pk: 'id', dir: 'two-way', parent: { table: 'ordens_servico', fk: 'os_id' } },
  { name: 'os_notificacoes', pk: 'id', dir: 'two-way' },
];

/** Tabelas que o hub envia (local→nuvem). */
export const TWO_WAY_TABLES = SYNC_TABLES.filter((t) => t.dir === 'two-way');

const BY_NAME = new Map(SYNC_TABLES.map((t) => [t.name, t]));

/** @param {string} name */
export function getSyncTable(name) {
  return BY_NAME.get(name);
}

export default SYNC_TABLES;
