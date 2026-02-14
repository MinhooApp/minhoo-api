import { Op, Sequelize } from "sequelize";
import Follower from "../../_models/follower/follower";
import User from "../../_models/user/user";
const excludeKeys = ["createdAt", "updatedAt", "password"];

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
  // Buscar si ya existe una fila con los IDs proporcionados
  const existingFollow = await Follower.findOne({
    where: {
      userId,
      followerId,
    },
  });

  if (existingFollow) {
    // Si existe, eliminar la fila para dejar de seguir
    await existingFollow.destroy();
    return false; // Ya no sigue al usuario
  } else {
    // Si no existe, crear una nueva fila para seguir al usuario
    await Follower.create({
      userId,
      followerId,
    });
    return true; // Empezó a seguir al usuario
  }
};

export const removeFollower = async (userId: any, followerId: any) => {
  const followerUser = await User.findByPk(followerId);
  if (!followerUser) {
    return { removed: false, reason: "follower_not_found", rowsAffected: 0 };
  }

  const rowsAffected = await Follower.destroy({
    where: {
      userId,
      followerId,
    },
  });

  if (!rowsAffected) {
    return { removed: false, reason: "not_following", rowsAffected: 0 };
  }

  return { removed: true, rowsAffected };
};

export const getRelationship = async (viewerId: number, targetId: number) => {
  if (!Number.isFinite(viewerId) || !Number.isFinite(targetId)) {
    return { isFollowing: false, isFollowedBy: false, isMutual: false };
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

  return { isFollowing, isFollowedBy, isMutual: isFollowing && isFollowedBy };
};

export const getCounts = async (userId: number) => {
  const [followersCount, followingCount] = await Promise.all([
    Follower.count({ where: { userId } }),
    Follower.count({ where: { followerId: userId } }),
  ]);

  return { followersCount, followingCount };
};

export const followUser = async (targetId: number, viewerId: number) => {
  const [row, created] = await Follower.findOrCreate({
    where: { userId: targetId, followerId: viewerId },
    defaults: { userId: targetId, followerId: viewerId },
  });

  return { created, row };
};

export const unfollowUser = async (targetId: number, viewerId: number) => {
  const deleted = await Follower.destroy({
    where: { userId: targetId, followerId: viewerId },
  });

  return { removed: deleted > 0 };
};

export const listFollowersWithFlags = async (
  userId: number,
  viewerId: number | null,
  opts?: { cursor?: number | null; limit?: number }
) => {
  const hasViewer = Number.isFinite(viewerId as any) && (viewerId as number) > 0;
  const baseViewerId = hasViewer ? Number(viewerId) : Number(userId);
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
        where: { disabled: false, is_deleted: false },
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

  if (Number.isFinite(baseViewerId) && baseViewerId > 0 && followerIds.length) {
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
    return {
      user: row.follower_data,
      viewerFollowsUser,
      userFollowsViewer,
      isMutual: viewerFollowsUser && userFollowsViewer,
      canRemove: hasViewer && Number(viewerId) === Number(userId),
      followed_at: viewerFollowsAt.get(targetId) ?? null,
      followed_me_at: hasViewer
        ? userFollowsViewerAt.get(targetId) ?? null
        : row.createdAt ?? null,
    };
  });
};

export const listFollowingWithFlags = async (
  userId: number,
  viewerId: number | null,
  opts?: { cursor?: number | null; limit?: number }
) => {
  const hasViewer = Number.isFinite(viewerId as any) && (viewerId as number) > 0;
  const baseViewerId = hasViewer ? Number(viewerId) : Number(userId);
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
        where: { disabled: false, is_deleted: false },
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

  if (Number.isFinite(baseViewerId) && baseViewerId > 0 && followingIds.length) {
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
    return {
      user: row.following_data,
      viewerFollowsUser,
      userFollowsViewer,
      isMutual: viewerFollowsUser && userFollowsViewer,
      followed_at: hasViewer
        ? viewerFollowsAt.get(targetId) ?? null
        : row.createdAt ?? null,
      followed_me_at: userFollowsViewerAt.get(targetId) ?? null,
    };
  });
};
