import { describe, expect, it, vi } from 'vitest';

import {
  IDENTITY_REFERENCES,
  applyAuthUserWithIdentity,
  normalizeIdentityEmail,
  reconcilePendingIdentityAliases,
} from '../identity-reconciliation.mjs';

describe('identidade local', () => {
  it('normaliza com trim + lower', () => {
    expect(normalizeIdentityEmail('  Eduardo@Franzoni.Local ')).toBe('eduardo@franzoni.local');
  });

  it('registra alias quando e-mail igual chega com UUID diferente', async () => {
    const db = {
      findAuthUserByNormalizedEmail: vi.fn(async () => ({ id: 'old-id' })),
      upsertAuthUserById: vi.fn(),
      aliasAndUpsertAuthUser: vi.fn(async () => undefined),
    };
    const row = { id: 'cloud-id', email: ' Eduardo@Franzoni.Local ' };

    await applyAuthUserWithIdentity(db, row);

    expect(db.aliasAndUpsertAuthUser).toHaveBeenCalledWith({
      oldUserId: 'old-id',
      canonicalUser: row,
      normalizedEmail: 'eduardo@franzoni.local',
      aliasEmail: 'exped-alias+old-id@invalid.local',
    });
    expect(db.upsertAuthUserById).not.toHaveBeenCalled();
  });

  it('não une IDs quando os e-mails são diferentes', async () => {
    const db = {
      findAuthUserByNormalizedEmail: vi.fn(async () => null),
      upsertAuthUserById: vi.fn(async () => undefined),
      aliasAndUpsertAuthUser: vi.fn(),
    };
    const row = { id: 'cloud-id', email: 'outro@franzoni.local' };

    await applyAuthUserWithIdentity(db, row);

    expect(db.upsertAuthUserById).toHaveBeenCalledWith(row);
    expect(db.aliasAndUpsertAuthUser).not.toHaveBeenCalled();
  });

  it('atualiza normalmente quando o e-mail já pertence ao UUID canônico', async () => {
    const db = {
      findAuthUserByNormalizedEmail: vi.fn(async () => ({ id: 'cloud-id' })),
      upsertAuthUserById: vi.fn(async () => undefined),
      aliasAndUpsertAuthUser: vi.fn(),
    };
    const row = { id: 'cloud-id', email: 'eduardo@franzoni.local' };

    await applyAuthUserWithIdentity(db, row);

    expect(db.upsertAuthUserById).toHaveBeenCalledWith(row);
    expect(db.aliasAndUpsertAuthUser).not.toHaveBeenCalled();
  });

  it('não resolve alias com profile placeholder sem marcador do pull', async () => {
    const db = {
      listPendingIdentityAliases: vi.fn(async () => [
        {
          old_user_id: 'old-id',
          canonical_user_id: 'cloud-id',
          canonical_profile_applied_at: null,
        },
      ]),
      profileExists: vi.fn(async () => true),
      repointIdentityAlias: vi.fn(),
      markIdentityAliasError: vi.fn(),
    };

    await expect(reconcilePendingIdentityAliases(db)).resolves.toEqual({ resolved: 0, pending: 1 });
    expect(db.profileExists).not.toHaveBeenCalled();
    expect(db.repointIdentityAlias).not.toHaveBeenCalled();
  });

  it('mantém alias pendente quando o profile marcado não existe mais', async () => {
    const db = {
      listPendingIdentityAliases: vi.fn(async () => [
        {
          old_user_id: 'old-id',
          canonical_user_id: 'cloud-id',
          canonical_profile_applied_at: '2026-07-14T10:00:00Z',
        },
      ]),
      profileExists: vi.fn(async () => false),
      repointIdentityAlias: vi.fn(),
      markIdentityAliasError: vi.fn(),
    };

    await expect(reconcilePendingIdentityAliases(db)).resolves.toEqual({ resolved: 0, pending: 1 });
    expect(db.repointIdentityAlias).not.toHaveBeenCalled();
  });

  it('resolve alias marcado quando o profile canônico existe', async () => {
    const alias = {
      old_user_id: 'old-id',
      canonical_user_id: 'cloud-id',
      canonical_profile_applied_at: '2026-07-14T10:00:00Z',
    };
    const db = {
      listPendingIdentityAliases: vi.fn(async () => [alias]),
      profileExists: vi.fn(async () => true),
      repointIdentityAlias: vi.fn(async () => undefined),
      markIdentityAliasError: vi.fn(),
    };

    await expect(reconcilePendingIdentityAliases(db)).resolves.toEqual({ resolved: 1, pending: 0 });
    expect(db.repointIdentityAlias).toHaveBeenCalledWith(alias);
  });

  it('registra erro transacional e mantém o alias pendente', async () => {
    const alias = {
      old_user_id: 'old-id',
      canonical_user_id: 'cloud-id',
      canonical_profile_applied_at: '2026-07-14T10:00:00Z',
    };
    const db = {
      listPendingIdentityAliases: vi.fn(async () => [alias]),
      profileExists: vi.fn(async () => true),
      repointIdentityAlias: vi.fn(async () => {
        throw new Error('FK simulada');
      }),
      markIdentityAliasError: vi.fn(async () => undefined),
    };

    await expect(reconcilePendingIdentityAliases(db)).rejects.toThrow(
      'Falha ao reconciliar identidade local',
    );
    expect(db.markIdentityAliasError).toHaveBeenCalledWith('old-id', 'FK simulada');
  });

  it('mantém exatamente as seis referências aprovadas', () => {
    expect(IDENTITY_REFERENCES).toEqual([
      { table: 'pedidos', column: 'vendedor_id', propagate: true },
      { table: 'ordens_servico', column: 'vendedor_id', propagate: true },
      { table: 'hiper_vendedor_map', column: 'vendedor_id', propagate: false },
      { table: 'pedido_comentarios', column: 'autor_id', propagate: false },
      { table: 'pedido_eventos', column: 'usuario_id', propagate: false },
      { table: 'pedido_logistica', column: 'updated_by', propagate: false },
    ]);
    expect(Object.isFrozen(IDENTITY_REFERENCES)).toBe(true);
    expect(IDENTITY_REFERENCES.every(Object.isFrozen)).toBe(true);
  });
});
