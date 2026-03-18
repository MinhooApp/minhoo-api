import { Request, Response, formatResponse, repository } from "../_module/module";
import crypto from "crypto";
import { isSummaryMode, toReelSummary } from "../../../libs/summary_response";
import * as userRepository from "../../../repository/user/user_repository";
import { AppLocale, resolveLocale } from "../../../libs/localization/locale";
import { formatRelativeTime } from "../../../libs/localization/relative_time";

const isTruthy = (value: any) => {
  const v = String(value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
};

const shouldLogFindProfile = () => isTruthy(process.env.FIND_RANKING_PROFILE);
const nowMs = () => Number(process.hrtime.bigint()) / 1_000_000;
const round3 = (value: number) => Math.round(Number(value) * 1000) / 1000;

const normalizeUserId = (value: any): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
};

const setValue = (target: any, key: string, value: any) => {
  if (!target) return;
  if (typeof target.setDataValue === "function") {
    target.setDataValue(key, value);
    return;
  }
  target[key] = value;
};

const applyRelativeToReelComment = (comment: any, locale: AppLocale) => {
  if (!comment) return;
  const referenceDate =
    (comment as any)?.createdAt ??
    (comment as any)?.created_at ??
    null;
  const relativeTime = formatRelativeTime(referenceDate, locale);
  if (!relativeTime) return;
  setValue(comment, "relativeTime", relativeTime);
  setValue(comment, "relative_time", relativeTime);
};

