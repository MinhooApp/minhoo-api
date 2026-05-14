import { createHmac, timingSafeEqual } from "crypto";
import { Op, Sequelize } from "sequelize";
import MediaPost from "../../_models/post/media_post";
import Post from "../../_models/post/post";
import SavedPost from "../../_models/post/saved_post";
import { postInclude } from "../post/post_include";

const normalizeLimit = (value: any, fallback = 20, max = 50) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(1, Math.floor(n)), max);
};

const normalizePage = (value: any, fallback = 0) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
};

const normalizeCounter = (value: any) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
};

const MEDIA_ACCESS_TOKEN_TTL_SECONDS = Number(
  process.env.MEDIA_ACCESS_TOKEN_TTL_SECONDS ?? 2 * 24 * 60 * 60
);
const MEDIA_ACCESS_TOKEN_QUERY_KEY = "sat";
type SignedMediaKind = "image_id" | "video_uid" | "video_key" | "audio" | "document";

const toBase64Url = (value: Buffer | string) =>
  Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

const bufferFromBase64Url = (value: string) => {
  const normalized = String(value ?? "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, "base64");
};

const getMediaAccessSigningSecret = () =>
  String(
    process.env.MEDIA_ACCESS_SIGNING_SECRET ??
      process.env.JWT_SECRET ??
      process.env.SECRETORPRIVATEKEY ??
      ""
  ).trim();

const normalizeImageId = (value: any): string | null => {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  if (!/^[a-zA-Z0-9._-]{6,255}$/.test(normalized)) return null;
  return normalized;
};

const normalizeVideoUid = (value: any): string | null => {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  if (!/^[a-f0-9]{32}$/i.test(normalized)) return null;
  return normalized.toLowerCase();
};

const normalizeStorageKey = (value: any): string | null => {
  const decoded = decodeURIComponent(String(value ?? "").trim());
  if (!decoded) return null;
  if (!/^[a-zA-Z0-9/_.,@-]{2,512}$/.test(decoded)) return null;
  return decoded;
};

const buildMediaAccessToken = (kind: SignedMediaKind, resourceKey: string): string | null => {
  const secret = getMediaAccessSigningSecret();
  const key = String(resourceKey ?? "").trim();
  if (!secret || !key) return null;
  const exp = Math.floor(Date.now() / 1000) + MEDIA_ACCESS_TOKEN_TTL_SECONDS;
  const payload = `${kind}:${key}:${exp}`;
  const signature = createHmac("sha256", secret).update(payload).digest();
  return `${exp}.${toBase64Url(signature)}`;
};

const validateMediaAccessToken = (
  tokenValue: any,
  kind: SignedMediaKind,
  resourceKey: string
): boolean => {
  const secret = getMediaAccessSigningSecret();
  if (!secret) return false;

  const token = String(tokenValue ?? "").trim();
  if (!token) return false;
  const [expRaw, signatureRaw] = token.split(".");
  if (!expRaw || !signatureRaw) return false;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp)) return false;
  if (exp <= Math.floor(Date.now() / 1000)) return false;

  const payload = `${kind}:${resourceKey}:${exp}`;
  const expectedSignature = createHmac("sha256", secret).update(payload).digest();
  const providedSignature = bufferFromBase64Url(signatureRaw ?? "");
  if (expectedSignature.length !== providedSignature.length) return false;
  return timingSafeEqual(expectedSignature, providedSignature);
};

const rebuildUrlLikeInput = (rawUrl: string, parsed: URL): string => {
  const trimmed = String(rawUrl ?? "").trim();
  if (!trimmed) return trimmed;
  const query = parsed.searchParams.toString();
  const pathWithQuery = query ? `${parsed.pathname}?${query}` : parsed.pathname;
  if (/^https?:\/\//i.test(trimmed)) {
    return `${parsed.protocol}//${parsed.host}${pathWithQuery}`;
  }
  return pathWithQuery;
};

const ensureFreshMediaAccessToken = (
  parsed: URL,
  kind: SignedMediaKind,
  resourceKey: string
): boolean => {
  const existing = String(parsed.searchParams.get(MEDIA_ACCESS_TOKEN_QUERY_KEY) ?? "").trim();
  if (existing && validateMediaAccessToken(existing, kind, resourceKey)) return false;
  const token = buildMediaAccessToken(kind, resourceKey);
  if (!token) return false;
  parsed.searchParams.set(MEDIA_ACCESS_TOKEN_QUERY_KEY, token);
  return true;
};

