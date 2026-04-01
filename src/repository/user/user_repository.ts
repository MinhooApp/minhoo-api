import User from "../../_models/user/user";
import UserBLock from "../../_models/block/block";
import Post from "../../_models/post/post";
import { userIncludes } from "./user_include";
import MediaPost from "../../_models/post/media_post";
import Worker from "../../_models/worker/worker";
import Follower from "../../_models/follower/follower";
import Category from "../../_models/category/category";
import UserReport from "../../_models/user/user_report";
import { Op, QueryTypes, Sequelize, UniqueConstraintError } from "sequelize";
import sequelize from "../../_db/connection";

const excludeKeys = ["createdAt", "updatedAt", "password"];
const MIN_PUSH_TOKEN_LENGTH = Math.max(
  20,
  Number(process.env.PUSH_MIN_TOKEN_LENGTH ?? 100) || 100
);
const MAX_PUSH_TOKENS_PER_USER = Math.max(
  1,
  Number(process.env.PUSH_MAX_TOKENS_PER_USER ?? 10) || 10
);
const IMPERSONATION_REPORT_REASON = "impersonation_or_identity_fraud";
const IMPERSONATION_REPORT_DISABLE_THRESHOLD = Math.max(
  20,
  Number(process.env.IMPERSONATION_REPORT_DISABLE_THRESHOLD ?? 20) || 20
);
const PROFILE_REPORT_DISABLE_THRESHOLD = Math.max(
  20,
  Number(process.env.PROFILE_REPORT_DISABLE_THRESHOLD ?? 20) || 20
);

const isTrueLike = (value: any) => value === true || value === 1 || value === "1";

const isMissingTableError = (error: any) => {
  const code = String(error?.original?.code ?? error?.code ?? "").toUpperCase();
  const message = String(error?.original?.sqlMessage ?? error?.message ?? "").toLowerCase();
  return code === "ER_NO_SUCH_TABLE" || message.includes("doesn't exist");
};

const toDistinctReporterIds = (rows: any[]) => {
  const ids = new Set<number>();
  (rows || []).forEach((row: any) => {
    const reporterId = Number(row?.reporterId);
    if (Number.isFinite(reporterId) && reporterId > 0) ids.add(reporterId);
  });
  return ids;
};

/**
 * ✅ Helper seguro: bloqueo bidireccional A<->B
 * - Usa replacements para NO romper SQL
 * - No depende de alias raros
 */
const notBlockedBetweenMeAndTarget = () =>
  Sequelize.literal(`
    NOT EXISTS (
      SELECT 1
      FROM user_blocks ub
      WHERE
        (ub.blocker_id = :meId AND ub.blocked_id = :id)
        OR
        (ub.blocker_id = :id AND ub.blocked_id = :meId)
    )
  `);

/* 🔹 Lista de todos los usuarios activos (no deshabilitados por la empresa) */
export const gets = async () => {
  const user = await User.findAll({
    where: { available: true, disabled: false, is_deleted: false },
    include: userIncludes(-1, { includeFollowGraph: false }),
  });
  return user;
};

