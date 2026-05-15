import {
  Request,
  Response,
  formatResponse,
  repository,
} from "../_module/module";
import crypto from "crypto";
import admin from "firebase-admin";
import * as followerRepo from "../../../repository/follower/follower_repository";
import { sendNotification } from "../../notification/add/add";
import {
  hasRecentProfileRecommendationNotification,
  PROFILE_RECOMMENDATION_MESSAGE_PREFIX,
} from "../../../repository/notification/notification_repository";

const setPrivateNoStore = (res: Response) => {
  res.set("Cache-Control", "private, no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Vary", "Accept-Encoding, Authorization");
};

const toTextOrNull = (value: any): string | null => {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized.length ? normalized : null;
};

const resolveAvatarValue = (entity: any): string | null =>
  toTextOrNull(entity?.image_profil) ??
  toTextOrNull(entity?.image_profile) ??
  toTextOrNull(entity?.avatar_url) ??
  toTextOrNull(entity?.avatarUrl);

const attachAvatarAliases = (entity: any) => {
  if (!entity) return;
  const avatar = resolveAvatarValue(entity);
  if (!avatar) return;

  const fields: Record<string, string> = {
    image_profil: avatar,
    image_profile: avatar,
    avatar_url: avatar,
    avatarUrl: avatar,
  };

  if (typeof entity?.setDataValue === "function") {
    Object.entries(fields).forEach(([key, value]) => {
      entity.setDataValue(key, value);
    });
    return;
  }

  Object.assign(entity, fields);
};

const attachFollowCountAliases = (entity: any, followersCount: number, followingCount: number) => {
  if (!entity) return;

  const fields = {
    followers_count: followersCount,
    followings_count: followingCount,
    following_count: followingCount,
    followersCount,
    followingsCount: followingCount,
    followingCount,
  };

  if (typeof entity.setDataValue === "function") {
    Object.entries(fields).forEach(([key, value]) => {
      entity.setDataValue(key, value);
    });
    return;
  }

  Object.assign(entity, fields);
};

const attachRelationshipAliases = (entity: any, relationshipRaw: any) => {
  if (!entity) return;
  const isFollowing = Boolean(relationshipRaw?.isFollowing);
  const isFollowedBy = Boolean(relationshipRaw?.isFollowedBy);
  const isMutual = isFollowing && isFollowedBy;
  const fields = {
    relationship: {
      isFollowing,
      isFollowedBy,
      isMutual,
    },
    isFollowing,
    is_following: isFollowing,
    viewerFollowsUser: isFollowing,
    viewer_follows_user: isFollowing,
    isFollowedBy,
    is_followed_by: isFollowedBy,
    userFollowsViewer: isFollowedBy,
    user_follows_viewer: isFollowedBy,
    isMutual,
    is_mutual: isMutual,
  };

  if (typeof entity.setDataValue === "function") {
    Object.entries(fields).forEach(([key, value]) => {
      entity.setDataValue(key, value);
    });
    return;
  }

  Object.assign(entity, fields);
};

const collectWorkerTargetUserIds = (workersRaw: any[]): number[] =>
  Array.from(
    new Set(
      (Array.isArray(workersRaw) ? workersRaw : [])
        .map((worker: any) =>
          Number((worker as any)?.userId ?? (worker as any)?.personal_data?.id)
        )
        .filter((id: number) => Number.isFinite(id) && id > 0)
    )
  );

const attachRelationshipsToWorkers = async (viewerIdRaw: any, workersRaw: any[]) => {
  const relationshipByUserId = await followerRepo.getRelationshipMap(
    viewerIdRaw,
    collectWorkerTargetUserIds(workersRaw)
  );

  (Array.isArray(workersRaw) ? workersRaw : []).forEach((worker: any) => {
    attachAvatarAliases(worker);
    attachAvatarAliases((worker as any)?.personal_data);
    const targetUserId = Number((worker as any)?.userId ?? (worker as any)?.personal_data?.id);
    const relationship =
      relationshipByUserId[targetUserId] ??
      ({ isFollowing: false, isFollowedBy: false, isMutual: false } as const);
    attachRelationshipAliases(worker, relationship);
    attachRelationshipAliases((worker as any)?.personal_data, relationship);
  });
};

const toSessionKey = (req: Request) => {
  const queryKey = String(
    (req.query as any)?.session_key ?? (req.query as any)?.sessionKey ?? ""
  ).trim();
  const headerKey = String(req.header("x-session-key") ?? "").trim();

  const explicit = queryKey || headerKey;
  if (explicit) return explicit.slice(0, 128);

  const viewerId = Number((req as any)?.userId ?? 0);
  if (Number.isFinite(viewerId) && viewerId > 0) return `u:${viewerId}`;

  const ip = String(req.ip ?? "").trim();
  const userAgent = String(req.header("user-agent") ?? "").trim();
  if (!ip && !userAgent) return "";

  return crypto
    .createHash("sha1")
    .update(`${ip}|${userAgent}`)
    .digest("hex")
    .slice(0, 40);
};

const PROFILE_RECOMMENDATION_PUSH_ENABLED =
  String(process.env.PROFILE_RECOMMENDATION_PUSH_ENABLED ?? "1").trim() !== "0";
const PROFILE_RECOMMENDATION_WINDOW_HOURS = Math.max(
  1,
  Number(process.env.PROFILE_RECOMMENDATION_WINDOW_HOURS ?? 24) || 24
);

