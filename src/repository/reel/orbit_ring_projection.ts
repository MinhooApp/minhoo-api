import { Op } from "sequelize";
import Reel from "../../_models/reel/reel";
import Follower from "../../_models/follower/follower";

const ORBIT_RING_WINDOW_MS = 24 * 60 * 60 * 1000;

type OrbitRingState = {
  hasActiveOrbit: boolean;
  activeOrbitReelId: number | null;
  orbitRingUntil: string | null;
};

const EMPTY_ORBIT_RING_STATE: OrbitRingState = {
  hasActiveOrbit: false,
  activeOrbitReelId: null,
  orbitRingUntil: null,
};

const normalizePositiveInt = (value: any): number | null => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
};

const isPositiveNumber = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

const toValidDate = (value: any): Date | null => {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const setDataValue = (row: any, key: string, value: any) => {
  if (!row) return;
  if (typeof row.setDataValue === "function") {
    row.setDataValue(key, value);
    return;
  }
  row[key] = value;
};

const resolveRingUntilDate = (reel: any): Date | null => {
  const fromNewUntil = toValidDate(reel?.new_until ?? reel?.newUntil);
  if (fromNewUntil) return fromNewUntil;

  const createdAt = toValidDate(reel?.createdAt ?? reel?.created_at);
  if (!createdAt) return null;
  return new Date(createdAt.getTime() + ORBIT_RING_WINDOW_MS);
};

const buildOrbitRingStateFromReel = (reel: any): OrbitRingState => {
  const reelId = normalizePositiveInt(reel?.id ?? reel?.reelId ?? reel?.reel_id);
  if (!reelId) return { ...EMPTY_ORBIT_RING_STATE };

  const ringUntilDate = resolveRingUntilDate(reel);
  if (!ringUntilDate) return { ...EMPTY_ORBIT_RING_STATE };

  const ringActive = ringUntilDate.getTime() > Date.now();
  if (!ringActive) return { ...EMPTY_ORBIT_RING_STATE };

  return {
    hasActiveOrbit: true,
    activeOrbitReelId: reelId,
    orbitRingUntil: ringUntilDate.toISOString(),
  };
};

const applyOrbitRingStateToUser = (user: any, stateRaw?: OrbitRingState | null) => {
  const state = stateRaw ?? EMPTY_ORBIT_RING_STATE;
  const hasActiveOrbit = Boolean(state.hasActiveOrbit);
  const activeOrbitReelId = hasActiveOrbit
    ? normalizePositiveInt(state.activeOrbitReelId)
    : null;
  const orbitRingUntil = hasActiveOrbit ? state.orbitRingUntil ?? null : null;

  setDataValue(user, "has_active_orbit", hasActiveOrbit);
  setDataValue(user, "hasActiveOrbit", hasActiveOrbit);
  setDataValue(user, "active_orbit_reel_id", activeOrbitReelId);
  setDataValue(user, "activeOrbitReelId", activeOrbitReelId);
  setDataValue(user, "orbit_ring_until", orbitRingUntil);
  setDataValue(user, "orbitRingUntil", orbitRingUntil);

  // Backward compatibility with existing Orbit ring fields.
  setDataValue(user, "has_orbit_ring", hasActiveOrbit);
  setDataValue(user, "hasOrbitRing", hasActiveOrbit);
};

const loadViewerFollowedCreatorIds = async (
  viewerId: number | null,
  candidateUserIds: number[]
) => {
  if (!viewerId || !candidateUserIds.length) return new Set<number>();

  const rows = await Follower.findAll({
    where: {
      followerId: viewerId,
      userId: { [Op.in]: candidateUserIds },
    },
    attributes: ["userId"],
    raw: true,
  });

  return new Set<number>(
    rows
      .map((row: any) => normalizePositiveInt(row?.userId))
      .filter(isPositiveNumber)
  );
};

const isReelVisibleToViewer = (
  reel: any,
  viewerId: number | null,
  followedCreatorIds: Set<number>
) => {
  const creatorId = normalizePositiveInt(reel?.userId);
  if (!creatorId) return false;

  const visibility = String(reel?.visibility ?? "public").trim().toLowerCase();

  if (!viewerId) {
    return visibility === "public";
  }

  if (creatorId === viewerId) return true;
  if (visibility === "public") return true;
  if (visibility === "followers") return followedCreatorIds.has(creatorId);
  return false;
};

export const getActiveOrbitStateByUsers = async ({
  userIdsRaw,
  viewerIdRaw,
}: {
  userIdsRaw: any[];
  viewerIdRaw: any;
}): Promise<Map<number, OrbitRingState>> => {
  const userIds = Array.from(
    new Set(
      (Array.isArray(userIdsRaw) ? userIdsRaw : [])
        .map((value) => normalizePositiveInt(value))
        .filter(isPositiveNumber)
    )
  );
  const viewerId = normalizePositiveInt(viewerIdRaw);
  const stateByUserId = new Map<number, OrbitRingState>();
  userIds.forEach((userId) => stateByUserId.set(userId, { ...EMPTY_ORBIT_RING_STATE }));

  if (!userIds.length) return stateByUserId;

  const followedCreatorIds = await loadViewerFollowedCreatorIds(viewerId, userIds);
  const minCreatedAt = new Date(Date.now() - ORBIT_RING_WINDOW_MS * 2);

  const reels = await Reel.findAll({
    where: {
      userId: { [Op.in]: userIds },
      is_delete: false,
      status: "ready",
      createdAt: { [Op.gte]: minCreatedAt },
    },
    attributes: ["id", "userId", "visibility", "createdAt"],
    order: [
      ["userId", "ASC"],
      ["createdAt", "DESC"],
      ["id", "DESC"],
    ],
    raw: true,
  });

  for (const reel of reels as any[]) {
    const creatorId = normalizePositiveInt(reel?.userId);
    if (!creatorId) continue;
    if (stateByUserId.get(creatorId)?.hasActiveOrbit) continue;
    if (!isReelVisibleToViewer(reel, viewerId, followedCreatorIds)) continue;

    const state = buildOrbitRingStateFromReel(reel);
    if (!state.hasActiveOrbit) continue;
    stateByUserId.set(creatorId, state);
  }

  return stateByUserId;
};

export const attachActiveOrbitStateToUsers = async ({
  usersRaw,
  viewerIdRaw,
}: {
  usersRaw: any[];
  viewerIdRaw: any;
}) => {
  const users = Array.isArray(usersRaw)
    ? usersRaw.filter((row) => !!row && typeof row === "object")
    : [];
  if (!users.length) return;

  const userIds = users
    .map((user) => normalizePositiveInt((user as any)?.id ?? (user as any)?.userId))
    .filter(isPositiveNumber);
  if (!userIds.length) return;

  const stateByUserId = await getActiveOrbitStateByUsers({
    userIdsRaw: userIds,
    viewerIdRaw,
  });

  users.forEach((user: any) => {
    const userId = normalizePositiveInt((user as any)?.id ?? (user as any)?.userId);
    if (!userId) return;
    applyOrbitRingStateToUser(user, stateByUserId.get(userId) ?? EMPTY_ORBIT_RING_STATE);
  });
};

export const getActiveOrbitStateByUser = async ({
  userIdRaw,
  viewerIdRaw,
}: {
  userIdRaw: any;
  viewerIdRaw: any;
}): Promise<OrbitRingState> => {
  const userId = normalizePositiveInt(userIdRaw);
  if (!userId) return { ...EMPTY_ORBIT_RING_STATE };

  const stateByUserId = await getActiveOrbitStateByUsers({
    userIdsRaw: [userId],
    viewerIdRaw,
  });

  return stateByUserId.get(userId) ?? { ...EMPTY_ORBIT_RING_STATE };
};