export const search_profiles = async (
  query: any = "",
  meId: any = -1,
  page: any = 0,
  size: any = 20
) => {
  const pageNumber = Number.isFinite(Number(page)) && Number(page) >= 0 ? Math.floor(Number(page)) : 0;
  const sizeNumber = Number.isFinite(Number(size)) ? Math.floor(Number(size)) : 20;
  const limit = Math.min(Math.max(sizeNumber, 1), 100);
  const offset = pageNumber * limit;
  const search = String(query ?? "").trim();
  const where: any = {
    available: true,
    disabled: false,
    is_deleted: false,
  };
  const and: any[] = [];
  const order: any[] = [];

  if (search.length) {
    const tokens = search.split(/\s+/).filter(Boolean).slice(0, 5);
    const tokenClauses = tokens.map((token) => {
      const like = `%${token}%`;
      return {
        [Op.or]: [
          { name: { [Op.like]: like } },
          { last_name: { [Op.like]: like } },
          { username: { [Op.like]: like } },
        ],
      };
    });

    // UX rule:
    // - 1 token: match in any field (OR)
    // - 2+ tokens: each token must appear in any field (AND across tokens)
    if (tokenClauses.length === 1) {
      and.push(tokenClauses[0]);
    } else if (tokenClauses.length > 1) {
      and.push(...tokenClauses);
    }

    // Relevance ranking for search:
    // exact username > username prefix > username contains > name/last_name contains
    const queryLower = search.toLowerCase();
    const exact = sequelize.escape(queryLower);
    const prefix = sequelize.escape(`${queryLower}%`);
    const contains = sequelize.escape(`%${queryLower}%`);
    order.push([
      Sequelize.literal(`
        CASE
          WHEN \`user\`.\`username\` IS NOT NULL AND LOWER(\`user\`.\`username\`) = ${exact} THEN 0
          WHEN \`user\`.\`username\` IS NOT NULL AND LOWER(\`user\`.\`username\`) LIKE ${prefix} THEN 1
          WHEN \`user\`.\`username\` IS NOT NULL AND LOWER(\`user\`.\`username\`) LIKE ${contains} THEN 2
          WHEN \`user\`.\`name\` IS NOT NULL AND LOWER(\`user\`.\`name\`) LIKE ${contains} THEN 3
          WHEN \`user\`.\`last_name\` IS NOT NULL AND LOWER(\`user\`.\`last_name\`) LIKE ${contains} THEN 4
          ELSE 5
        END
      `),
      "ASC",
    ]);
  }

  const viewerId = Number(meId);
  if (Number.isFinite(viewerId) && viewerId > 0) {
    const blocks = await UserBLock.findAll({
      where: {
        [Op.or]: [{ blocker_id: viewerId }, { blocked_id: viewerId }],
      },
      attributes: ["blocker_id", "blocked_id"],
      raw: true,
    });

    const blockedUserIds = new Set<number>();
    blocks.forEach((row: any) => {
      const blockerId = Number(row.blocker_id);
      const blockedId = Number(row.blocked_id);
      if (blockerId === viewerId && Number.isFinite(blockedId)) {
        blockedUserIds.add(blockedId);
      }
      if (blockedId === viewerId && Number.isFinite(blockerId)) {
        blockedUserIds.add(blockerId);
      }
    });

    if (blockedUserIds.size > 0) {
      and.push({ id: { [Op.notIn]: Array.from(blockedUserIds) } });
    }
  }

  if (and.length > 0) {
    where[Op.and] = and;
  }

  if (!search.length) {
    // Empty query => show a random discovery list.
    order.push([Sequelize.literal("RAND()"), "ASC"]);
  } else {
    order.push(
      [Sequelize.literal("CASE WHEN `user`.`username` IS NULL OR `user`.`username` = '' THEN 1 ELSE 0 END"), "ASC"],
      ["username", "ASC"],
      ["name", "ASC"],
      ["last_name", "ASC"],
      ["id", "DESC"]
    );
  }

  return User.findAndCountAll({
    where,
    attributes: [
      "id",
      "name",
      "last_name",
      "username",
      "image_profil",
      "verified",
      "rate",
      "job_category_ids",
      "job_categories_labels",
    ],
    include: [
      {
        model: Worker,
        as: "worker",
        where: { available: true },
        required: false,
        attributes: ["id"],
        include: [
          {
            model: Category,
            as: "categories",
            attributes: ["id", "name", "es_name"],
            through: { attributes: [] },
            required: false,
          },
        ],
      },
    ],
    limit,
    offset,
    distinct: true,
    order,
  }).then((result: any) => {
    const rows = (result.rows ?? []).map((row: any) => {
      const plain = typeof row?.toJSON === "function" ? row.toJSON() : row;
      const username =
        plain?.username === null || plain?.username === undefined
          ? null
          : String(plain.username).trim() || null;

      const userCategoryIds = Array.isArray(plain?.job_category_ids)
        ? plain.job_category_ids
        : [];
      const userCategoryLabels = Array.isArray(plain?.job_categories_labels)
        ? plain.job_categories_labels
        : [];

      const workerCategories = Array.isArray(plain?.worker?.categories)
        ? plain.worker.categories
        : [];
      const workerCategoryIds = workerCategories
        .map((cat: any) => Number(cat?.id))
        .filter((id: number) => Number.isFinite(id));
      const workerCategoryLabels = workerCategories
        .map((cat: any) => String(cat?.name ?? cat?.es_name ?? "").trim())
        .filter((name: string) => !!name);

      const category_ids =
        userCategoryIds.length > 0
          ? userCategoryIds
          : Array.from(new Set(workerCategoryIds));
      const categories_labels =
        userCategoryLabels.length > 0
          ? userCategoryLabels
          : Array.from(new Set(workerCategoryLabels));

      return {
        ...plain,
        username,
        user_name: username,
        username_handle: username ? `@${username}` : null,
        category_ids,
        categories: categories_labels,
        categories_labels,
      };
    });

    return {
      count: result.count,
      rows,
    };
  });
};