const resolveRequestLocale = async (req: Request): Promise<AppLocale> => {
  const preferredLanguage =
    (req.query as any)?.language ??
    (req.query as any)?.lang ??
    req.header("x-app-language") ??
    req.header("x-language") ??
    req.header("x-lang");
  const acceptLanguage = req.header("accept-language");
  const userId = normalizeUserId((req as any)?.userId);

  if (!userId) {
    return resolveLocale({
      preferredLanguage,
      acceptLanguage,
    });
  }

  try {
    const pushSettings = await userRepository.getPushSettings(userId);
    return resolveLocale({
      preferredLanguage,
      acceptLanguage,
      storedLanguage: pushSettings?.language,
      storedLanguageCodes: pushSettings?.language_codes,
      storedLanguageNames: pushSettings?.language_names,
    });
  } catch {
    return resolveLocale({
      preferredLanguage,
      acceptLanguage,
    });
  }
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

const shouldLoopFeed = (value: any) => {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
};

const fetchFeedWithLoopFallback = async ({
  page,
  size,
  viewerId,
  suggested,
  summary,
  sessionKey,
  allowLoop,
}: {
  page: number;
  size: number;
  viewerId: any;
  suggested: boolean;
  summary: boolean;
  sessionKey: string;
  allowLoop: boolean;
}) => {
  const requestedPage = page;
  let data = await repository.listFeed(page, size, viewerId, suggested, {
    sessionKey,
    summary,
  });
  let looped = false;

  if (allowLoop && page > 0) {
    const totalCount = Number(data?.count ?? 0) || 0;
    if (totalCount > 0) {
      const totalPages = Math.max(1, Math.ceil(totalCount / Math.max(1, size)));
      const effectivePage = page % totalPages;

      if (effectivePage !== page) {
        data = await repository.listFeed(effectivePage, size, viewerId, suggested, {
          sessionKey,
          summary,
        });
        looped = true;
      } else if (!Array.isArray(data?.rows) || data.rows.length === 0) {
        data = await repository.listFeed(0, size, viewerId, suggested, {
          sessionKey,
          summary,
        });
        looped = true;
      }
    }
  }

  return { data, requestedPage, looped };
};

export const reels_feed = async (req: Request, res: Response) => {
  try {
    const startedAtMs = nowMs();
    const page = Math.max(0, Number((req.query as any)?.page ?? 0) || 0);
    const size = Math.min(Math.max(Number((req.query as any)?.size ?? 15) || 15, 1), 20);
    const summary = isSummaryMode((req.query as any)?.summary);
    const allowLoop = shouldLoopFeed(
      (req.query as any)?.loop ?? (req.query as any)?.repeat
    );
    const { data, requestedPage, looped } = await fetchFeedWithLoopFallback({
      page,
      size,
      viewerId: (req as any).userId,
      suggested: false,
      summary,
      sessionKey: toSessionKey(req),
      allowLoop,
    });
    if (shouldLogFindProfile()) {
      console.log(
        `[find/orbit/endpoint] ${JSON.stringify({
          endpoint: "/api/v1/reel",
          page: Number(requestedPage) || 0,
          size: Number(size) || 15,
          viewerId: Number((req as any).userId ?? 0) || null,
          totalCount: Number(data?.count ?? 0),
          served: Array.isArray(data?.rows) ? data.rows.length : 0,
          looped,
          totalLatencyMs: round3(nowMs() - startedAtMs),
        })}`
      );
    }

    return formatResponse({
      res,
      success: true,
      body: {
        page: data.page,
        requestedPage,
        size: data.size,
        count: data.count,
        looped,
        reels: summary ? (data.rows ?? []).map((row: any) => toReelSummary(row)) : data.rows,
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};

export const reels_suggested = async (req: Request, res: Response) => {
  try {
    const startedAtMs = nowMs();
    const page = Math.max(0, Number((req.query as any)?.page ?? 0) || 0);
    const size = Math.min(Math.max(Number((req.query as any)?.size ?? 15) || 15, 1), 20);
    const summary = isSummaryMode((req.query as any)?.summary);
    const allowLoop = shouldLoopFeed(
      (req.query as any)?.loop ?? (req.query as any)?.repeat
    );
    const { data, requestedPage, looped } = await fetchFeedWithLoopFallback({
      page,
      size,
      viewerId: (req as any).userId,
      suggested: true,
      summary,
      sessionKey: toSessionKey(req),
      allowLoop,
    });
    if (shouldLogFindProfile()) {
      console.log(
        `[find/orbit/endpoint] ${JSON.stringify({
          endpoint: "/api/v1/reel/suggested",
          page: Number(requestedPage) || 0,
          size: Number(size) || 15,
          viewerId: Number((req as any).userId ?? 0) || null,
          totalCount: Number(data?.count ?? 0),
          served: Array.isArray(data?.rows) ? data.rows.length : 0,
          looped,
          totalLatencyMs: round3(nowMs() - startedAtMs),
        })}`
      );
    }

    return formatResponse({
      res,
      success: true,
      body: {
        page: data.page,
        requestedPage,
        size: data.size,
        count: data.count,
        looped,
        reels: summary ? (data.rows ?? []).map((row: any) => toReelSummary(row)) : data.rows,
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};

export const my_reels = async (req: Request, res: Response) => {
  try {
    const page = Math.max(0, Number((req.query as any)?.page ?? 0) || 0);
    const size = Math.min(Math.max(Number((req.query as any)?.size ?? 15) || 15, 1), 20);
    const data = await repository.listMine(req.userId, page, size);

    return formatResponse({
      res,
      success: true,
      body: {
        page: data.page,
        size: data.size,
        count: data.count,
        reels: data.rows,
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};

export const user_reels = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const page = Math.max(0, Number((req.query as any)?.page ?? 0) || 0);
    const size = Math.min(Math.max(Number((req.query as any)?.size ?? 15) || 15, 1), 20);
    const data = await repository.listByUser(id, page, size, (req as any).userId);

    if (data.notFound) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "user not found",
      });
    }

    return formatResponse({
      res,
      success: true,
      body: {
        page: data.page,
        size: data.size,
        count: data.count,
        reels: data.rows,
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};

export const reels_saved = async (req: Request, res: Response) => {
  try {
    const page = Math.max(0, Number((req.query as any)?.page ?? 0) || 0);
    const size = Math.min(Math.max(Number((req.query as any)?.size ?? 15) || 15, 1), 20);
    const data = await repository.listSaved(req.userId, page, size);

    return formatResponse({
      res,
      success: true,
      body: {
        page: data.page,
        size: data.size,
        count: data.count,
        reels: data.rows,
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};

export const reel_by_id = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const reel = await repository.getById(id, (req as any).userId);

    if (!reel) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "reel not found",
      });
    }

    return formatResponse({
      res,
      success: true,
      body: { reel },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};

export const reel_comments = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const page = Math.max(0, Number((req.query as any)?.page ?? 0) || 0);
    const size = Math.min(Math.max(Number((req.query as any)?.size ?? 20) || 20, 1), 20);
    const locale = await resolveRequestLocale(req);
    const data = await repository.listComments(id, page, size);

    if (data.notFound) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "reel not found",
      });
    }

    return formatResponse({
      res,
      success: true,
      body: {
        page: data.page,
        size: data.size,
        count: data.count,
        comments: (data.rows ?? []).map((comment: any) => {
          applyRelativeToReelComment(comment, locale);
          return comment;
        }),
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};

export const reel_download = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const reel = await repository.getById(id, (req as any).userId);

    if (!reel) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "reel not found",
      });
    }

    const isOwner = Number((reel as any).userId) === Number((req as any).userId || 0);
    if (!(reel as any).allow_download && !isOwner) {
      return formatResponse({
        res,
        success: false,
        code: 403,
        message: "download not allowed",
      });
    }

    const downloadUrl = repository.getDownloadUrl(reel);
    if (!downloadUrl) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "download url not available",
      });
    }

    const shouldRedirect = String((req.query as any)?.redirect ?? "0") === "1";
    if (shouldRedirect) {
      return res.redirect(downloadUrl);
    }

    return formatResponse({
      res,
      success: true,
      body: {
        reelId: Number((reel as any).id),
        download_url: downloadUrl,
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};
