import { Op, Sequelize } from "sequelize";
import Follower from "../../_models/follower/follower";
import User from "../../_models/user/user";
import { getCachedCounts, invalidateUserCounts } from "../../libs/cache/user_cache";
const excludeKeys = ["createdAt", "updatedAt", "password"];
const ADMIN_ROLE_IDS = new Set<number>([8088]);
const ADMIN_USERNAME_FALLBACKS = Array.from(
  new Set(
    String(process.env.ADMIN_USERNAME_FALLBACKS ?? "admin_minhoo_app")
      .split(",")
      .map((item) => String(item ?? "").trim().toLowerCase())
      .filter(Boolean)
  )
);

const normalizeLimit = (value: any, fallback = 20, max = 50) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(1, n), max);
};

const buildBlockLiteral = (viewerId: number, columnSql: string) =>
  Sequelize.literal(`
    NOT EXISTS (
      SELECT 1
      FROM user_blocks ub
      WHERE
        (ub.blocker_id = :viewerId AND ub.blocked_id = ${columnSql})
        OR
        (ub.blocker_id = ${columnSql} AND ub.blocked_id = :viewerId)
    )
  `);

const escapeSqlString = (value: string) => `'${String(value).replace(/'/g, "''")}'`;

const buildAdminExclusionLiterals = (tableAlias: string) => {
  const literals: any[] = [];

  const roleIds = Array.from(ADMIN_ROLE_IDS)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => Math.trunc(value));
  if (roleIds.length > 0) {
    literals.push(
      Sequelize.literal(`
        NOT EXISTS (
          SELECT 1
          FROM \`user_role\` ur
          WHERE ur.\`userId\` = \`${tableAlias}\`.\`id\`
            AND ur.\`roleId\` IN (${roleIds.join(",")})
        )
      `)
    );
  }

  const usernames = ADMIN_USERNAME_FALLBACKS.map((username) =>
    escapeSqlString(String(username).trim().toLowerCase())
  ).filter(Boolean);
  if (usernames.length > 0) {
    literals.push(
      Sequelize.literal(`
        (
          \`${tableAlias}\`.\`username\` IS NULL
          OR LOWER(\`${tableAlias}\`.\`username\`) NOT IN (${usernames.join(",")})
        )
      `)
    );
  }

  return literals;
};

const toPositiveInt = (value: any): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const safe = Math.trunc(parsed);
  return safe > 0 ? safe : null;
};

const toPlain = (row: any) =>
  row && typeof row.toJSON === "function" ? row.toJSON() : row;

export const add = async (body: any) => {
  const follower = await Follower.create(body);
  return follower;
};