/* 🔹 Paginación de usuarios visibles */
export const users = async (page: any = 0, size: any = 10) => {
  const option = { limit: +size, offset: +page * +size };
  const users = await User.findAndCountAll({
    where: { available: 1, disabled: false, is_deleted: false },
    ...option,
    include: userIncludes(-1, { includeFollowGraph: false }),
  });
  return users;
};

/* 🔹 Perfil de usuario (solo si no está deshabilitado globalmente)
   ✅ NO rompemos posts (quitamos el filtro user_id/userId)
*/
export const get = async (id: any, meId: any = -1) => {
  const user = await User.findOne({
    where: {
      id,
      disabled: false,
      is_deleted: false,
      [Op.and]: [notBlockedBetweenMeAndTarget()],
    },
    include: [
      ...userIncludes(meId, { includeFollowGraph: false }),
      {
        model: Post,
        as: "posts",
        where: { is_delete: false },
        required: false,
        separate: true,
        order: [["created_date", "DESC"]],
        include: [
          {
            model: MediaPost,
            as: "post_media",
            attributes: ["url", "is_img"],
            separate: true,
            order: [["createdAt", "ASC"]],
          },
        ],
      },
    ],
    replacements: { meId, id },
  });

  return user;
};

/* 🔹 Actualiza datos de usuario */
export const update = async (id: any, body: any) => {
  const userTemp = await User.findOne({
    where: { id },
    include: userIncludes(-1, { includeFollowGraph: false }),
  });
  const user = await userTemp?.update(body);
  return [user];
};

/* 🔹 Limpia uuid push token solo si coincide (evita borrar token nuevo por carrera) */
export const clearUuidIfMatch = async (id: number, uuid: string) => {
  const userId = Number(id);
  const token = String(uuid ?? "").trim();
  if (!Number.isFinite(userId) || userId <= 0 || !token) return 0;
  const [affected] = await User.update(
    { uuid: null },
    {
      where: {
        id: userId,
        uuid: token,
      },
    }
  );
  return affected;
};

/* 🔹 Guarda/actualiza uuid push token para usuario autenticado */
export const assignUuid = async (id: number, uuid: string) => {
  const userId = Number(id);
  const token = String(uuid ?? "").trim();
  if (!Number.isFinite(userId) || userId <= 0 || token.length < 20) return 0;

  // Un token de dispositivo solo debe pertenecer a una cuenta activa.
  await User.update(
    { uuid: null },
    {
      where: {
        uuid: token,
        id: { [Op.ne]: userId },
      },
    }
  );

  const [affected] = await User.update(
    { uuid: token },
    {
      where: { id: userId },
    }
  );

  return affected;
};

/* 🔹 Activa/desactiva alertas personales */
export const activeAlerts = async (id: any) => {
  const userTemp = await User.findOne({
    where: { id },
    include: userIncludes(-1, { includeFollowGraph: false }),
  });
  const user = await userTemp?.update({ alert: !userTemp!.alert });
  return user;
};

/* 🔹 Elimina lógicamente usuarios disponibles (placeholder) */
export const deleteuser = async () => {
  const user = await User.update({}, { where: { available: 1 } });
  return user;
};

