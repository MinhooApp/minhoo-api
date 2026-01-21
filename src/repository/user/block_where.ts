import { Op, Sequelize } from "sequelize";

const normalizeId = (v: any): number | null => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
};

/**
 * Devuelve un filtro NOT EXISTS para bloquear en ambos sentidos.
 * - ownerExpr: campo SQL con alias, ej: "`post`.`userId`" o "`user`.`id`"
 * - Si meId no es válido => {}
 *
 * IMPORTANTE: usa :meId (replacements) para NO romper producción.
 */
export const whereNotBlockedExists = (meId: any, ownerExpr: string) => {
  const me = normalizeId(meId);
  if (!me) return {};

  return {
    [Op.and]: [
      Sequelize.literal(`
        NOT EXISTS (
          SELECT 1
          FROM user_blocks ub
          WHERE
            (ub.blocker_id = :meId AND ub.blocked_id = ${ownerExpr})
            OR
            (ub.blocker_id = ${ownerExpr} AND ub.blocked_id = :meId)
        )
      `),
    ],
  };
};

/**
 * Para endpoints directos por targetId (perfil por id, etc).
 * Si meId no válido => {}
 */
export const whereNotBlockedProfileExists = (meId: any, targetId: any) => {
  const me = normalizeId(meId);
  const t = normalizeId(targetId);
  if (!me || !t) return {};

  return {
    [Op.and]: [
      Sequelize.literal(`
        NOT EXISTS (
          SELECT 1
          FROM user_blocks ub
          WHERE
            (ub.blocker_id = :meId AND ub.blocked_id = :targetId)
            OR
            (ub.blocker_id = :targetId AND ub.blocked_id = :meId)
        )
      `),
    ],
  };
};
