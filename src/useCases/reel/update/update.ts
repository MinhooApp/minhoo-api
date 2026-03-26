import crypto from "crypto";
import {
  Request,
  Response,
  formatResponse,
  repository,
  socket,
  sendNotification,
} from "../_module/module";

const toSessionKey = (req: Request) => {
  const bodyKey = String((req.body as any)?.session_key ?? (req.body as any)?.sessionKey ?? "").trim();
  const queryKey = String((req.query as any)?.session_key ?? (req.query as any)?.sessionKey ?? "").trim();
  const headerKey = String(req.header("x-session-key") ?? "").trim();

  const explicit = bodyKey || queryKey || headerKey;
  if (explicit) return explicit.slice(0, 128);

  const ip = String(req.ip ?? "").trim();
  const ua = String(req.header("user-agent") ?? "").trim();
  if (!ip && !ua) return "";

  return crypto
    .createHash("sha1")
    .update(`${ip}|${ua}`)
    .digest("hex")
    .slice(0, 40);
};

const getReelOwnerId = (reel: any): number => {
  const ownerId = Number(reel?.user?.id ?? reel?.userId ?? reel?.user_id ?? 0);
  if (!Number.isFinite(ownerId) || ownerId <= 0) return 0;
  return ownerId;
};

const toPlainObject = (value: any): any => {
  if (!value) return value;
  if (typeof value.toJSON === "function") return value.toJSON();
  if (value.dataValues && typeof value.dataValues === "object") {
    return { ...value.dataValues };
  }
  return value;
};

const toIsoOrNull = (value: any): string | null => {
  if (value === undefined || value === null || value === "") return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

const parseBoolOrNull = (value: any): boolean | null => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["1", "true", "yes"].includes(v)) return true;
    if (["0", "false", "no"].includes(v)) return false;
  }
  return null;
};

const normalizeReelFreshnessState = (rawReel: any) => {
  const reel = toPlainObject(rawReel) ?? {};
  const ringUntilIso =
    toIsoOrNull(reel?.ring_until ?? reel?.ringUntil ?? reel?.new_until ?? reel?.newUntil) ??
    null;
  const explicitRingActive = parseBoolOrNull(reel?.ring_active ?? reel?.ringActive);
  const explicitIsNew = parseBoolOrNull(reel?.is_new ?? reel?.isNew);
  const fallbackRingActive =
    ringUntilIso !== null ? new Date(ringUntilIso).getTime() > Date.now() : false;

  const ringActive = explicitRingActive ?? explicitIsNew ?? fallbackRingActive;
  const ringUntil =
    ringUntilIso ??
    toIsoOrNull(reel?.new_until ?? reel?.newUntil) ??
    null;
  const isNew = explicitIsNew ?? ringActive;
  const newUntil =
    toIsoOrNull(reel?.new_until ?? reel?.newUntil ?? ringUntil) ??
    ringUntil;

  return {
    ringActive,
    ringUntil,
    isNew,
    newUntil,
  };
};

const buildReelUpdatedRealtimePayload = (
  rawReel: any,
  fallbackOwnerIdRaw: any,
  actorUserIdRaw: any
) => {
  const reel = toPlainObject(rawReel) ?? {};
  const reelId = Number(reel?.id ?? reel?.reelId ?? reel?.reel_id ?? 0);
  if (!Number.isFinite(reelId) || reelId <= 0) return null;

  const ownerId = Number(
    reel?.user?.id ?? reel?.userId ?? reel?.user_id ?? fallbackOwnerIdRaw ?? 0
  );
  const actorUserId = Number(actorUserIdRaw ?? 0);
  const freshness = normalizeReelFreshnessState(reel);
  const normalizedReel = {
    ...reel,
    ring_active: freshness.ringActive,
    ringActive: freshness.ringActive,
    ring_until: freshness.ringUntil,
    ringUntil: freshness.ringUntil,
    is_new: freshness.isNew,
    isNew: freshness.isNew,
    new_until: freshness.newUntil,
    newUntil: freshness.newUntil,
  };

  return {
    action: "updated",
    reelId,
    reel_id: reelId,
    ownerId: Number.isFinite(ownerId) && ownerId > 0 ? ownerId : 0,
    owner_id: Number.isFinite(ownerId) && ownerId > 0 ? ownerId : 0,
    actorUserId: Number.isFinite(actorUserId) && actorUserId > 0 ? actorUserId : 0,
    actor_user_id: Number.isFinite(actorUserId) && actorUserId > 0 ? actorUserId : 0,
    ring_active: freshness.ringActive,
    ringActive: freshness.ringActive,
    ring_until: freshness.ringUntil,
    ringUntil: freshness.ringUntil,
    is_new: freshness.isNew,
    isNew: freshness.isNew,
    new_until: freshness.newUntil,
    newUntil: freshness.newUntil,
    reel: normalizedReel,
  };
};