/* 🔹 Usuarios que sigue (seguimientos) */
export const follows = async (id: any, meId: any = -1) => {
  const follows = await Follower.findAll({
    attributes: ["id", "userId", "followerId"],
    where: {
      followerId: id,
      [Op.and]: [
        Sequelize.literal(`
          NOT EXISTS (
            SELECT 1
            FROM user_blocks ub
            WHERE
              (ub.blocker_id = :meId AND ub.blocked_id = \`follower\`.\`userId\`)
              OR
              (ub.blocker_id = \`follower\`.\`userId\` AND ub.blocked_id = :meId)
          )
        `),
      ],
    },
    include: [
      {
        model: User,
        as: "following_data",
        attributes: [
          "id",
          "name",
          "last_name",
          "image_profil",
          "verified",
          "rate",
          "username",
        ],
        where: { disabled: false },
        include: [
          {
            model: Worker,
            as: "worker",
            where: { available: true },
            required: false,
            attributes: ["id", "rate"],
            include: [
              {
                model: Category,
                as: "categories",
                attributes: ["id", "name", "es_name"],
                through: { attributes: [] },
              },
              {
                model: User,
                as: "personal_data",
                attributes: ["id", "name", "last_name", "image_profil", "verified", "rate"],
              },
            ],
          },
          { model: Follower, as: "followers", attributes: ["followerId"], required: false },
          { model: Follower, as: "followings", attributes: ["userId"], required: false },
        ],
      },
    ],
    order: [["id", "DESC"]],
    replacements: { meId },
  });

  return follows;
};

/* 🔹 Seguidores */
export const followers = async (id: any, meId: any = -1) => {
  const followers = await Follower.findAll({
    attributes: ["id", "userId", "followerId"],
    where: {
      userId: id,
      [Op.and]: [
        Sequelize.literal(`
          NOT EXISTS (
            SELECT 1
            FROM user_blocks ub
            WHERE
              (ub.blocker_id = :meId AND ub.blocked_id = \`follower\`.\`followerId\`)
              OR
              (ub.blocker_id = \`follower\`.\`followerId\` AND ub.blocked_id = :meId)
          )
        `),
      ],
    },
    include: [
      {
        model: User,
        as: "follower_data",
        attributes: [
          "id",
          "name",
          "last_name",
          "image_profil",
          "verified",
          "rate",
          "username",
        ],
        where: { disabled: false },
        include: [
          {
            model: Worker,
            as: "worker",
            where: { available: true },
            required: false,
            attributes: ["id", "rate"],
            include: [
              {
                model: Category,
                as: "categories",
                attributes: ["id", "name", "es_name"],
                through: { attributes: [] },
              },
              {
                model: User,
                as: "personal_data",
                attributes: ["id", "name", "last_name", "image_profil", "verified", "rate"],
              },
            ],
          },
          { model: Follower, as: "followers", attributes: ["followerId"], required: false },
          { model: Follower, as: "followings", attributes: ["userId"], required: false },
        ],
      },
    ],
    order: [["id", "DESC"]],
    replacements: { meId },
  });

  return followers;
};

type PushSettings = {
  uuid: string;
  uuids: string[];
  language: string | null;
  language_codes: string[];
  language_names: string[];
};

export type UserLocaleSettings = {
  language: string | null;
  language_codes: string[];
  language_names: string[];
};

const toStringArray = (value: any): string[] => {
  if (!Array.isArray(value)) return [];
  return value.map((item: any) => String(item ?? "").trim()).filter(Boolean);
};

const normalizeDistinctPushTokens = (tokens: any[]): string[] => {
  const normalized = (tokens ?? [])
    .map((token) => String(token ?? "").trim())
    .filter((token) => token.length >= MIN_PUSH_TOKEN_LENGTH);

  return Array.from(new Set(normalized)).slice(0, MAX_PUSH_TOKENS_PER_USER);
};

