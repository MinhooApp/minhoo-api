import {
  Request,
  Response,
  formatResponse,
  repository,
} from "../_module/module";
import crypto from "crypto";
import * as savedRepository from "../../../repository/saved/saved_repository";

const isTruthy = (value: any) => {
  const v = String(value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
};

const shouldLogFindProfile = () => isTruthy(process.env.FIND_RANKING_PROFILE);
const nowMs = () => Number(process.hrtime.bigint()) / 1_000_000;
const round3 = (value: number) => Math.round(Number(value) * 1000) / 1000;

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
    return;
  }
  post.is_saved = isSaved;
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
    const { page = 0, size = 10 } = req.query;
    const posts = await repository.gets(page, size, req.userId, {
      sessionKey: toSessionKey(req),
    });
    await attachSavedFlags(req.userId, posts.rows);
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

    return formatResponse({
      res: res,
      success: true,
      body: {
        page: +page,
        size: +size,
        count: posts.count,
        posts: posts.rows,
      },
    });
  } catch (error) {
    return formatResponse({ res: res, success: false, message: error });
  }
};

export const getsSuggested = async (req: Request, res: Response) => {
  try {
    const startedAtMs = nowMs();
    const { page = 0, size = 10 } = req.query;
    const posts = await repository.getsSuggested(page, size, req.userId, {
      sessionKey: toSessionKey(req),
    });
    await attachSavedFlags(req.userId, posts.rows);
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

    return formatResponse({
      res: res,
      success: true,
      body: {
        page: +page,
        size: +size,
        count: posts.count,
        posts: posts.rows,
      },
    });
  } catch (error) {
    return formatResponse({ res: res, success: false, message: error });
  }
};

export const get = async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const post = await repository.get(id, req.userId);
    if (post) {
      const postId = Number(post.id);
      const saveCount = normalizeCount((post as any)?.saves_count);
      setSavedCount(post, saveCount);

      const viewerId = normalizeUserId(req.userId);
      if (!viewerId) {
        setSavedFlag(post, false);
      } else {
        const isSaved = await savedRepository.isPostSavedByUser(
          viewerId,
          postId
        );
        setSavedFlag(post, isSaved);
      }
    }

    return formatResponse({ res: res, success: true, body: { post: post } });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};