const refreshSignedMediaUrl = (rawUrl: string): string => {
  const trimmed = String(rawUrl ?? "").trim();
  if (!trimmed) return trimmed;

  try {
    const parsed = new URL(trimmed, "http://local");
    const pathname = String(parsed.pathname ?? "").trim().toLowerCase();

    let kind: SignedMediaKind | null = null;
    let resourceKey: string | null = null;

    if (pathname === "/api/v1/media/image/play") {
      kind = "image_id";
      resourceKey = normalizeImageId(parsed.searchParams.get("id"));
    } else if (pathname === "/api/v1/media/video/play") {
      const key = normalizeStorageKey(parsed.searchParams.get("key"));
      if (key) {
        kind = "video_key";
        resourceKey = key;
      } else {
        const uidRaw = String(parsed.searchParams.get("uid") ?? "").trim();
        const uid = normalizeVideoUid(uidRaw);
        if (uid) {
          kind = "video_uid";
          resourceKey = uid;
        } else {
          const fallbackKey = normalizeStorageKey(uidRaw);
          if (fallbackKey) {
            kind = "video_key";
            resourceKey = fallbackKey;
          }
        }
      }
    } else if (pathname === "/api/v1/media/audio/play") {
      kind = "audio";
      resourceKey = normalizeStorageKey(parsed.searchParams.get("key"));
    } else if (pathname === "/api/v1/media/document/download") {
      kind = "document";
      resourceKey = normalizeStorageKey(parsed.searchParams.get("key"));
    }

    if (!kind || !resourceKey) return trimmed;

    const changed = ensureFreshMediaAccessToken(parsed, kind, resourceKey);
    if (!changed) return rebuildUrlLikeInput(trimmed, parsed);
    return rebuildUrlLikeInput(trimmed, parsed);
  } catch {
    return trimmed;
  }
};

const refreshSavedPostMediaLinks = (post: any) => {
  if (!post) return;

  const setField = (row: any, field: "url" | "media_url", value: string) => {
    if (!row) return;
    if (typeof row?.setDataValue === "function") {
      row.setDataValue(field, value);
      return;
    }
    row[field] = value;
  };

  const mediaRows = Array.isArray((post as any)?.post_media) ? (post as any).post_media : [];
  mediaRows.forEach((media: any) => {
    const original = String(media?.url ?? "").trim();
    if (!original) return;
    const refreshed = refreshSignedMediaUrl(original);
    if (refreshed !== original) setField(media, "url", refreshed);
  });

  const commentRows = Array.isArray((post as any)?.comments) ? (post as any).comments : [];
  commentRows.forEach((comment: any) => {
    const original = String(comment?.media_url ?? "").trim();
    if (!original) return;
    const refreshed = refreshSignedMediaUrl(original);
    if (refreshed !== original) setField(comment, "media_url", refreshed);
  });
};

const setSavedFlag = (post: any, value: boolean) => {
  if (!post) return;
  if (typeof post.setDataValue === "function") {
    post.setDataValue("is_saved", value);
    post.setDataValue("isSaved", value);
    post.setDataValue("saved", value);
    return;
  }
  post.is_saved = value;
  post.isSaved = value;
  post.saved = value;
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

const buildSavedPostsQuery = (videoOnly: boolean) => {
  const postIncludeForSaved: any = {
    model: Post,
    as: "post",
    attributes: ["id"],
    required: true,
    where: { is_delete: false },
  };

  if (videoOnly) {
    postIncludeForSaved.include = [
      {
        model: MediaPost,
        as: "post_media",
        attributes: [],
        where: { is_img: false },
        required: true,
      },
    ];
  }

  return postIncludeForSaved;
};

export const getVisiblePost = async (postId: number) => {
  return Post.findOne({
    where: { id: postId, is_delete: false },
    attributes: ["id", "userId", "is_delete", "saves_count", "likes_count"],
  });
};

export const savePost = async (userId: number, postId: number) => {
  const [row, created] = await SavedPost.findOrCreate({
    where: { userId, postId },
    defaults: { userId, postId },
  });

  if (created) {
    await Post.increment({ saves_count: 1 }, { where: { id: postId } });
  }

  const refreshed = await Post.findByPk(postId, {
    attributes: ["saves_count"],
  });

  return {
    row,
    created,
    savesCount: normalizeCounter((refreshed as any)?.saves_count),
  };
};

export const removeSavedPost = async (userId: number, postId: number) => {
  const deleted = await SavedPost.destroy({
    where: { userId, postId },
  });

  if (deleted > 0) {
    await Post.update(
      {
        saves_count: Sequelize.literal(
          "GREATEST(COALESCE(saves_count, 0) - 1, 0)"
        ),
      },
      { where: { id: postId } }
    );
  }

  const refreshed = await Post.findByPk(postId, {
    attributes: ["saves_count"],
  });

  return {
    removed: deleted > 0,
    savesCount: normalizeCounter((refreshed as any)?.saves_count),
  };
};

export const getSavedPostIdSet = async (userId: number, postIds: number[]) => {
  const normalizedIds = Array.from(
    new Set(
      (postIds || [])
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0)
    )
  );

  if (!Number.isFinite(userId) || userId <= 0 || !normalizedIds.length) {
    return new Set<number>();
  }

  const rows = await SavedPost.findAll({
    where: {
      userId,
      postId: { [Op.in]: normalizedIds },
    },
    attributes: ["postId"],
  });

  return new Set<number>(rows.map((row: any) => Number(row.postId)));
};