const getPushTokensFromActiveAuthSessions = async (id: number): Promise<string[]> => {
  const userId = Number(id);
  if (!Number.isFinite(userId) || userId <= 0) return [];

  try {
    const rows = (await sequelize.query(
      `
        SELECT device_uuid AS uuid
        FROM user_auth_sessions
        WHERE user_id = :userId
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > NOW())
          AND device_uuid IS NOT NULL
          AND device_uuid <> ''
        ORDER BY id DESC
        LIMIT :limit
      `,
      {
        replacements: {
          userId,
          limit: Math.max(MAX_PUSH_TOKENS_PER_USER * 4, MAX_PUSH_TOKENS_PER_USER),
        },
        type: QueryTypes.SELECT,
      }
    )) as Array<{ uuid?: string | null }>;

    return normalizeDistinctPushTokens((rows ?? []).map((row: any) => row?.uuid));
  } catch (error: any) {
    if (!isMissingTableError(error)) {
      console.log("[push] getPushTokensFromActiveAuthSessions error", error);
    }
    return [];
  }
};

export const getPushSettings = async (id: number): Promise<PushSettings> => {
  const user = await User.findOne({
    where: {
      id,
      available: true,
      disabled: false,
      is_deleted: false,
    },
    attributes: ["uuid", "alert", "language", "language_codes", "language_names"],
    raw: true,
  });

  const alertsEnabled = Boolean((user as any)?.alert);
  const legacyUuidRaw = String((user as any)?.uuid ?? "").trim();
  const legacyUuid = alertsEnabled ? legacyUuidRaw : "";
  const sessionUuids = alertsEnabled ? await getPushTokensFromActiveAuthSessions(id) : [];
  const uuids = normalizeDistinctPushTokens([legacyUuid, ...sessionUuids]);

  return {
    uuid: legacyUuid,
    uuids,
    language: ((user as any)?.language ?? null) as string | null,
    language_codes: toStringArray((user as any)?.language_codes),
    language_names: toStringArray((user as any)?.language_names),
  };
};

export const getUserLocaleSettings = async (id: number): Promise<UserLocaleSettings> => {
  const userId = Number(id);
  if (!Number.isFinite(userId) || userId <= 0) {
    return {
      language: null,
      language_codes: [],
      language_names: [],
    };
  }

  const user = await User.findOne({
    where: {
      id: userId,
      available: true,
      disabled: false,
      is_deleted: false,
    },
    attributes: ["language", "language_codes", "language_names"],
    raw: true,
  });

  return {
    language: ((user as any)?.language ?? null) as string | null,
    language_codes: toStringArray((user as any)?.language_codes),
    language_names: toStringArray((user as any)?.language_names),
  };
};

/* 🔹 Devuelve UUID push para usuarios activos con alertas */
export const getUuid = async (id: number) => {
  const pushSettings = await getPushSettings(id);
  return pushSettings.uuid;
};

export const clearPushSessionTokenIfMatch = async (id: number, uuid: string) => {
  const userId = Number(id);
  const token = String(uuid ?? "").trim();
  if (!Number.isFinite(userId) || userId <= 0 || !token) return 0;

  try {
    await sequelize.query(
      `
        UPDATE user_auth_sessions
        SET device_uuid = NULL
        WHERE user_id = :userId
          AND device_uuid = :token
      `,
      {
        replacements: { userId, token },
        type: QueryTypes.UPDATE,
      }
    );
    return 1;
  } catch (error: any) {
    if (!isMissingTableError(error)) {
      console.log("[push] clearPushSessionTokenIfMatch error", error);
    }
    return 0;
  }
};

/* 🔹 Verifica duplicado por teléfono */
export const findByPhone = async (id: number, phone: string, dialing_code: string) => {
  const user = await User.findOne({
    where: { id: { [Op.ne]: id }, phone },
  });
  return user;
};

export const findNewPhone = async (phone: string) => {
  const user = await User.findOne({ where: { phone } });
  return user;
};

/* 🔹 Bloqueo entre usuarios (tipo Instagram) */
export const block_user = async (blocker_id: any, blocked_id: any) => {
  // ✅ seguridad: no bloquearse a sí mismo
  if (Number(blocker_id) === Number(blocked_id)) {
    return { success: false, message: "you cannot block yourself" };
  }

  // ✅ opcional: no bloquear usuarios deshabilitados globalmente
  const target = await User.findOne({ where: { id: blocked_id, disabled: false } });
  if (!target) {
    return { success: false, message: "target user not found" };
  }

  const flag = await UserBLock.findOne({ where: { blocker_id, blocked_id } });

  if (flag) {
    return { success: true, message: "the user has already been blocked previously" };
  }

  await UserBLock.create({ blocker_id, blocked_id });
  return { success: true, message: "the user has been successfully blocked" };
};

