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
    const { page = 0, size = 5 } = req.query;
    const workers: any = await repository.workers(page, size, req.userId, {
      sessionKey: toSessionKey(req),
    });

    // Non-blocking: recommendation push should never slow down feed response.
    void maybeDispatchProfileRecommendationNotification({
      viewerIdRaw: req.userId,
      pageRaw: page,
      rowsRaw: workers?.rows ?? [],
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
        workers: workers.rows,
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
    const worker: any = await repository.worker(id ?? req.userId, req.userId);
    let counts: { followersCount: number; followingCount: number } | null = null;

    const targetUserId = Number((worker as any)?.userId ?? (worker as any)?.personal_data?.id);
    if (Number.isFinite(targetUserId) && targetUserId > 0) {
      counts = await followerRepo.getCounts(targetUserId);
      attachFollowCountAliases(worker, counts.followersCount, counts.followingCount);
      attachFollowCountAliases(
        (worker as any)?.personal_data,
        counts.followersCount,
        counts.followingCount
      );
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
