import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

function routine(text, name) {
  const start = text.search(new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\b`, 'mi'));
  if (start < 0) return '';
  const rest = text.slice(start);
  const next = rest.slice(1).search(/^\s*(?:export\s+)?(?:async\s+)?function\s+[\w-]+\b/mi);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

describe('compatibilidade do Supabase Storage local', () => {
  const bootstrap = source('../bootstrap.mjs');
  const prelude = source('../../scripts/local-stack/00-prelude-helpers.sql');
  const materializedCopy = source(
    '../../supabase/migrations/20260716131854_hub_release_materialized_copy_attestation.sql',
  );

  it('reaplica o prelude local antes de toda migration pendente', () => {
    const applyPending = routine(bootstrap, 'applyPendingMigrations');
    const preludeRun = applyPending.indexOf("'00-prelude-helpers.sql'");
    const migrationLoop = applyPending.indexOf('for (const m of listMigrations');

    expect(preludeRun).toBeGreaterThanOrEqual(0);
    expect(migrationLoop).toBeGreaterThan(preludeRun);
    expect(applyPending.slice(preludeRun, migrationLoop)).toContain('psqlFile');
  });

  it('mantém o shim local compatível com as policies do Storage gerenciado', () => {
    expect(prelude).toMatch(/alter table storage\.objects[\s\S]*add column if not exists user_metadata jsonb/i);
    expect(prelude).toMatch(/alter table storage\.objects[\s\S]*add column if not exists owner_id text/i);
    expect(prelude).toMatch(/alter table storage\.objects[\s\S]*add column if not exists version text/i);
    expect(prelude).toMatch(/create or replace function storage\.operation\(\)/i);
    expect(prelude).toMatch(/current_setting\('storage\.operation', true\)/i);
    expect(prelude).toMatch(/create or replace function storage\.allow_only_operation\(expected_operation text\)/i);
    expect(prelude).toMatch(/raw_operation like 'storage\.%'/i);
    expect(prelude).toMatch(/coalesce\(current_operation = requested_operation, false\)/i);
  });

  it('retoma com segurança uma tentativa parcial da migration de atestação', () => {
    expect(materializedCopy).toMatch(
      /alter table storage\.objects[\s\S]*add column if not exists owner_id text/i,
    );
    expect(materializedCopy).toMatch(
      /alter table storage\.objects[\s\S]*add column if not exists version text/i,
    );
    expect(materializedCopy).toMatch(/create table if not exists private\.hub_release_copy_proofs/i);
  });
});