/* 🔹 Desbloqueo entre usuarios */
export const unblock_user = async (blocker_id: any, blocked_id: any) => {
  const data = await UserBLock.findOne({ where: { blocker_id, blocked_id } });

  if (!data) {
    return { success: true, message: "the user is not blocked" };
  }

  await data.destroy();
  return { success: true, message: "the user has been successfully unblocked" };
};

/* ✅ NUEVO: Lista de usuarios que YO bloqueé (para el front) */
export const get_blocked_users = async (blocker_id: any) => {
  const blocks = await UserBLock.findAll({
    where: { blocker_id },
    attributes: ["blocked_id", "createdAt"],
    order: [["createdAt", "DESC"]],
  });

  const ids = blocks
    .map((b: any) => Number(b.blocked_id))
    .filter((id: any) => Number.isFinite(id));

  if (ids.length === 0) return [];

  const users = await User.findAll({
    where: { id: ids, disabled: false },
    attributes: ["id", "name", "last_name", "image_profil", "verified", "rate", "username"],
  });

  // mantener orden del bloqueo (createdAt DESC)
  const orderMap = new Map(ids.map((id: number, idx: number) => [id, idx]));
  users.sort((a: any, b: any) => (orderMap.get(a.id) ?? 999999) - (orderMap.get(b.id) ?? 999999));

  return users;
};

/* ✅ OPCIONAL: Usuarios que me bloquearon */
export const get_users_who_blocked_me = async (blocked_id: any) => {
  const blocks = await UserBLock.findAll({
    where: { blocked_id },
    attributes: ["blocker_id", "createdAt"],
    order: [["createdAt", "DESC"]],
  });

  const ids = blocks
    .map((b: any) => Number(b.blocker_id))
    .filter((id: any) => Number.isFinite(id));

  if (ids.length === 0) return [];

  const users = await User.findAll({
    where: { id: ids, disabled: false },
    attributes: ["id", "name", "last_name", "image_profil", "verified", "rate", "username"],
  });

  const orderMap = new Map(ids.map((id: number, idx: number) => [id, idx]));
  users.sort((a: any, b: any) => (orderMap.get(a.id) ?? 999999) - (orderMap.get(b.id) ?? 999999));

  return users;
};

export const getUserById = async (id: number) => {
  return User.findByPk(id);
};

export const findByUsernameLower = async (usernameLower: string, excludeUserId?: number) => {
  const where: any = {
    [Op.and]: [Sequelize.where(Sequelize.fn("lower", Sequelize.col("username")), usernameLower)],
  };

  if (excludeUserId) {
    where.id = { [Op.ne]: excludeUserId };
  }

  return User.findOne({
    where,
    attributes: ["id", "username", "username_updated_at"],
  });
};

export const updateUsername = async (id: number, username: string) => {
  await User.update(
    { username, username_updated_at: new Date() },
    {
      where: { id },
    }
  );

  return User.findByPk(id);
};

