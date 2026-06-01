/**
 * Registro central das tabelas de sync (fonte única usada pela API de sync e,
 * espelhada, pelo hub local).
 *
 * Direção:
 *  - `two-way`: merge campo-a-campo (push do hub + pull pra hub).
 *  - `down`: só descem (config/login). Read-only pro hub — push é recusado (403).
 *
 * Escopo por empresa:
 *  - Tabelas com `empresa_id` direto: `clientes`, `pedidos`, `ordens_servico`,
 *    `os_notificacoes`.
 *  - Tabelas-filhas (sem `empresa_id`): escopadas via o ancestral que tem
 *    `empresa_id`, seguindo a cadeia `parent` até chegar nele (subquery pelo pai).
 *    Ex.: `pedido_itens` → `pedido_pontos_retirada` → `pedidos.empresa_id`.
 *
 * Obs.: `auth.users` (login offline) é tratado à parte (não entra neste registro):
 * o pull retorna `auth_users` escopado por empresa via `profiles` (ver engine.runPull
 * + SyncDb.selectAuthUsers); o cliente aplica num upsert em auth.users LOCAL com cursor
 * próprio (`AUTH_USERS_KEY`). É read-only no hub (nunca sobe).
 */

export type SyncDir = 'two-way' | 'down';

export type SyncTable = {
  name: string;
  pk: string;
  dir: SyncDir;
  /** Quando a tabela NÃO tem `empresa_id` direto, aponta o pai pra escopo via JOIN/subquery. */
  parent?: { table: string; fk: string };
};

export const SYNC_TABLES: SyncTable[] = [
  { name: 'clientes', pk: 'id', dir: 'two-way' },
  { name: 'pedidos', pk: 'id', dir: 'two-way' },
  { name: 'pedido_pontos_retirada', pk: 'id', dir: 'two-way', parent: { table: 'pedidos', fk: 'pedido_id' } },
  { name: 'pedido_itens', pk: 'id', dir: 'two-way', parent: { table: 'pedido_pontos_retirada', fk: 'ponto_retirada_id' } },
  { name: 'ordens_servico', pk: 'id', dir: 'two-way' },
  { name: 'os_itens', pk: 'id', dir: 'two-way', parent: { table: 'ordens_servico', fk: 'os_id' } },
  { name: 'os_servicos', pk: 'id', dir: 'two-way', parent: { table: 'ordens_servico', fk: 'os_id' } },
  { name: 'os_notificacoes', pk: 'id', dir: 'two-way' },
  { name: 'empresas', pk: 'id', dir: 'down' },
  { name: 'profiles', pk: 'id', dir: 'down' },
  { name: 'hiper_vendedor_map', pk: 'id', dir: 'down' },
  { name: 'dispositivos', pk: 'id', dir: 'down' },
];

const BY_NAME = new Map(SYNC_TABLES.map((t) => [t.name, t]));

export function getSyncTable(name: string): SyncTable | undefined {
  return BY_NAME.get(name);
}

/** Tabelas que têm `empresa_id` diretamente (escopo direto). */
const HAS_DIRECT_EMPRESA_ID = new Set([
  'clientes',
  'pedidos',
  'ordens_servico',
  'os_notificacoes',
  'empresas',
  'profiles',
  'hiper_vendedor_map',
  'dispositivos',
]);

export function hasDirectEmpresaId(name: string): boolean {
  return HAS_DIRECT_EMPRESA_ID.has(name);
}