const emitReelUpdatedRealtime = (
  rawReel: any,
  fallbackOwnerIdRaw: any,
  actorUserIdRaw: any
) => {
  const payload = buildReelUpdatedRealtimePayload(
    rawReel,
    fallbackOwnerIdRaw,
    actorUserIdRaw
  );
  if (!payload) return;
  socket.emit("reel/updated", payload);
};

export const toggle_reel_star = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await repository.toggleStar(req.userId, id);
    const reelId = Number(id);

    if (result.notFound) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "reel not found",
      });
    }

    const ownerUserId = getReelOwnerId((result as any)?.reel);
    const actorUserId = Number(req.userId ?? 0);
    const shouldNotifyOwner =
      Boolean((result as any)?.starred) &&
      ownerUserId > 0 &&
      actorUserId > 0 &&
      ownerUserId !== actorUserId;

    if (shouldNotifyOwner) {
      try {
        await sendNotification({
          userId: ownerUserId,
          interactorId: actorUserId,
          reelId: Number(id),
          type: "like",
          message: "Has starred your Orbit.",
          deeplink: `orbit/${Number(id)}`,
        });
      } catch (notifyError) {
        console.error(
          `[reel_star] notification failed ownerId=${ownerUserId} interactorId=${actorUserId} reelId=${Number(
            id
          )}`,
          notifyError
        );
      }
    }
    emitReelUpdatedRealtime(
      (result as any)?.reel,
      ownerUserId || actorUserId,
      actorUserId
    );
    console.log(
      `[reel_star_action] userId=${actorUserId} reelId=${reelId} starred=${Boolean(
        (result as any)?.starred
      )} likesCount=${Number((result as any)?.likes_count ?? 0)}`
    );

    return formatResponse({
      res,
      success: true,
      body: {
        reelId,
        starred: result.starred,
        liked: result.starred,
        likes_count: result.likes_count,
        likesCount: result.likes_count,
        reel: result.reel,
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};

export const save_reel = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await repository.saveReel(req.userId, id);
    const reelId = Number(id);

    if (result.notFound) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "reel not found",
      });
    }

    const ownerUserId = getReelOwnerId((result as any)?.reel);
    const actorUserId = Number(req.userId ?? 0);
    const shouldNotifyOwner =
      Boolean((result as any)?.created) &&
      ownerUserId > 0 &&
      actorUserId > 0 &&
      ownerUserId !== actorUserId;

    if (shouldNotifyOwner) {
      try {
        await sendNotification({
          userId: ownerUserId,
          interactorId: actorUserId,
          reelId: Number(id),
          type: "like",
          message: "Has saved your Orbit.",
          deeplink: `orbit/${Number(id)}`,
        });
      } catch (notifyError) {
        console.error(
          `[reel_save] notification failed ownerId=${ownerUserId} interactorId=${actorUserId} reelId=${Number(
            id
          )}`,
          notifyError
        );
      }
    }
    emitReelUpdatedRealtime(
      (result as any)?.reel,
      ownerUserId || actorUserId,
      actorUserId
    );
    console.log(
      `[reel_save_action] userId=${actorUserId} reelId=${reelId} saved=true savesCount=${Number(
        (result as any)?.saves_count ?? 0
      )}`
    );

    return formatResponse({
      res,
      success: true,
      body: {
        reelId,
        saved: true,
        created: result.created,
        saves_count: result.saves_count,
        savesCount: result.saves_count,
        reel: result.reel,
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};

export const unsave_reel = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await repository.unsaveReel(req.userId, id);
    const reelId = Number(id);

    if (result.notFound) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "reel not found",
      });
    }
    emitReelUpdatedRealtime((result as any)?.reel, req.userId, req.userId);
    console.log(
      `[reel_unsave_action] userId=${Number(req.userId ?? 0)} reelId=${reelId} saved=false savesCount=${Number(
        (result as any)?.saves_count ?? 0
      )}`
    );

    return formatResponse({
      res,
      success: true,
      body: {
        reelId,
        saved: false,
        removed: result.removed,
        saves_count: result.saves_count,
        savesCount: result.saves_count,
        reel: result.reel,
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};

export const record_reel_view = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const sessionKey = toSessionKey(req);

    const result = await repository.recordView(id, (req as any).userId, sessionKey);

    if (!result.found) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "reel not found",
      });
    }
    emitReelUpdatedRealtime((result as any)?.reel, req.userId, req.userId);

    return formatResponse({
      res,
      success: true,
      body: {
        reelId: Number(id),
        counted: result.counted,
        views_count: Number((result.reel as any)?.views_count ?? 0),
        viewsCount: Number((result.reel as any)?.views_count ?? 0),
        reel: result.reel,
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};

export const share_reel = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await repository.shareReel(id, (req as any).userId);

    if (!result.found) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "reel not found",
      });
    }
    emitReelUpdatedRealtime((result as any)?.reel, req.userId, req.userId);

    return formatResponse({
      res,
      success: true,
      body: {
        reelId: Number(id),
        shares_count: Number((result.reel as any)?.shares_count ?? 0),
        sharesCount: Number((result.reel as any)?.shares_count ?? 0),
        reel: result.reel,
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};