export const reportUserProfile = async ({
  reportedUserIdRaw,
  reporterIdRaw,
  reason,
  details,
}: {
  reportedUserIdRaw: any;
  reporterIdRaw: any;
  reason: string;
  details?: string | null;
}) => {
  const reportedUserId = Number(reportedUserIdRaw);
  const reporterId = Number(reporterIdRaw);

  if (!Number.isFinite(reportedUserId) || reportedUserId <= 0) {
    return { notFound: true };
  }
  if (!Number.isFinite(reporterId) || reporterId <= 0) {
    return { invalidReporter: true };
  }

  const normalizedDetails = String(details ?? "").trim().slice(0, 4000) || null;

  return sequelize
    .transaction(async (transaction: any) => {
      const targetUser = await User.findOne({
        where: { id: reportedUserId, available: true, is_deleted: false },
        attributes: ["id"],
        transaction,
        lock: transaction.LOCK.UPDATE,
      });

      if (!targetUser) {
        return { notFound: true };
      }

      if (reportedUserId === reporterId) {
        return { selfReport: true };
      }

      const existing = await UserReport.findOne({
        where: { reportedUserId, reporterId },
        attributes: ["id"],
        transaction,
        lock: transaction.LOCK.UPDATE,
      });

      let alreadyReported = false;
      if (!existing) {
        try {
          await UserReport.create(
            {
              reportedUserId,
              reporterId,
              reason,
              details: normalizedDetails,
            },
            { transaction }
          );
        } catch (error: any) {
          if (error instanceof UniqueConstraintError) {
            alreadyReported = true;
          } else {
            throw error;
          }
        }
      } else {
        alreadyReported = true;
      }

      const reportsCount = await UserReport.count({
        where: { reportedUserId },
        distinct: true,
        col: "reporterId",
        transaction,
      });

      const autoDisableByProfileReports = await autoDisableUserByProfileReports({
        userIdRaw: reportedUserId,
        transaction,
      });
      const autoDisabled = Boolean(autoDisableByProfileReports?.disabledNow);
      const threshold = Number(
        autoDisableByProfileReports?.threshold ?? PROFILE_REPORT_DISABLE_THRESHOLD
      );

      return {
        notFound: false,
        invalidReporter: false,
        selfReport: false,
        alreadyReported,
        reportsCount: Number(reportsCount) || 0,
        autoDisabled,
        threshold,
        reportedUserId,
      };
    })
    .catch((error) => {
      if (isMissingTableError(error)) {
        return { storageMissing: true };
      }
      throw error;
    });
};

/* 🔹 Bloqueo global a nivel empresa (solo admin) */
export const admin_set_disabled = async (id: number, disabled: boolean) => {
  const [affected] = await User.update(
    {
      disabled,
      available: !disabled,
    },
    { where: { id } }
  );
  return affected ? { id, disabled } : { id, disabled, notFound: true };
};

export const autoDisableUserByProfileReports = async ({
  userIdRaw,
  transaction,
}: {
  userIdRaw: any;
  transaction?: any;
}) => {
  const userId = Number(userIdRaw);
  if (!Number.isFinite(userId) || userId <= 0) {
    return {
      invalidUser: true,
      disabledNow: false,
      alreadyDisabled: false,
      reportersCount: 0,
      threshold: PROFILE_REPORT_DISABLE_THRESHOLD,
    };
  }

  const user = await User.findByPk(userId, {
    attributes: ["id", "disabled", "available"],
    transaction,
    lock: transaction?.LOCK?.UPDATE,
  });

  if (!user) {
    return {
      invalidUser: false,
      notFound: true,
      disabledNow: false,
      alreadyDisabled: false,
      reportersCount: 0,
      threshold: PROFILE_REPORT_DISABLE_THRESHOLD,
    };
  }

  const reportersCount = await UserReport.count({
    where: { reportedUserId: userId },
    distinct: true,
    col: "reporterId",
    transaction,
  });

  const alreadyDisabled =
    isTrueLike((user as any)?.disabled) || !isTrueLike((user as any)?.available);
  const mustDisable = Number(reportersCount) >= PROFILE_REPORT_DISABLE_THRESHOLD;

  let disabledNow = false;
  if (!alreadyDisabled && mustDisable) {
    const [affected] = await User.update(
      { disabled: true, available: false },
      { where: { id: userId }, transaction }
    );
    disabledNow = Number(affected) > 0;
    if (disabledNow) {
      console.warn(
        `[moderation][auto-disable-profile] userId=${userId} uniqueProfileReporters=${Number(
          reportersCount
        )} threshold=${PROFILE_REPORT_DISABLE_THRESHOLD}`
      );
    }
  }

  return {
    invalidUser: false,
    notFound: false,
    disabledNow,
    alreadyDisabled,
    reportersCount: Number(reportersCount) || 0,
    threshold: PROFILE_REPORT_DISABLE_THRESHOLD,
  };
};

