import {
  Request,
  Response,
  formatResponse,
  repository,
  postRepository,
  reelRepository,
} from "../_module/module";
import {
  HashtagErrorCode,
  isHashtagValidationError,
  normalizePathTagOrThrow,
  sendHashtagError,
} from "../../../libs/hashtags";
import {
  HashtagFeedCursor,
  HashtagFeedSort,
  HashtagFeedType,
  TaggedContentRef,
} from "../../../repository/hashtag/hashtag_repository";
import { sendUnifiedSuccess } from "../../../libs/unified_response";

const parsePositiveInt = (value: any, fallback: number, max: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.max(1, Math.floor(parsed)));
};

const parseNonNegativeInt = (value: any, fallback: number, max: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(max, Math.max(0, Math.floor(parsed)));
};

const parseFeedTypeOrThrow = (value: any): HashtagFeedType => {
  const normalized = String(value ?? "all")
    .trim()
    .toLowerCase();
  if (normalized === "all") return "all";
  if (normalized === "posts" || normalized === "post") return "posts";
  if (normalized === "orbits" || normalized === "orbit" || normalized === "reel" || normalized === "reels") return "orbits";
  throw {
    code: "HASHTAG_INVALID" as HashtagErrorCode,
    status: 400,
    message: "type must be all|posts|orbits (aliases: post|orbit|reel)",
  };
};

const parseFeedSortOrThrow = (value: any): HashtagFeedSort => {
  const normalized = String(value ?? "top")
    .trim()
    .toLowerCase();
  if (normalized === "top") return "top";
  if (normalized === "new" || normalized === "newest" || normalized === "recent") return "new";
  throw {
    code: "HASHTAG_INVALID" as HashtagErrorCode,
    status: 400,
    message: "sort must be top|new",
  };
};

const encodeCursor = (cursor: HashtagFeedCursor | null) => {
  if (!cursor) return null;
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
};

