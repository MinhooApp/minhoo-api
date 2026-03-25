import { Op, Sequelize } from "sequelize";

const normalizeId = (v: any): number | null => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
};

const buildOwnerActiveLiteral = (ownerExpr: string) =>
  Sequelize.literal(`
    EXISTS (
      SELECT 1
      FROM users u
      WHERE u.id = ${ownerExpr}
        AND u.disabled = 0
        AND u.is_deleted = 0
    )
  `);

/**
 * Devuelve un filtro NOT EXISTS para bloquear en ambos sentidos.
 * - ownerExpr: campo SQL con alias, ej: "`post`.`userId`" o "`user`.`id`"
 * - Siempre exige que el owner esté visible (disabled=0, is_deleted=0)
 * - Si meId no es válido, aplica solo el filtro de owner activo
 *
 * IMPORTANTE: usa :meId (replacements) para NO romper producción.
 */
export const whereNotBlockedExists = (meId: any, ownerExpr: string) => {
  const me = normalizeId(meId);
  const andClauses: any[] = [buildOwnerActiveLiteral(ownerExpr)];

  if (!me) {
    return {
      [Op.and]: andClauses,
    };
  }

  andClauses.push(
    Sequelize.literal(`
        NOT EXISTS (
          SELECT 1
          FROM user_blocks ub
          WHERE
            (ub.blocker_id = :meId AND ub.blocked_id = ${ownerExpr})
            OR
            (ub.blocker_id = ${ownerExpr} AND ub.blocked_id = :meId)
        )
      `)
  );

  return {
    [Op.and]: andClauses,
  };
};

/**
 * Para endpoints directos por targetId (perfil por id, etc).
 * - Siempre exige que el target esté visible (disabled=0, is_deleted=0)
 * - Si meId no válido, aplica solo el filtro de target activo
 */
export const whereNotBlockedProfileExists = (meId: any, targetId: any) => {
  const me = normalizeId(meId);
  const t = normalizeId(targetId);
  if (!t) return {};

  const andClauses: any[] = [
    Sequelize.literal(`
      EXISTS (
        SELECT 1
        FROM users u
        WHERE u.id = ${t}
          AND u.disabled = 0
          AND u.is_deleted = 0
      )
    `),
  ];

  if (!me) {
    return {
      [Op.and]: andClauses,
    };
  }

  andClauses.push(
    Sequelize.literal(`
        NOT EXISTS (
          SELECT 1
          FROM user_blocks ub
          WHERE
            (ub.blocker_id = :meId AND ub.blocked_id = :targetId)
            OR
            (ub.blocker_id = :targetId AND ub.blocked_id = :meId)
        )
      `)
  );

  return {
    [Op.and]: andClauses,
  };
};