export const autoDisableUserByImpersonationReports = async ({
  userIdRaw,
  transaction,
}: {
  userIdRaw: any;
  transaction?: any;
}) => {
  const userId = Number(userIdRaw);
  if (!Number.isFinite(userId) || userId <= 0) {
    return {
      invalidUser: true,
      disabledNow: false,
      alreadyDisabled: false,
      reportersCount: 0,
      threshold: IMPERSONATION_REPORT_DISABLE_THRESHOLD,
    };
  }

  const user = await User.findByPk(userId, {
    attributes: ["id", "disabled", "available"],
    transaction,
    lock: transaction?.LOCK?.UPDATE,
  });

  if (!user) {
    return {
      invalidUser: false,
      notFound: true,
      disabledNow: false,
      alreadyDisabled: false,
      reportersCount: 0,
      threshold: IMPERSONATION_REPORT_DISABLE_THRESHOLD,
    };
  }

  const postRows = await sequelize
    .query(
      `
        SELECT DISTINCT pr.reporterId AS reporterId
        FROM post_reports pr
        INNER JOIN posts p ON p.id = pr.postId
        WHERE p.userId = :userId
          AND pr.reason = :reason
      `,
      {
        replacements: { userId, reason: IMPERSONATION_REPORT_REASON },
        type: QueryTypes.SELECT,
        transaction,
      }
    )
    .catch((error) => {
      if (isMissingTableError(error)) return [];
      throw error;
    });

  const serviceRows = await sequelize
    .query(
      `
        SELECT DISTINCT sr.reporterId AS reporterId
        FROM service_reports sr
        INNER JOIN services s ON s.id = sr.serviceId
        WHERE s.userId = :userId
          AND sr.reason = :reason
      `,
      {
        replacements: { userId, reason: IMPERSONATION_REPORT_REASON },
        type: QueryTypes.SELECT,
        transaction,
      }
    )
    .catch((error) => {
      if (isMissingTableError(error)) return [];
      throw error;
    });

  const profileRows = await sequelize
    .query(
      `
        SELECT DISTINCT ur.reporterId AS reporterId
        FROM user_reports ur
        WHERE ur.reportedUserId = :userId
          AND ur.reason = :reason
      `,
      {
        replacements: { userId, reason: IMPERSONATION_REPORT_REASON },
        type: QueryTypes.SELECT,
        transaction,
      }
    )
    .catch((error) => {
      if (isMissingTableError(error)) return [];
      throw error;
    });

  const reporters = toDistinctReporterIds(postRows as any[]);
  const serviceReporterIds = toDistinctReporterIds(serviceRows as any[]);
  const profileReporterIds = toDistinctReporterIds(profileRows as any[]);
  serviceReporterIds.forEach((id) => reporters.add(id));
  profileReporterIds.forEach((id) => reporters.add(id));

  const reportersCount = reporters.size;
  const alreadyDisabled =
    isTrueLike((user as any)?.disabled) || !isTrueLike((user as any)?.available);
  const mustDisable = reportersCount >= IMPERSONATION_REPORT_DISABLE_THRESHOLD;

  let disabledNow = false;
  if (!alreadyDisabled && mustDisable) {
    const [affected] = await User.update(
      { disabled: true, available: false },
      { where: { id: userId }, transaction }
    );
    disabledNow = Number(affected) > 0;
    if (disabledNow) {
      console.warn(
        `[moderation][auto-disable] userId=${userId} reason=${IMPERSONATION_REPORT_REASON} uniqueReporters=${reportersCount} threshold=${IMPERSONATION_REPORT_DISABLE_THRESHOLD}`
      );
    }
  }

  return {
    invalidUser: false,
    notFound: false,
    disabledNow,
    alreadyDisabled,
    reportersCount,
    threshold: IMPERSONATION_REPORT_DISABLE_THRESHOLD,
    reason: IMPERSONATION_REPORT_REASON,
  };
};

export const admin_restore_deleted = async (id: number) => {
  const [affected] = await User.update(
    { is_deleted: false, deleted_at: null, available: true, disabled: false },
    { where: { id } }
  );
  return affected
    ? { id, restored: true }
    : { id, restored: false, notFound: true };
};

export const activeUser = async (id: any) => {
  const user = await User.findOne({ where: { id } });
  if (!user) return null;
  return user.update({ available: true, disabled: false });
};