export const gets = async (meId: any = -1) => {
  const follower = await Follower.findAll({
    where: {
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
    replacements: { meId },
  });
  return follower;
};
export const get = async (id: any, meId: any = -1) => {
  const follower = await Follower.findOne({
    where: {
      id: id,

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
    replacements: { meId },
  });
  return follower;
};

export const update = async (id: any, body: any) => {
  const followerTemp = await Follower.findByPk(id);
  const follower = await followerTemp?.update(body);
  return [follower];
};

export const deletefollower = async () => {
  const follower = await Follower.update({}, { where: {} });
  return follower;
};
export const toggleFollow = async (userId: any, followerId: any) => {
  const existingFollow = await Follower.findOne({
    where: { userId, followerId },
  });

  let followed: boolean;
  if (existingFollow) {
    await existingFollow.destroy();
    followed = false;
  } else {
    await Follower.create({ userId, followerId });
    followed = true;
  }

  await Promise.all([
    invalidateUserCounts(Number(userId)),
    invalidateUserCounts(Number(followerId)),
  ]);

  return followed;
};

export const removeFollower = async (userId: any, followerId: any) => {
  const followerUser = await User.findByPk(followerId);
  if (!followerUser) {
    return { removed: false, reason: "follower_not_found", rowsAffected: 0 };
  }

  const rowsAffected = await Follower.destroy({
    where: { userId, followerId },
  });

  if (!rowsAffected) {
    return { removed: false, reason: "not_following", rowsAffected: 0 };
  }

  await Promise.all([
    invalidateUserCounts(Number(userId)),
    invalidateUserCounts(Number(followerId)),
  ]);

  return { removed: true, rowsAffected };
};








export const getRelationship = async (viewerId: number, targetId: number) => {
  if (!Number.isFinite(viewerId) || !Number.isFinite(targetId)) {
    return {
      isFollowing: false,
      isFollowedBy: false,
      isMutual: false,
    };
  }

  const rows = await Follower.findAll({
    where: {
      [Op.or]: [
        { userId: targetId, followerId: viewerId },
        { userId: viewerId, followerId: targetId },
      ],
    },
    attributes: ["userId", "followerId"],
  });

  const isFollowing = rows.some(
    (r: any) => Number(r.userId) === Number(targetId) && Number(r.followerId) === Number(viewerId)
  );
  const isFollowedBy = rows.some(
    (r: any) => Number(r.userId) === Number(viewerId) && Number(r.followerId) === Number(targetId)
  );

  return {
    isFollowing,
    isFollowedBy,
    isMutual: isFollowing && isFollowedBy,
  };
};

export const getRelationshipMap = async (
  viewerIdRaw: any,
  targetIdsRaw: any[]
): Promise<Record<number, { isFollowing: boolean; isFollowedBy: boolean; isMutual: boolean }>> => {
  const viewerId = toPositiveInt(viewerIdRaw);
  if (!viewerId) return {};

  const targetIds = Array.from(
    new Set(
      (Array.isArray(targetIdsRaw) ? targetIdsRaw : [])
        .map((value: any) => toPositiveInt(value))
        .filter((value): value is number => Number.isFinite(value as any))
    )
  ).filter((id) => id !== viewerId);

  if (!targetIds.length) return {};

  const rows = await Follower.findAll({
    where: {
      [Op.or]: [
        { userId: { [Op.in]: targetIds }, followerId: viewerId },
        { userId: viewerId, followerId: { [Op.in]: targetIds } },
      ],
    },
    attributes: ["userId", "followerId"],
    raw: true,
  });

  const followingSet = new Set<number>();
  const followedBySet = new Set<number>();
  rows.forEach((row: any) => {
    const userId = Number(row?.userId);
    const followerId = Number(row?.followerId);
    if (userId !== viewerId && followerId === viewerId) {
      followingSet.add(userId);
      return;
    }
    if (userId === viewerId && followerId !== viewerId) {
      followedBySet.add(followerId);
    }
  });

  const map: Record<number, { isFollowing: boolean; isFollowedBy: boolean; isMutual: boolean }> = {};
  targetIds.forEach((targetId) => {
    const isFollowing = followingSet.has(targetId);
    const isFollowedBy = followedBySet.has(targetId);
    map[targetId] = {
      isFollowing,
      isFollowedBy,
      isMutual: isFollowing && isFollowedBy,
    };
  });

  return map;
};

export const getCounts = async (userId: number) => {
  return getCachedCounts(userId, async () => {
    const [followersCount, followingCount] = await Promise.all([
      Follower.count({ where: { userId } }),
      Follower.count({ where: { followerId: userId } }),
    ]);
    return { followersCount, followingCount };
  });
};

export const getCountsMap = async (userIdsRaw: any[]) => {
  const userIds = Array.from(
    new Set(
      (Array.isArray(userIdsRaw) ? userIdsRaw : [])
        .map((value) => toPositiveInt(value))
        .filter((value): value is number => Number.isFinite(value as any))
    )
  );

  const output: Record<number, { followersCount: number; followingCount: number }> = {};
  if (!userIds.length) return output;

  const countExpression = Sequelize.fn("COUNT", Sequelize.col("id"));
  const [followersRows, followingRows] = await Promise.all([
    Follower.findAll({
      where: { userId: { [Op.in]: userIds } },
      attributes: ["userId", [countExpression, "count"]],
      group: ["userId"],
      raw: true,
    }),
    Follower.findAll({
      where: { followerId: { [Op.in]: userIds } },
      attributes: ["followerId", [countExpression, "count"]],
      group: ["followerId"],
      raw: true,
    }),
  ]);

  userIds.forEach((userId) => {
    output[userId] = { followersCount: 0, followingCount: 0 };
  });

  (followersRows as any[]).forEach((row: any) => {
    const userId = toPositiveInt(row?.userId);
    const count = Number(row?.count ?? 0);
    if (!userId || !output[userId]) return;
    output[userId].followersCount = Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
  });

  (followingRows as any[]).forEach((row: any) => {
    const userId = toPositiveInt(row?.followerId);
    const count = Number(row?.count ?? 0);
    if (!userId || !output[userId]) return;
    output[userId].followingCount = Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
  });

  return output;
};

export const followUser = async (targetId: number, viewerId: number) => {
  const [row, created] = await Follower.findOrCreate({
    where: { userId: targetId, followerId: viewerId },
    defaults: { userId: targetId, followerId: viewerId },
  });

  if (created) {
    await Promise.all([
      invalidateUserCounts(targetId),
      invalidateUserCounts(viewerId),
    ]);
  }

  return { created, row };
};

export const unfollowUser = async (targetId: number, viewerId: number) => {
  const deleted = await Follower.destroy({
    where: { userId: targetId, followerId: viewerId },
  });

  if (deleted > 0) {
    await Promise.all([
      invalidateUserCounts(targetId),
      invalidateUserCounts(viewerId),
    ]);
  }

  return { removed: deleted > 0 };
};

export const unfollowByRelationId = async (relationId: number, viewerId: number) => {
  const relation = await Follower.findOne({
    where: { id: relationId, followerId: viewerId },
    attributes: ["id", "userId", "followerId"],
  });

  if (!relation) {
    return { removed: false, targetId: null as number | null };
  }

  const targetId = Number((relation as any)?.userId);
  await relation.destroy();

  if (Number.isFinite(targetId) && targetId > 0) {
    await Promise.all([
      invalidateUserCounts(targetId),
      invalidateUserCounts(Number(viewerId)),
    ]);
    return { removed: true, targetId };
  }

  await invalidateUserCounts(Number(viewerId));
  return { removed: true, targetId: null as number | null };
};

export const resolveCounterpartUserIdByRelationId = async (
  relationId: number,
  viewerId: number
): Promise<number | null> => {
  const relation = await Follower.findOne({
    where: {
      id: relationId,
      [Op.or]: [{ userId: viewerId }, { followerId: viewerId }],
    },
    attributes: ["id", "userId", "followerId"],
  });

  if (!relation) return null;

  const ownerId = Number((relation as any)?.userId);
  const followerId = Number((relation as any)?.followerId);
  if (ownerId === viewerId && followerId > 0 && followerId !== viewerId) {
    return followerId;
  }
  if (followerId === viewerId && ownerId > 0 && ownerId !== viewerId) {
    return ownerId;
  }

  return null;
};

export const listFollowersWithFlags = async (
  userId: number,
  viewerId: number | null,
  opts?: { cursor?: number | null; limit?: number }
) => {
  const hasViewer = Number.isFinite(viewerId as any) && (viewerId as number) > 0;
  const baseViewerId = hasViewer ? Number(viewerId) : null;
  const limit = normalizeLimit(opts?.limit, 20, 50);
  const cursor = opts?.cursor ? Number(opts?.cursor) : null;

  const where: any = { userId };
  const and: any[] = [];

  if (cursor && Number.isFinite(cursor)) {
    where.id = { [Op.lt]: cursor };
  }

  if (hasViewer) {
    and.push(buildBlockLiteral(viewerId as number, "`follower`.`followerId`"));
  }

  if (and.length) {
    where[Op.and] = and;
  }

  const rows = await Follower.findAll({
    where,
    attributes: ["id", "userId", "followerId", "createdAt"],
    include: [
      {
        model: User,
        as: "follower_data",
        attributes: ["id", "name", "last_name", "image_profil", "username"],
        where: {
          disabled: false,
          is_deleted: false,
          [Op.and]: buildAdminExclusionLiterals("follower_data"),
        },
        required: true,
      },
    ],
    order: [["id", "DESC"]],
    limit,
    ...(hasViewer ? { replacements: { viewerId } } : {}),
  });

  const followerIds = rows
    .map((r: any) => Number(r.followerId))
    .filter((id: number) => Number.isFinite(id));

  let viewerFollowsSet = new Set<number>();
  let userFollowsViewerSet = new Set<number>();
  const viewerFollowsAt = new Map<number, Date>();
  const userFollowsViewerAt = new Map<number, Date>();

  if (baseViewerId && followerIds.length) {
    const viewerFollows = await Follower.findAll({
      where: { followerId: baseViewerId, userId: followerIds },
      attributes: ["userId", "createdAt"],
    });
    viewerFollowsSet = new Set(viewerFollows.map((r: any) => Number(r.userId)));
    viewerFollows.forEach((r: any) => {
      viewerFollowsAt.set(Number(r.userId), r.createdAt);
    });

    const userFollowsViewer = await Follower.findAll({
      where: { userId: baseViewerId, followerId: followerIds },
      attributes: ["followerId", "createdAt"],
    });
    userFollowsViewerSet = new Set(
      userFollowsViewer.map((r: any) => Number(r.followerId))
    );
    userFollowsViewer.forEach((r: any) => {
      userFollowsViewerAt.set(Number(r.followerId), r.createdAt);
    });
  }

  return rows.map((row: any) => {
    const targetId = Number(row.followerId);
    const viewerFollowsUser = viewerFollowsSet.has(targetId);
    const userFollowsViewer = userFollowsViewerSet.has(targetId);
    const isMutual = viewerFollowsUser && userFollowsViewer;
    return {
      id: targetId || null,
      cursor_id: Number(row.id ?? 0) || null,
      relationId: Number(row.id ?? 0) || null,
      user: row.follower_data,
      viewerFollowsUser,
      viewer_follows_user: viewerFollowsUser,
      isFollowing: viewerFollowsUser,
      is_following: viewerFollowsUser,
      userFollowsViewer,
      user_follows_viewer: userFollowsViewer,
      isFollowedBy: userFollowsViewer,
      is_followed_by: userFollowsViewer,
      isMutual,
      is_mutual: isMutual,
      canRemove: hasViewer && Number(viewerId) === Number(userId),
      followed_at: viewerFollowsAt.get(targetId) ?? null,
      followed_me_at: hasViewer
        ? userFollowsViewerAt.get(targetId) ?? null
        : row.createdAt ?? null,
    };
  });
};

export const listFollowersSummary = async (
  userId: number,
  viewerId: number | null,
  opts?: { cursor?: number | null; limit?: number }
) => {
  const hasViewer = Number.isFinite(viewerId as any) && (viewerId as number) > 0;
  const baseViewerId = hasViewer ? Number(viewerId) : null;
  const limit = normalizeLimit(opts?.limit, 20, 20);
  const cursor = opts?.cursor ? Number(opts?.cursor) : null;

  const where: any = { userId };
  const and: any[] = [];

  if (cursor && Number.isFinite(cursor)) {
    where.id = { [Op.lt]: cursor };
  }

  if (hasViewer) {
    and.push(buildBlockLiteral(viewerId as number, "`follower`.`followerId`"));
  }

  if (and.length) {
    where[Op.and] = and;
  }

  const rows = await Follower.findAll({
    where,
    attributes: ["id", "followerId"],
    include: [
      {
        model: User,
        as: "follower_data",
        attributes: ["id", "name", "last_name", "username", "image_profil", "verified"],
        where: {
          disabled: false,
          is_deleted: false,
          [Op.and]: buildAdminExclusionLiterals("follower_data"),
        },
        required: true,
      },
    ],
    order: [["id", "DESC"]],
    limit,
    ...(hasViewer ? { replacements: { viewerId } } : {}),
  });

  const followerIds = rows
    .map((r: any) => Number(r.followerId))
    .filter((id: number) => Number.isFinite(id));

  let viewerFollowsSet = new Set<number>();
  let userFollowsViewerSet = new Set<number>();

  if (baseViewerId && followerIds.length) {
    const [viewerFollows, userFollowsViewer] = await Promise.all([
      Follower.findAll({
        where: { followerId: baseViewerId, userId: followerIds },
        attributes: ["userId"],
        raw: true,
      }),
      Follower.findAll({
        where: { userId: baseViewerId, followerId: followerIds },
        attributes: ["followerId"],
        raw: true,
      }),
    ]);

    viewerFollowsSet = new Set(viewerFollows.map((r: any) => Number(r.userId)));
    userFollowsViewerSet = new Set(
      userFollowsViewer.map((r: any) => Number(r.followerId))
    );
  }

  return rows.map((row: any) => {
    const targetId = Number(row.followerId);
    const viewerFollowsUser = viewerFollowsSet.has(targetId);
    const userFollowsViewer = userFollowsViewerSet.has(targetId);
    const isMutual = viewerFollowsUser && userFollowsViewer;
    return {
      id: targetId || null,
      cursor_id: Number(row.id ?? 0) || null,
      relationId: Number(row.id ?? 0) || null,
      user: row.follower_data,
      viewerFollowsUser,
      viewer_follows_user: viewerFollowsUser,
      isFollowing: viewerFollowsUser,
      is_following: viewerFollowsUser,
      userFollowsViewer,
      user_follows_viewer: userFollowsViewer,
      isFollowedBy: userFollowsViewer,
      is_followed_by: userFollowsViewer,
      isMutual,
      is_mutual: isMutual,
      canRemove: hasViewer && Number(viewerId) === Number(userId),
    };
  });
};

export const listFollowingWithFlags = async (
  userId: number,
  viewerId: number | null,
  opts?: { cursor?: number | null; limit?: number }
) => {
  const hasViewer = Number.isFinite(viewerId as any) && (viewerId as number) > 0;
  const baseViewerId = hasViewer ? Number(viewerId) : null;
  const limit = normalizeLimit(opts?.limit, 20, 50);
  const cursor = opts?.cursor ? Number(opts?.cursor) : null;

  const where: any = { followerId: userId };
  const and: any[] = [];

  if (cursor && Number.isFinite(cursor)) {
    where.id = { [Op.lt]: cursor };
  }

  if (hasViewer) {
    and.push(buildBlockLiteral(viewerId as number, "`follower`.`userId`"));
  }

  if (and.length) {
    where[Op.and] = and;
  }

  const rows = await Follower.findAll({
    where,
    attributes: ["id", "userId", "followerId", "createdAt"],
    include: [
      {
        model: User,
        as: "following_data",
        attributes: ["id", "name", "last_name", "image_profil", "username"],
        where: {
          disabled: false,
          is_deleted: false,
          [Op.and]: buildAdminExclusionLiterals("following_data"),
        },
        required: true,
      },
    ],
    order: [["id", "DESC"]],
    limit,
    ...(hasViewer ? { replacements: { viewerId } } : {}),
  });

  const followingIds = rows
    .map((r: any) => Number(r.userId))
    .filter((id: number) => Number.isFinite(id));

  let viewerFollowsSet = new Set<number>();
  let userFollowsViewerSet = new Set<number>();
  const viewerFollowsAt = new Map<number, Date>();
  const userFollowsViewerAt = new Map<number, Date>();

  if (baseViewerId && followingIds.length) {
    const viewerFollows = await Follower.findAll({
      where: { followerId: baseViewerId, userId: followingIds },
      attributes: ["userId", "createdAt"],
    });
    viewerFollowsSet = new Set(viewerFollows.map((r: any) => Number(r.userId)));
    viewerFollows.forEach((r: any) => {
      viewerFollowsAt.set(Number(r.userId), r.createdAt);
    });

    const userFollowsViewer = await Follower.findAll({
      where: { userId: baseViewerId, followerId: followingIds },
      attributes: ["followerId", "createdAt"],
    });
    userFollowsViewerSet = new Set(
      userFollowsViewer.map((r: any) => Number(r.followerId))
    );
    userFollowsViewer.forEach((r: any) => {
      userFollowsViewerAt.set(Number(r.followerId), r.createdAt);
    });
  }

  return rows.map((row: any) => {
    const targetId = Number(row.userId);
    const viewerFollowsUser = viewerFollowsSet.has(targetId);
    const userFollowsViewer = userFollowsViewerSet.has(targetId);
    const isMutual = viewerFollowsUser && userFollowsViewer;
    return {
      id: targetId || null,
      cursor_id: Number(row.id ?? 0) || null,
      relationId: Number(row.id ?? 0) || null,
      user: row.following_data,
      viewerFollowsUser,
      viewer_follows_user: viewerFollowsUser,
      isFollowing: viewerFollowsUser,
      is_following: viewerFollowsUser,
      userFollowsViewer,
      user_follows_viewer: userFollowsViewer,
      isFollowedBy: userFollowsViewer,
      is_followed_by: userFollowsViewer,
      isMutual,
      is_mutual: isMutual,
      followed_at: hasViewer
        ? viewerFollowsAt.get(targetId) ?? null
        : row.createdAt ?? null,
      followed_me_at: userFollowsViewerAt.get(targetId) ?? null,
    };
  });
};

export const listFollowingSummary = async (
  userId: number,
  viewerId: number | null,
  opts?: { cursor?: number | null; limit?: number }
) => {
  const hasViewer = Number.isFinite(viewerId as any) && (viewerId as number) > 0;
  const baseViewerId = hasViewer ? Number(viewerId) : null;
  const limit = normalizeLimit(opts?.limit, 20, 20);
  const cursor = opts?.cursor ? Number(opts?.cursor) : null;

  const where: any = { followerId: userId };
  const and: any[] = [];

  if (cursor && Number.isFinite(cursor)) {
    where.id = { [Op.lt]: cursor };
  }

  if (hasViewer) {
    and.push(buildBlockLiteral(viewerId as number, "`follower`.`userId`"));
  }

  if (and.length) {
    where[Op.and] = and;
  }

  const rows = await Follower.findAll({
    where,
    attributes: ["id", "userId"],
    include: [
      {
        model: User,
        as: "following_data",
        attributes: ["id", "name", "last_name", "username", "image_profil", "verified"],
        where: {
          disabled: false,
          is_deleted: false,
          [Op.and]: buildAdminExclusionLiterals("following_data"),
        },
        required: true,
      },
    ],
    order: [["id", "DESC"]],
    limit,
    ...(hasViewer ? { replacements: { viewerId } } : {}),
  });

  const followingIds = rows
    .map((r: any) => Number(r.userId))
    .filter((id: number) => Number.isFinite(id));

  let viewerFollowsSet = new Set<number>();
  let userFollowsViewerSet = new Set<number>();

  if (baseViewerId && followingIds.length) {
    const [viewerFollows, userFollowsViewer] = await Promise.all([
      Follower.findAll({
        where: { followerId: baseViewerId, userId: followingIds },
        attributes: ["userId"],
        raw: true,
      }),
      Follower.findAll({
        where: { userId: baseViewerId, followerId: followingIds },
        attributes: ["followerId"],
        raw: true,
      }),
    ]);

    viewerFollowsSet = new Set(viewerFollows.map((r: any) => Number(r.userId)));
    userFollowsViewerSet = new Set(
      userFollowsViewer.map((r: any) => Number(r.followerId))
    );
  }

  return rows.map((row: any) => {
    const targetId = Number(row.userId);
    const viewerFollowsUser = viewerFollowsSet.has(targetId);
    const userFollowsViewer = userFollowsViewerSet.has(targetId);
    const isMutual = viewerFollowsUser && userFollowsViewer;
    return {
      id: targetId || null,
      cursor_id: Number(row.id ?? 0) || null,
      relationId: Number(row.id ?? 0) || null,
      user: row.following_data,
      viewerFollowsUser,
      viewer_follows_user: viewerFollowsUser,
      isFollowing: viewerFollowsUser,
      is_following: viewerFollowsUser,
      userFollowsViewer,
      user_follows_viewer: userFollowsViewer,
      isFollowedBy: userFollowsViewer,
      is_followed_by: userFollowsViewer,
      isMutual,
      is_mutual: isMutual,
    };
  });
};
