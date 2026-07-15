export const IDENTITY_REFERENCES = Object.freeze([
  Object.freeze({ table: 'pedidos', column: 'vendedor_id', propagate: true }),
  Object.freeze({ table: 'ordens_servico', column: 'vendedor_id', propagate: true }),
  Object.freeze({ table: 'hiper_vendedor_map', column: 'vendedor_id', propagate: false }),
  Object.freeze({ table: 'pedido_comentarios', column: 'autor_id', propagate: false }),
  Object.freeze({ table: 'pedido_eventos', column: 'usuario_id', propagate: false }),
  Object.freeze({ table: 'pedido_logistica', column: 'updated_by', propagate: false }),
]);

export function normalizeIdentityEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

export function identityAliasEmail(oldUserId) {
  return `exped-alias+${String(oldUserId).toLowerCase()}@invalid.local`;
}

export async function applyAuthUserWithIdentity(db, row) {
  const normalizedEmail = normalizeIdentityEmail(row.email);
  if (!normalizedEmail) return db.upsertAuthUserById(row);

  const existing = await db.findAuthUserByNormalizedEmail(normalizedEmail);
  if (!existing || String(existing.id) === String(row.id)) {
    return db.upsertAuthUserById(row);
  }

  return db.aliasAndUpsertAuthUser({
    oldUserId: String(existing.id),
    canonicalUser: row,
    normalizedEmail,
    aliasEmail: identityAliasEmail(existing.id),
  });
}

export async function reconcilePendingIdentityAliases(db) {
  const aliases = await db.listPendingIdentityAliases();
  let resolved = 0;
  let pending = 0;

  for (const alias of aliases) {
    if (
      !alias.canonical_profile_applied_at ||
      !(await db.profileExists(alias.canonical_user_id))
    ) {
      pending += 1;
      continue;
    }

    try {
      await db.repointIdentityAlias(alias);
      resolved += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : 'falha local';
      await db.markIdentityAliasError(alias.old_user_id, message).catch(() => undefined);
      throw new Error('Falha ao reconciliar identidade local', { cause: error });
    }
  }

  return { resolved, pending };
}