export const isPostSavedByUser = async (userId: number, postId: number) => {
  if (!Number.isFinite(userId) || userId <= 0) return false;
  const row = await SavedPost.findOne({
    where: { userId, postId },
    attributes: ["id"],
  });
  return !!row;
};

export const countByPostId = async (postId: number) => {
  if (!Number.isFinite(postId) || postId <= 0) return 0;
  return SavedPost.count({ where: { postId } });
};

export const getSavedCountsMap = async (postIds: number[]) => {
  const normalizedIds = Array.from(
    new Set(
      (postIds || [])
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0)
    )
  );

  const counts = new Map<number, number>();
  if (!normalizedIds.length) return counts;

  const rows = await SavedPost.findAll({
    where: { postId: { [Op.in]: normalizedIds } },
    attributes: [
      "postId",
      [SavedPost.sequelize!.fn("COUNT", SavedPost.sequelize!.col("id")), "total"],
    ],
    group: ["postId"],
  });

  rows.forEach((row: any) => {
    const postId = Number(row.postId);
    const total = Number(row.get?.("total") ?? row.dataValues?.total ?? 0);
    if (Number.isFinite(postId)) counts.set(postId, Number.isFinite(total) ? total : 0);
  });

  return counts;
};

export const removeByPostId = async (postId: number) => {
  if (!Number.isFinite(postId) || postId <= 0) return 0;
  return SavedPost.destroy({ where: { postId } });
};

const listSaved = async ({
  userId,
  page,
  size,
  videoOnly,
}: {
  userId: number;
  page: any;
  size: any;
  videoOnly: boolean;
}) => {
  const limit = normalizeLimit(size, 20, 50);
  const pageNumber = normalizePage(page, 0);
  const offset = pageNumber * limit;

  const savedRows = await SavedPost.findAndCountAll({
    where: { userId },
    include: [buildSavedPostsQuery(videoOnly)],
    attributes: ["id", "postId", "createdAt"],
    order: [
      ["createdAt", "DESC"],
      ["id", "DESC"],
    ],
    limit,
    offset,
    distinct: true,
    subQuery: false,
  });

  const postIds = savedRows.rows
    .map((row: any) => Number(row.postId))
    .filter((id) => Number.isFinite(id));

  if (!postIds.length) {
    return {
      page: pageNumber,
      size: limit,
      count: Number(savedRows.count || 0),
      posts: [],
    };
  }

  const posts = await Post.findAll({
    where: {
      id: { [Op.in]: postIds },
      is_delete: false,
    },
    include: postInclude,
    attributes: { exclude: ["createdAt", "updatedAt"] },
  });

  const postById = new Map<number, any>();
  posts.forEach((post: any) => {
    postById.set(Number(post.id), post);
  });

  const orderedPosts = postIds
    .map((postId) => postById.get(postId))
    .filter(Boolean);

  orderedPosts.forEach((post: any) => refreshSavedPostMediaLinks(post));
  orderedPosts.forEach((post: any) => setSavedFlag(post, true));
  orderedPosts.forEach((post: any) => {
    setSavedCount(post, normalizeCounter((post as any)?.saves_count));
  });

  return {
    page: pageNumber,
    size: limit,
    count: Number(savedRows.count || 0),
    posts: orderedPosts,
  };
};

export const listSavedPosts = async (userId: number, page: any, size: any) => {
  return listSaved({ userId, page, size, videoOnly: false });
};

export const listSavedVideos = async (userId: number, page: any, size: any) => {
  return listSaved({ userId, page, size, videoOnly: true });
};
