import { describe, expect, it } from 'vitest';
import { SYNC_TABLES as CLOUD_TABLES } from '../tables';
import { SYNC_TABLES as HUB_TABLES } from '../../../hub/sync-tables.mjs';

type ComparableTable = {
  name: string;
  dir: string;
  pk: string | readonly string[];
  parent?: { table: string; fk: string };
};

function normalize(tables: readonly ComparableTable[]) {
  return tables
    .map((table) => ({
      name: table.name,
      dir: table.dir,
      pk: Array.isArray(table.pk) ? [...table.pk] : [table.pk],
      parent: table.parent ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

describe('registro de sync', () => {
  it('é idêntico na nuvem e no Hub', () => {
    expect(normalize(CLOUD_TABLES)).toEqual(normalize(HUB_TABLES));
  });
});