const buildDisplayName = (userRaw: any) => {
  const user = userRaw && typeof userRaw === "object" ? userRaw : {};
  const first = String(user?.name ?? "").trim();
  const last = String(user?.last_name ?? "").trim();
  const full = `${first} ${last}`.trim();
  if (full) return full;

  const username = String(user?.username ?? "").trim();
  if (username) return `@${username}`;
  return "this professional";
};

const pickRecommendationCandidate = async (viewerId: number, rowsRaw: any[]) => {
  const rows = Array.isArray(rowsRaw) ? rowsRaw : [];
  for (const row of rows) {
    const recommendedUserId = Number((row as any)?.userId ?? (row as any)?.personal_data?.id);
    if (!Number.isFinite(recommendedUserId) || recommendedUserId <= 0) continue;
    if (recommendedUserId === viewerId) continue;

    const relationship = await followerRepo.getRelationship(viewerId, recommendedUserId);
    if (relationship?.isFollowing) continue;

    return {
      recommendedUserId,
      recommendedUserName: buildDisplayName((row as any)?.personal_data),
    };
  }
  return null;
};

const maybeDispatchProfileRecommendationNotification = async ({
  viewerIdRaw,
  pageRaw,
  rowsRaw,
}: {
  viewerIdRaw: any;
  pageRaw: any;
  rowsRaw: any[];
}) => {
  if (!PROFILE_RECOMMENDATION_PUSH_ENABLED) return;

  const viewerId = Number(viewerIdRaw);
  if (!Number.isFinite(viewerId) || viewerId <= 0) return;

  const page = Number(pageRaw);
  if (!Number.isFinite(page) || page !== 0) return;

  const rows = Array.isArray(rowsRaw) ? rowsRaw : [];
  if (!rows.length) return;

  const sinceDate = new Date(
    Date.now() - PROFILE_RECOMMENDATION_WINDOW_HOURS * 60 * 60 * 1000
  );
  const alreadySent = await hasRecentProfileRecommendationNotification({
    userId: viewerId,
    sinceDate,
  });
  if (alreadySent) return;

  const candidate = await pickRecommendationCandidate(viewerId, rows);
  if (!candidate) return;

  const message = `${PROFILE_RECOMMENDATION_MESSAGE_PREFIX} ${candidate.recommendedUserName}`;
  await sendNotification({
    userId: viewerId,
    interactorId: candidate.recommendedUserId,
    followerId: candidate.recommendedUserId,
    type: "profile_recommendation",
    message,
    senderName: "Minhoo",
    deeplink: `profile/${candidate.recommendedUserId}`,
  });
};

export const workers = async (req: Request, res: Response) => {
  try {
    setPrivateNoStore(res);
    const page = Math.max(0, Number((req.query as any)?.page ?? 0) || 0);
    const size = Math.min(Math.max(Number((req.query as any)?.size ?? 20) || 20, 1), 20);
    const workers: any = await repository.workers(page, size, req.userId, {
      sessionKey: toSessionKey(req),
    });
    const rows = Array.isArray(workers?.rows) ? workers.rows.slice(0, size) : [];
    await attachRelationshipsToWorkers(req.userId, rows);

    // Non-blocking: recommendation push should never slow down feed response.
    void maybeDispatchProfileRecommendationNotification({
      viewerIdRaw: req.userId,
      pageRaw: page,
      rowsRaw: rows,
    }).catch((error) => {
      console.log("[worker][recommendation_notification] skipped", error);
    });

    return formatResponse({
      res: res,
      success: true,
      body: {
        page: +page,
        size: +size,
        count: workers.count,
        workers: rows,
      },
    });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};

export const worker = async (req: Request, res: Response) => {
  const { id } = req.params;

  try {
    setPrivateNoStore(res);
    const worker: any = await repository.worker(id ?? req.userId, req.userId);
    attachAvatarAliases(worker);
    attachAvatarAliases((worker as any)?.personal_data);
    let counts: { followersCount: number; followingCount: number } | null = null;

    const targetUserId = Number((worker as any)?.userId ?? (worker as any)?.personal_data?.id);
    if (Number.isFinite(targetUserId) && targetUserId > 0) {
      const [resolvedCounts, relationship] = await Promise.all([
        followerRepo.getCounts(targetUserId),
        followerRepo.getRelationship(req.userId, targetUserId),
      ]);
      counts = resolvedCounts;
      attachFollowCountAliases(worker, counts.followersCount, counts.followingCount);
      attachFollowCountAliases(
        (worker as any)?.personal_data,
        counts.followersCount,
        counts.followingCount
      );
      attachRelationshipAliases(worker, relationship);
      attachRelationshipAliases((worker as any)?.personal_data, relationship);
    }

    return formatResponse({
      res: res,
      success: true,
      body: {
        worker: worker,
        counts: counts
          ? {
              followersCount: counts.followersCount,
              followingCount: counts.followingCount,
              followers_count: counts.followersCount,
              followings_count: counts.followingCount,
              following_count: counts.followingCount,
            }
          : null,
      },
    });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};

export const ids = async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const ids: any = await repository.tokensByNewService(id, req.userId);
    return formatResponse({
      res: res,
      success: true,
      body: {
        ids: ids,
      },
    });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};