const decodeCursor = (value: any): HashtagFeedCursor | null => {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  try {
    const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
    const padded =
      normalized + (normalized.length % 4 ? "=".repeat(4 - (normalized.length % 4)) : "");
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(decoded);
    const mappingId = Number(parsed?.mappingId);
    const contentCreatedAtRaw = String(parsed?.contentCreatedAt ?? parsed?.createdAt ?? "").trim();
    if (!Number.isFinite(mappingId) || mappingId <= 0 || !contentCreatedAtRaw) return null;
    const contentCreatedAt = new Date(contentCreatedAtRaw);
    if (Number.isNaN(contentCreatedAt.getTime())) return null;

    const scoreRaw = Number(parsed?.score ?? 0);
    const score = Number.isFinite(scoreRaw) ? Math.max(0, Math.floor(scoreRaw)) : 0;
    const sortRaw = String(parsed?.sort ?? "")
      .trim()
      .toLowerCase();
    const typeRaw = String(parsed?.type ?? "")
      .trim()
      .toLowerCase();
    const tagRaw = String(parsed?.tag ?? "")
      .trim()
      .toLowerCase()
      .replace(/^#+/, "");
    return {
      mappingId: Math.floor(mappingId),
      contentCreatedAt: contentCreatedAt.toISOString(),
      score,
      sort: sortRaw === "new" || sortRaw === "top" ? (sortRaw as HashtagFeedSort) : undefined,
      type:
        typeRaw === "all" || typeRaw === "posts" || typeRaw === "orbits"
          ? (typeRaw as HashtagFeedType)
          : undefined,
      tag: tagRaw || undefined,
    };
  } catch {
    return null;
  }
};

const parseWindowHours = (value: any) => {
  const normalized = String(value ?? "24h")
    .trim()
    .toLowerCase();
  const match = normalized.match(/^(\d+)(h|d)$/);
  if (!match) {
    return { hours: 24, label: "24h" };
  }
  const amount = Math.max(1, Number(match[1]) || 24);
  const unit = match[2] === "d" ? "d" : "h";
  const hours = unit === "d" ? amount * 24 : amount;
  const clampedHours = Math.max(1, Math.min(hours, 24 * 30));
  const label = unit === "d" ? `${Math.floor(clampedHours / 24)}d` : `${clampedHours}h`;
  return { hours: clampedHours, label };
};

const hydrateTaggedRef = async (ref: TaggedContentRef, viewerIdRaw: any) => {
  const createdAt = String(ref.contentCreatedAt ?? ref.createdAt ?? "").trim();
  const likesCount = Math.max(0, Number(ref.likesCount ?? 0) || 0);
  const commentsCount = Math.max(0, Number(ref.commentsCount ?? 0) || 0);
  const score = Math.max(0, Number(ref.score ?? likesCount + commentsCount) || 0);

  if (ref.contentType === "post") {
    const post = await postRepository.get(ref.contentId, viewerIdRaw);
    if (!post) return null;
    return {
      type: "post",
      content_type: "post",
      id: ref.contentId,
      content_id: ref.contentId,
      created_at: createdAt,
      createdAt,
      likes_count: likesCount,
      comments_count: commentsCount,
      score,
      post,
    };
  }

  if (ref.contentType === "reel") {
    const orbit = await reelRepository.getById(ref.contentId, viewerIdRaw);
    if (!orbit) return null;
    return {
      type: "orbit",
      content_type: "orbit",
      id: ref.contentId,
      content_id: ref.contentId,
      created_at: createdAt,
      createdAt,
      likes_count: likesCount,
      comments_count: commentsCount,
      score,
      orbit,
    };
  }

  return null;
};

const sendCodedError = (
  res: Response,
  code: HashtagErrorCode,
  message: string,
  status: number
) => {
  return sendHashtagError(res, status, code, message);
};

export const hashtag_feed = async (req: Request, res: Response) => {
  try {
    const tag = normalizePathTagOrThrow(req.params.tag);
    const type = parseFeedTypeOrThrow((req.query as any)?.type);
    const sort = parseFeedSortOrThrow((req.query as any)?.sort);
    const size = parsePositiveInt((req.query as any)?.size, 20, 50);
    const rawCursor = (req.query as any)?.cursor;
    const initialCursor = decodeCursor(rawCursor);
    const pageProvided = (req.query as any)?.page !== undefined;
    const page = parseNonNegativeInt((req.query as any)?.page, 0, 100_000);
    const cursorProvided = String(rawCursor ?? "").trim().length > 0;

    if (cursorProvided && pageProvided) {
      return sendCodedError(
        res,
        "HASHTAG_INVALID",
        "use either cursor+size or page+size, not both",
        400
      );
    }

    if (cursorProvided && !initialCursor) {
      return sendCodedError(res, "HASHTAG_INVALID", "invalid cursor", 400);
    }
    if (initialCursor?.sort && initialCursor.sort !== sort) {
      return sendCodedError(
        res,
        "HASHTAG_INVALID",
        "cursor sort mismatch, request a fresh cursor for this sort",
        400
      );
    }
    if (initialCursor?.type && initialCursor.type !== type) {
      return sendCodedError(
        res,
        "HASHTAG_INVALID",
        "cursor type mismatch, request a fresh cursor for this type",
        400
      );
    }
    if (initialCursor?.tag && initialCursor.tag !== tag) {
      return sendCodedError(
        res,
        "HASHTAG_INVALID",
        "cursor tag mismatch, request a fresh cursor for this hashtag",
        400
      );
    }

    const existing = await repository.findHashtagByTag(tag);
    if (!existing) {
      return sendCodedError(res, "HASHTAG_NOT_FOUND", "hashtag not found", 404);
    }

    const items: any[] = [];
    const batchSize = Math.max(size * 3, 30);
    const maxBatches = 6;
    let cursor = initialCursor;
    let offset = pageProvided && !cursorProvided ? page * size : 0;
    let lastScanned: HashtagFeedCursor | null = null;
    let hasMore = false;

    for (let batch = 0; batch < maxBatches && items.length < size; batch += 1) {
      const result = await repository.listTaggedContentRefs({
        tag,
        type,
        sort,
        cursor: cursorProvided ? cursor : null,
        offset: cursorProvided ? undefined : offset,
        size: batchSize,
      });

      if (result.notFound) {
        return sendCodedError(res, "HASHTAG_NOT_FOUND", "hashtag not found", 404);
      }

      const refs = Array.isArray(result.rows) ? result.rows : [];
      if (!refs.length) break;

      const hydratedRows = await Promise.all(
        refs.map((ref) => hydrateTaggedRef(ref, (req as any)?.userId))
      );

      for (let index = 0; index < refs.length; index += 1) {
        const ref = refs[index];
        lastScanned = {
          contentCreatedAt: ref.contentCreatedAt ?? ref.createdAt,
          mappingId: ref.mappingId,
          score: Math.max(0, Number(ref.score ?? 0) || 0),
          sort,
          type,
          tag,
        };

        const item = hydratedRows[index];
        if (item) items.push(item);

        if (items.length >= size) {
          if (index < refs.length - 1) hasMore = true;
          break;
        }
      }

      if (items.length >= size) break;
      if (refs.length < batchSize) break;
      if (cursorProvided) {
        cursor = lastScanned;
      } else {
        offset += refs.length;
      }
    }

    if (!hasMore) {
      if (cursorProvided && lastScanned) {
        hasMore = await repository.hasMoreTaggedContentRefs({
          tag,
          type,
          sort,
          cursor: lastScanned,
        });
      } else {
        hasMore = await repository.hasMoreTaggedContentRefs({
          tag,
          type,
          sort,
          offset,
        });
      }
    }

    return sendUnifiedSuccess(res, {
      items: items.slice(0, size),
      users: [],
      count: Math.min(items.length, size),
      page: pageProvided ? page : 0,
      size,
      next_cursor: hasMore && lastScanned ? encodeCursor(lastScanned) : null,
      extras: { tag },
    });
  } catch (error: any) {
    if (isHashtagValidationError(error)) {
      return sendCodedError(res, error.code, error.message, error.status ?? 400);
    }
    if (error?.code === "HASHTAG_INVALID") {
      return sendCodedError(res, "HASHTAG_INVALID", error?.message ?? "invalid hashtag", 400);
    }
    return formatResponse({ res, success: false, message: error });
  }
};

export const hashtags_suggest = async (req: Request, res: Response) => {
  try {
    const q = (req.query as any)?.q;
    const size = parsePositiveInt((req.query as any)?.size, 20, 50);
    const suggestions = await repository.suggestHashtags({
      query: q,
      size,
      viewerIdRaw: (req as any)?.userId,
    });
    const items = suggestions.map((item: any) => ({
      tag: item.tag,
      posts_count: Number(item.posts_count ?? item.count ?? 0),
      users_count: Number(item.users_count ?? 0),
      mutual_users_count: Number(item.mutual_users_count ?? 0),
    }));

    return sendUnifiedSuccess(res, {
      items,
      users: [],
      count: items.length,
      page: 0,
      size,
      next_cursor: null,
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};

export const hashtags_trending = async (req: Request, res: Response) => {
  try {
    const size = parsePositiveInt((req.query as any)?.size, 20, 50);
    const rawWindow = String((req.query as any)?.window ?? "").trim();
    const hasExplicitWindow = rawWindow.length > 0;
    const sourceItems = hasExplicitWindow
      ? await repository.trendingHashtags({
          windowHours: parseWindowHours(rawWindow).hours,
          size,
          viewerIdRaw: (req as any)?.userId,
        })
      : await repository.suggestHashtags({
          query: "#",
          size,
          viewerIdRaw: (req as any)?.userId,
        });
    const items = sourceItems.map((item: any) => ({
      tag: item.tag,
      posts_count: Number(item.hits ?? item.posts_count ?? 0),
      users_count: Number(item.users_count ?? 0),
      mutual_users_count: Number(item.mutual_users_count ?? 0),
    }));

    return sendUnifiedSuccess(res, {
      items,
      users: [],
      count: items.length,
      page: 0,
      size,
      next_cursor: null,
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};
