import {
  Request,
  Response,
  formatResponse,
  repository,
} from "../_module/module";
import crypto from "crypto";
import * as savedRepository from "../../../repository/saved/saved_repository";
import Like from "../../../_models/like/like";
import { isSummaryMode, toPostSummary } from "../../../libs/summary_response";
import * as userRepository from "../../../repository/user/user_repository";
import { AppLocale, resolveLocale } from "../../../libs/localization/locale";
import { formatRelativeTime } from "../../../libs/localization/relative_time";
import {
  loadFindSessionState,
  saveFindSessionState,
} from "../../../libs/cache/find_session_store";

const isTruthy = (value: any) => {
  const v = String(value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
};

const shouldLogFindProfile = () => isTruthy(process.env.FIND_RANKING_PROFILE);
const nowMs = () => Number(process.hrtime.bigint()) / 1_000_000;
const round3 = (value: number) => Math.round(Number(value) * 1000) / 1000;
const postSummaryCacheEnabled = !isTruthy(process.env.POST_SUMMARY_CACHE_DISABLED ?? "0");
const postSummaryCacheTtlSeconds = Math.max(
  15,
  Number(process.env.POST_SUMMARY_CACHE_TTL_SECONDS ?? 20) || 20
);

type PostSummaryCacheEntry = {
  cachedAtMs: number;
  body: any | null;
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

const buildPostSummaryCacheKey = (params: {
  variant: "feed" | "suggested";
  page: number;
  size: number;
  viewerId: number;
  sessionKey: string;
}) => {
  const sessionSuffix = params.sessionKey || "anonymous";
  return `summary:${params.variant}:v:${params.viewerId}:p:${params.page}:s:${params.size}:sk:${sessionSuffix}`;
};

const readPostSummaryCache = async (cacheKey: string): Promise<any | null> => {
  if (!postSummaryCacheEnabled || !cacheKey) return null;
  const loaded = await loadFindSessionState<PostSummaryCacheEntry>({
    scope: "post",
    sessionKey: cacheKey,
    ttlSeconds: postSummaryCacheTtlSeconds,
    initialState: {
      cachedAtMs: 0,
      body: null,
    },
  });
  const entry = loaded?.state;
  if (!entry?.body || !entry?.cachedAtMs) return null;
  if (Date.now() - Number(entry.cachedAtMs) > postSummaryCacheTtlSeconds * 1000) return null;
  return entry.body;
};

const writePostSummaryCache = async (cacheKey: string, body: any) => {
  if (!postSummaryCacheEnabled || !cacheKey) return;
  await saveFindSessionState<PostSummaryCacheEntry>({
    scope: "post",
    sessionKey: cacheKey,
    ttlSeconds: postSummaryCacheTtlSeconds,
    state: {
      cachedAtMs: Date.now(),
      body,
    },
  });
};

const normalizeUserId = (value: any): number | null => {
  const userId = Number(value);
  if (!Number.isFinite(userId) || userId <= 0) return null;
  return userId;
};

const normalizeCount = (value: any): number => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
};

const setSavedFlag = (post: any, isSaved: boolean) => {
  if (!post) return;
  if (typeof post.setDataValue === "function") {
    post.setDataValue("is_saved", isSaved);
    post.setDataValue("isSaved", isSaved);
    return;
  }
  post.is_saved = isSaved;
  post.isSaved = isSaved;
};

const setSavedCount = (post: any, count: number) => {
  if (!post) return;
  if (typeof post.setDataValue === "function") {
    post.setDataValue("saved_count", count);
    post.setDataValue("savedCount", count);
    return;
  }
  post.saved_count = count;
  post.savedCount = count;
};

const setLikedFlag = (post: any, isLiked: boolean) => {
  if (!post) return;
  if (typeof post.setDataValue === "function") {
    post.setDataValue("is_liked", isLiked);
    post.setDataValue("isLiked", isLiked);
    post.setDataValue("isLike", isLiked);
    post.setDataValue("is_like", isLiked);
    post.setDataValue("liked", isLiked);
    post.setDataValue("is_starred", isLiked);
    post.setDataValue("isStarred", isLiked);
    post.setDataValue("starred", isLiked);
    return;
  }
  post.is_liked = isLiked;
  post.isLiked = isLiked;
  post.isLike = isLiked;
  post.is_like = isLiked;
  post.liked = isLiked;
  post.is_starred = isLiked;
  post.isStarred = isLiked;
  post.starred = isLiked;
};

const setValue = (target: any, key: string, value: any) => {
  if (!target) return;
  if (typeof target.setDataValue === "function") {
    target.setDataValue(key, value);
    return;
  }
  target[key] = value;
};

const applyRelativeToComment = (comment: any, locale: AppLocale) => {
  if (!comment) return;
  const referenceDate =
    (comment as any)?.created_date ??
    (comment as any)?.createdAt ??
    (comment as any)?.created_at ??
    null;
  const relativeTime = formatRelativeTime(referenceDate, locale);
  if (!relativeTime) return;
  setValue(comment, "relativeTime", relativeTime);
  setValue(comment, "relative_time", relativeTime);
};

const applyRelativeToPostComments = (post: any, locale: AppLocale) => {
  if (!post) return;

  const comments =
    Array.isArray((post as any)?.comments) ? (post as any).comments : [];
  if (!Array.isArray(comments) || comments.length === 0) return;

  comments.forEach((comment: any) => applyRelativeToComment(comment, locale));
  setValue(post, "comments", comments);
};

const applyRelativeToPostsComments = (posts: any[], locale: AppLocale) => {
  if (!Array.isArray(posts)) return;
  posts.forEach((post: any) => applyRelativeToPostComments(post, locale));
};

const resolveRequestLocale = async (req: Request): Promise<AppLocale> => {
  const preferredLanguage =
    (req.query as any)?.language ??
    (req.query as any)?.lang ??
    req.header("x-app-language") ??
    req.header("x-language") ??
    req.header("x-lang");
  const acceptLanguage = req.header("accept-language");
  const userId = normalizeUserId(req.userId);

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

const attachSavedFlags = async (viewerIdRaw: any, posts: any[]) => {
  if (!Array.isArray(posts) || !posts.length) return;

  const viewerId = normalizeUserId(viewerIdRaw);
  const postIds = posts
    .map((post: any) => Number(post?.id))
    .filter((id: number) => Number.isFinite(id) && id > 0);

  posts.forEach((post: any) => {
    setSavedCount(post, normalizeCount((post as any)?.saves_count));
  });

  if (!viewerId) {
    posts.forEach((post: any) => setSavedFlag(post, false));
    return;
  }

  const savedSet = await savedRepository.getSavedPostIdSet(viewerId, postIds);
  posts.forEach((post: any) => {
    setSavedFlag(post, savedSet.has(Number(post?.id)));
  });
};

export const gets = async (req: Request, res: Response) => {
  try {
    const startedAtMs = nowMs();
    const page = Math.max(0, Number(req.query.page ?? 0) || 0);
    const size = Math.min(Math.max(Number(req.query.size ?? 10) || 10, 1), 20);
    const summary = isSummaryMode((req.query as any)?.summary);
    const sessionKey = toSessionKey(req);
    const viewerId = Number(req.userId ?? 0) || 0;
    if (summary) {
      const cacheKey = buildPostSummaryCacheKey({
        variant: "feed",
        page,
        size,
        viewerId,
        sessionKey,
      });
      const cachedBody = await readPostSummaryCache(cacheKey);
      if (cachedBody) {
        res.set("X-Summary-Cache", "hit");
        return formatResponse({ res, success: true, body: cachedBody });
      }
      res.set("X-Summary-Cache", "miss");
    }
    const posts = await (summary ? repository.getsSummary : repository.gets)(page, size, req.userId, {
      sessionKey,
    });
    await attachSavedFlags(req.userId, posts.rows);
    const locale = await resolveRequestLocale(req);
    if (!summary) {
      applyRelativeToPostsComments(posts.rows, locale);
    }
    if (shouldLogFindProfile()) {
      console.log(
        `[find/post/endpoint] ${JSON.stringify({
          endpoint: "/api/v1/post",
          page: Number(page) || 0,
          size: Number(size) || 10,
          viewerId: Number(req.userId ?? 0) || null,
          totalCount: Number(posts?.count ?? 0),
          served: Array.isArray(posts?.rows) ? posts.rows.length : 0,
          totalLatencyMs: round3(nowMs() - startedAtMs),
        })}`
      );
    }

    const responseBody = {
      page,
      size,
      count: posts.count,
      posts: summary
        ? (posts.rows ?? []).map((post: any) => toPostSummary(post, req.userId))
        : posts.rows,
    };

    if (summary) {
      const cacheKey = buildPostSummaryCacheKey({
        variant: "feed",
        page,
        size,
        viewerId,
        sessionKey,
      });
      await writePostSummaryCache(cacheKey, responseBody);
    }

    return formatResponse({
      res: res,
      success: true,
      body: responseBody,
    });
  } catch (error) {
    return formatResponse({ res: res, success: false, message: error });
  }
};

export const getsSuggested = async (req: Request, res: Response) => {
  try {
    const startedAtMs = nowMs();
    const page = Math.max(0, Number(req.query.page ?? 0) || 0);
    const size = Math.min(Math.max(Number(req.query.size ?? 10) || 10, 1), 20);
    const summary = isSummaryMode((req.query as any)?.summary);
    const sessionKey = toSessionKey(req);
    const viewerId = Number(req.userId ?? 0) || 0;
    if (summary) {
      const cacheKey = buildPostSummaryCacheKey({
        variant: "suggested",
        page,
        size,
        viewerId,
        sessionKey,
      });
      const cachedBody = await readPostSummaryCache(cacheKey);
      if (cachedBody) {
        res.set("X-Summary-Cache", "hit");
        return formatResponse({ res, success: true, body: cachedBody });
      }
      res.set("X-Summary-Cache", "miss");
    }
    const posts = await (summary ? repository.getsSuggestedSummary : repository.getsSuggested)(
      page,
      size,
      req.userId,
      {
      sessionKey,
      }
    );
    await attachSavedFlags(req.userId, posts.rows);
    const locale = await resolveRequestLocale(req);
    if (!summary) {
      applyRelativeToPostsComments(posts.rows, locale);
    }
    if (shouldLogFindProfile()) {
      console.log(
        `[find/post/endpoint] ${JSON.stringify({
          endpoint: "/api/v1/post/suggested",
          page: Number(page) || 0,
          size: Number(size) || 10,
          viewerId: Number(req.userId ?? 0) || null,
          totalCount: Number(posts?.count ?? 0),
          served: Array.isArray(posts?.rows) ? posts.rows.length : 0,
          totalLatencyMs: round3(nowMs() - startedAtMs),
        })}`
      );
    }

    const responseBody = {
      page,
      size,
      count: posts.count,
      posts: summary
        ? (posts.rows ?? []).map((post: any) => toPostSummary(post, req.userId))
        : posts.rows,
    };

    if (summary) {
      const cacheKey = buildPostSummaryCacheKey({
        variant: "suggested",
        page,
        size,
        viewerId,
        sessionKey,
      });
      await writePostSummaryCache(cacheKey, responseBody);
    }

    return formatResponse({
      res: res,
      success: true,
      body: responseBody,
    });
  } catch (error) {
    return formatResponse({ res: res, success: false, message: error });
  }
};

export const get = async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const locale = await resolveRequestLocale(req);
    const post = await repository.get(id, req.userId);
    if (post) {
      const postId = Number(post.id);
      const saveCount = normalizeCount((post as any)?.saves_count);
      setSavedCount(post, saveCount);

      const viewerId = normalizeUserId(req.userId);
      if (!viewerId) {
        setSavedFlag(post, false);
        setLikedFlag(post, false);
      } else {
        const [isSaved, likeRow] = await Promise.all([
          savedRepository.isPostSavedByUser(viewerId, postId),
          Like.findOne({
            where: {
              userId: viewerId,
              postId,
            },
            attributes: ["id"],
          }),
        ]);
        setSavedFlag(post, isSaved);
        setLikedFlag(post, Boolean(likeRow));
      }

      applyRelativeToPostComments(post, locale);
    }

    return formatResponse({ res: res, success: true, body: { post: post } });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};
