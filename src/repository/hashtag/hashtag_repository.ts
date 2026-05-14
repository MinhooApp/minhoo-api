import { Op, QueryTypes, Transaction } from "sequelize";
import Hashtag from "../../_models/hashtag/hashtag";
import ContentHashtag from "../../_models/hashtag/content_hashtag";
import {
  collectContentHashtagsOrThrow,
  HashtagEntry,
  toHashtagEntries,
} from "../../libs/hashtags";

export type HashtagContentType = "post" | "reel" | "comment" | "reel_comment";
export type HashtagFeedType = "all" | "posts" | "orbits";
export type HashtagFeedSort = "top" | "new";

export type HashtagFeedCursor = {
  contentCreatedAt: string;
  mappingId: number;
  score?: number;
  sort?: HashtagFeedSort;
  type?: HashtagFeedType;
  tag?: string;
};

export type TaggedContentRef = {
  mappingId: number;
  createdAt: string;
  contentCreatedAt: string;
  contentType: HashtagContentType;
  contentId: number;
  likesCount: number;
  commentsCount: number;
  score: number;
};

const ALLOWED_CONTENT_TYPES = new Set<HashtagContentType>([
  "post",
  "reel",
  "comment",
  "reel_comment",
]);

const setValue = (target: any, key: string, value: any) => {
  if (!target) return;
  if (typeof target.setDataValue === "function") {
    target.setDataValue(key, value);
    return;
  }
  target[key] = value;
};

const normalizeSize = (value: any, fallback: number, max: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.max(1, Math.floor(parsed)));
};

const normalizeOffset = (value: any) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
};

const normalizeViewerId = (value: any): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
};

const toUniqueIds = (value: any[]): number[] => {
  const seen = new Set<number>();
  (Array.isArray(value) ? value : []).forEach((entry) => {
    const parsed = Number(entry);
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    seen.add(Math.floor(parsed));
  });
  return Array.from(seen.values());
};

const normalizeTags = (tagsRaw: string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  (Array.isArray(tagsRaw) ? tagsRaw : []).forEach((entry) => {
    const tag = String(entry ?? "").trim().toLowerCase();
    if (!tag || seen.has(tag)) return;
    seen.add(tag);
    out.push(tag);
  });
  return out;
};

const ensureValidContentType = (contentType: HashtagContentType) => {
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new Error(`invalid content_type: ${contentType}`);
  }
};

const resolveFeedContentTypes = (type: HashtagFeedType): HashtagContentType[] => {
  if (type === "posts") return ["post"];
  if (type === "orbits") return ["reel"];
  return ["post", "reel"];
};

const normalizeCursor = (cursorRaw: any): HashtagFeedCursor | null => {
  if (!cursorRaw || typeof cursorRaw !== "object") return null;
  const mappingId = Number((cursorRaw as any)?.mappingId ?? 0);
  const createdAtRaw = String(
    (cursorRaw as any)?.contentCreatedAt ?? (cursorRaw as any)?.createdAt ?? ""
  ).trim();
  if (!Number.isFinite(mappingId) || mappingId <= 0 || !createdAtRaw) return null;
  const createdAt = new Date(createdAtRaw);
  if (Number.isNaN(createdAt.getTime())) return null;

  const scoreRaw = Number((cursorRaw as any)?.score ?? 0);
  const score = Number.isFinite(scoreRaw) ? Math.max(0, Math.floor(scoreRaw)) : 0;

  const sortRaw = String((cursorRaw as any)?.sort ?? "")
    .trim()
    .toLowerCase();
  const typeRaw = String((cursorRaw as any)?.type ?? "")
    .trim()
    .toLowerCase();
  const tagRaw = String((cursorRaw as any)?.tag ?? "")
    .trim()
    .toLowerCase()
    .replace(/^#+/, "");

  const sort: HashtagFeedSort | undefined = sortRaw === "new" || sortRaw === "top" ? sortRaw : undefined;
  const type: HashtagFeedType | undefined =
    typeRaw === "all" || typeRaw === "posts" || typeRaw === "orbits"
      ? (typeRaw as HashtagFeedType)
      : undefined;

  return {
    mappingId: Math.floor(mappingId),
    contentCreatedAt: createdAt.toISOString(),
    score,
    sort,
    type,
    tag: tagRaw || undefined,
  };
};

const resolveFeedContentWhereClause = (type: HashtagFeedType): string => {
  if (type === "posts") return "ch.content_type = 'post'";
  if (type === "orbits") return "ch.content_type = 'reel'";
  return "ch.content_type IN ('post', 'reel')";
};

const getSequelize = () => (Hashtag as any).sequelize;

const loadHashtagRowsByTags = async (tags: string[], transaction?: Transaction) => {
  if (!tags.length) return [];

  await Hashtag.bulkCreate(
    tags.map((tag) => ({ tag })),
    {
      ignoreDuplicates: true,
      transaction,
    }
  );

  return Hashtag.findAll({
    where: { tag: { [Op.in]: tags } },
    attributes: ["id", "tag"],
    transaction,
  });
};

export const normalizeHashtagsForContent = (params: {
  text?: any;
  hashtagsRaw?: any;
}) => {
  return collectContentHashtagsOrThrow({
    text: params.text,
    hashtagsRaw: params.hashtagsRaw,
  });
};

export const syncHashtagsForContent = async (params: {
  contentType: HashtagContentType;
  contentId: any;
  tags: string[];
  transaction?: Transaction;
}) => {
  ensureValidContentType(params.contentType);

  const contentId = Number(params.contentId);
  if (!Number.isFinite(contentId) || contentId <= 0) return [];

  const tags = normalizeTags(params.tags);
  const transaction = params.transaction;

  await ContentHashtag.destroy({
    where: {
      content_type: params.contentType,
      content_id: Math.floor(contentId),
    },
    transaction,
  });

  if (!tags.length) return [];

  const hashtagRows = await loadHashtagRowsByTags(tags, transaction);
  const hashtagIdByTag = new Map<string, number>();
  hashtagRows.forEach((row: any) => {
    const tag = String(row?.tag ?? "").trim().toLowerCase();
    const id = Number(row?.id);
    if (tag && Number.isFinite(id) && id > 0) {
      hashtagIdByTag.set(tag, Math.floor(id));
    }
  });

  const rowsToCreate = tags
    .map((tag, index) => {
      const hashtagId = hashtagIdByTag.get(tag);
      if (!hashtagId) return null;
      return {
        hashtagId,
        content_type: params.contentType,
        content_id: Math.floor(contentId),
        sort_order: index,
      };
    })
    .filter((row): row is NonNullable<typeof row> => !!row);

  if (rowsToCreate.length) {
    await ContentHashtag.bulkCreate(rowsToCreate, {
      ignoreDuplicates: true,
      transaction,
    });
  }

  return toHashtagEntries(tags);
};

export const getHashtagMapForContent = async (
  contentType: HashtagContentType,
  contentIdsRaw: any[]
) => {
  ensureValidContentType(contentType);
  const contentIds = toUniqueIds(contentIdsRaw);
  const map = new Map<number, HashtagEntry[]>();
  if (!contentIds.length) return map;

  const rows = await ContentHashtag.findAll({
    where: {
      content_type: contentType,
      content_id: { [Op.in]: contentIds },
    },
    attributes: ["id", "hashtagId", "content_id", "sort_order"],
    order: [
      ["content_id", "ASC"],
      ["sort_order", "ASC"],
      ["id", "ASC"],
    ],
  });

  if (!rows.length) return map;

  const hashtagIds = toUniqueIds(rows.map((row: any) => Number(row?.hashtagId)));
  if (!hashtagIds.length) return map;

  const tags = await Hashtag.findAll({
    where: { id: { [Op.in]: hashtagIds } },
    attributes: ["id", "tag"],
  });
  const hashtagById = new Map<number, string>();
  tags.forEach((row: any) => {
    const id = Number(row?.id);
    const tag = String(row?.tag ?? "").trim().toLowerCase();
    if (Number.isFinite(id) && id > 0 && tag) {
      hashtagById.set(Math.floor(id), tag);
    }
  });

  rows.forEach((row: any) => {
    const contentId = Number(row?.content_id);
    const hashtagId = Number(row?.hashtagId);
    const tag = hashtagById.get(hashtagId);
    if (!Number.isFinite(contentId) || contentId <= 0 || !tag) return;
    const current = map.get(contentId) ?? [];
    current.push({ tag, display: `#${tag}` });
    map.set(contentId, current);
  });

  return map;
};

export const attachHashtagsToRows = async (params: {
  rows: any[];
  contentType: HashtagContentType;
  idSelector?: (row: any) => any;
  fieldName?: string;
}) => {
  const fieldName = String(params.fieldName ?? "hashtags");
  const idSelector = params.idSelector ?? ((row: any) => row?.id);
  const rows = Array.isArray(params.rows) ? params.rows : [];

  if (!rows.length) return;

  const ids = toUniqueIds(rows.map((row) => idSelector(row)));
  if (!ids.length) {
    rows.forEach((row) => setValue(row, fieldName, []));
    return;
  }

  const map = await getHashtagMapForContent(params.contentType, ids);
  rows.forEach((row) => {
    const id = Number(idSelector(row));
    const hashtags = Number.isFinite(id) && id > 0 ? map.get(Math.floor(id)) ?? [] : [];
    setValue(row, fieldName, hashtags);
  });
};

export const findHashtagByTag = async (tagRaw: any) => {
  const tag = String(tagRaw ?? "").trim().toLowerCase();
  if (!tag) return null;
  return Hashtag.findOne({
    where: { tag },
    attributes: ["id", "tag"],
  });
};

export const listTaggedContentRefs = async (params: {
  tag: string;
  type: HashtagFeedType;
  sort?: HashtagFeedSort;
  cursor?: HashtagFeedCursor | null;
  offset?: any;
  size?: any;
}) => {
  const tag = String(params.tag ?? "").trim().toLowerCase();
  if (!tag) return { notFound: true, tag: null, rows: [] as TaggedContentRef[] };

  const hashtag = await findHashtagByTag(tag);
  if (!hashtag) return { notFound: true, tag: null, rows: [] as TaggedContentRef[] };

  const sort: HashtagFeedSort = params.sort === "new" ? "new" : "top";
  const size = normalizeSize(params.size, 20, 100);
  const cursor = normalizeCursor(params.cursor ?? null);
  const offset = normalizeOffset(params.offset);
  const hashtagId = Number((hashtag as any)?.id);
  const contentTypeWhereSql = resolveFeedContentWhereClause(params.type);
  const orderBySql =
    sort === "top"
      ? "feed.score DESC, feed.content_created_at DESC, feed.mapping_id DESC"
      : "feed.content_created_at DESC, feed.mapping_id DESC";
  const cursorWhereSql =
    cursor && sort === "top"
      ? `
        AND (
          feed.score < :cursorScore
          OR (
            feed.score = :cursorScore
            AND (
              feed.content_created_at < :cursorCreatedAt
              OR (
                feed.content_created_at = :cursorCreatedAt
                AND feed.mapping_id < :cursorMappingId
              )
            )
          )
        )
      `
      : cursor
      ? `
        AND (
          feed.content_created_at < :cursorCreatedAt
          OR (
            feed.content_created_at = :cursorCreatedAt
            AND feed.mapping_id < :cursorMappingId
          )
        )
      `
      : "";

  const replacements: Record<string, any> = {
    hashtagId,
  };
  if (cursor) {
    replacements.cursorCreatedAt = cursor.contentCreatedAt;
    replacements.cursorMappingId = cursor.mappingId;
    replacements.cursorScore = Number.isFinite(cursor.score)
      ? Math.max(0, Math.floor(Number(cursor.score)))
      : 0;
  }

  const sequelize = getSequelize();
  if (!sequelize) return { notFound: true, tag: null, rows: [] as TaggedContentRef[] };

  const rows = (await sequelize.query(
    `
      SELECT
        feed.mapping_id AS mappingId,
        feed.content_type AS contentType,
        feed.content_id AS contentId,
        feed.content_created_at AS contentCreatedAt,
        feed.likes_count AS likesCount,
        feed.comments_count AS commentsCount,
        feed.score AS score
      FROM (
        SELECT
          ch.id AS mapping_id,
          ch.content_type AS content_type,
          ch.content_id AS content_id,
          CASE
            WHEN ch.content_type = 'post' THEN COALESCE(p.likes_count, 0)
            ELSE COALESCE(r.likes_count, 0)
          END AS likes_count,
          CASE
            WHEN ch.content_type = 'post' THEN (
              SELECT COUNT(1)
              FROM comments c
              WHERE c.postId = p.id
                AND c.is_delete = 0
            )
            ELSE COALESCE(r.comments_count, 0)
          END AS comments_count,
          CASE
            WHEN ch.content_type = 'post'
              THEN COALESCE(p.likes_count, 0) + (
                SELECT COUNT(1)
                FROM comments c
                WHERE c.postId = p.id
                  AND c.is_delete = 0
              )
            ELSE COALESCE(r.likes_count, 0) + COALESCE(r.comments_count, 0)
          END AS score,
          CASE
            WHEN ch.content_type = 'post' THEN p.created_date
            ELSE r.createdAt
          END AS content_created_at
        FROM content_hashtags ch
        LEFT JOIN posts p
          ON ch.content_type = 'post'
         AND p.id = ch.content_id
         AND p.is_delete = 0
        LEFT JOIN reels r
          ON ch.content_type = 'reel'
         AND r.id = ch.content_id
         AND r.is_delete = 0
         AND r.status = 'ready'
        WHERE ch.hashtagId = :hashtagId
          AND ${contentTypeWhereSql}
          AND (
            (ch.content_type = 'post' AND p.id IS NOT NULL)
            OR
            (ch.content_type = 'reel' AND r.id IS NOT NULL)
          )
      ) feed
      WHERE 1 = 1
      ${cursorWhereSql}
      ORDER BY ${orderBySql}
      LIMIT ${size}
      ${cursor ? "" : `OFFSET ${offset}`}
    `,
    {
      replacements,
      type: QueryTypes.SELECT,
    }
  )) as any[];

  const refs: TaggedContentRef[] = rows
    .map((row: any) => {
      const mappingId = Number(row?.mappingId);
      const contentId = Number(row?.contentId);
      const createdAtCandidate = new Date(row?.contentCreatedAt ?? "");
      const contentType = String(row?.contentType ?? "") as HashtagContentType;
      const likesCount = Math.max(0, Number(row?.likesCount ?? 0) || 0);
      const commentsCount = Math.max(0, Number(row?.commentsCount ?? 0) || 0);
      const score = Math.max(0, Number(row?.score ?? likesCount + commentsCount) || 0);
      if (
        !Number.isFinite(mappingId) ||
        mappingId <= 0 ||
        !Number.isFinite(contentId) ||
        contentId <= 0 ||
        Number.isNaN(createdAtCandidate.getTime()) ||
        !ALLOWED_CONTENT_TYPES.has(contentType)
      ) {
        return null;
      }
      const contentCreatedAt = createdAtCandidate.toISOString();
      return {
        mappingId: Math.floor(mappingId),
        contentId: Math.floor(contentId),
        contentType,
        createdAt: contentCreatedAt,
        contentCreatedAt,
        likesCount: Math.floor(likesCount),
        commentsCount: Math.floor(commentsCount),
        score: Math.floor(score),
      };
    })
    .filter((row): row is TaggedContentRef => !!row);

  return {
    notFound: false,
    tag: String((hashtag as any)?.tag ?? tag),
    rows: refs,
  };
};

export const hasMoreTaggedContentRefs = async (params: {
  tag: string;
  type: HashtagFeedType;
  sort?: HashtagFeedSort;
  cursor?: HashtagFeedCursor | null;
  offset?: any;
}) => {
  const result = await listTaggedContentRefs({
    tag: params.tag,
    type: params.type,
    sort: params.sort,
    cursor: params.cursor ?? null,
    offset: params.offset,
    size: 1,
  });
  return Array.isArray(result.rows) && result.rows.length > 0;
};

const normalizeSuggestQuery = (value: any) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^#+/, "")
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 50);

export const suggestHashtags = async (params: {
  query: any;
  size?: any;
  viewerIdRaw?: any;
}) => {
  const query = normalizeSuggestQuery(params.query);
  const size = normalizeSize(params.size, 20, 50);
  const viewerId = normalizeViewerId(params.viewerIdRaw);

  const sequelize = getSequelize();
  if (!sequelize) return [];

  const hasPrefixQuery = query.length > 0;

  const rows = await sequelize.query(
    `
      SELECT
        h.tag AS tag,
        COUNT(
          CASE
            WHEN ch.content_type = 'post' AND p.id IS NOT NULL THEN 1
            WHEN ch.content_type = 'reel' AND r.id IS NOT NULL THEN 1
            ELSE NULL
          END
        ) AS posts_count,
        COUNT(
          DISTINCT
          CASE
            WHEN ch.content_type = 'post' AND p.id IS NOT NULL THEN p.userId
            WHEN ch.content_type = 'reel' AND r.id IS NOT NULL THEN r.userId
            ELSE NULL
          END
        ) AS users_count,
        COUNT(
          DISTINCT
          CASE
            WHEN :viewerId > 0
            AND (
              (f.followerId = :viewerId AND f.userId = CASE
                WHEN ch.content_type = 'post' THEN p.userId
                WHEN ch.content_type = 'reel' THEN r.userId
                ELSE NULL
              END)
              OR
              (f.userId = :viewerId AND f.followerId = CASE
                WHEN ch.content_type = 'post' THEN p.userId
                WHEN ch.content_type = 'reel' THEN r.userId
                ELSE NULL
              END)
            )
            THEN CASE
              WHEN ch.content_type = 'post' THEN p.userId
              WHEN ch.content_type = 'reel' THEN r.userId
              ELSE NULL
            END
            ELSE NULL
          END
        ) AS mutual_users_count
      FROM hashtags h
      LEFT JOIN content_hashtags ch
        ON ch.hashtagId = h.id
       AND ch.content_type IN ('post', 'reel')
      LEFT JOIN posts p
        ON ch.content_type = 'post'
       AND p.id = ch.content_id
       AND p.is_delete = 0
      LEFT JOIN reels r
        ON ch.content_type = 'reel'
       AND r.id = ch.content_id
       AND r.is_delete = 0
       AND r.status = 'ready'
      LEFT JOIN followers f
        ON (
          (f.followerId = :viewerId AND f.userId = CASE
            WHEN ch.content_type = 'post' THEN p.userId
            WHEN ch.content_type = 'reel' THEN r.userId
            ELSE NULL
          END)
          OR
          (f.userId = :viewerId AND f.followerId = CASE
            WHEN ch.content_type = 'post' THEN p.userId
            WHEN ch.content_type = 'reel' THEN r.userId
            ELSE NULL
          END)
        )
      ${hasPrefixQuery ? "WHERE h.tag LIKE :queryPrefix" : ""}
      GROUP BY h.id, h.tag
      HAVING posts_count > 0
      ORDER BY posts_count DESC, h.tag ASC
      LIMIT ${size}
    `,
    {
      replacements: hasPrefixQuery
        ? { queryPrefix: `${query}%`, viewerId }
        : { viewerId },
      type: QueryTypes.SELECT,
    }
  );

  return (Array.isArray(rows) ? rows : [])
    .map((row: any) => {
      const tag = String(row?.tag ?? "").trim().toLowerCase();
      const postsCount = Number(row?.posts_count ?? 0) || 0;
      const usersCount = Number(row?.users_count ?? 0) || 0;
      const mutualUsersCount = Number(row?.mutual_users_count ?? 0) || 0;
      if (!tag) return null;
      return {
        tag,
        display: `#${tag}`,
        posts_count: postsCount,
        users_count: usersCount,
        mutual_users_count: mutualUsersCount,
        count: postsCount,
      };
    })
    .filter((row): row is NonNullable<typeof row> => !!row);
};

export const trendingHashtags = async (params: {
  windowHours: number;
  size?: any;
  viewerIdRaw?: any;
}) => {
  const size = normalizeSize(params.size, 20, 50);
  const viewerId = normalizeViewerId(params.viewerIdRaw);
  const hours = Number.isFinite(params.windowHours)
    ? Math.max(1, Math.min(24 * 30, Math.floor(params.windowHours)))
    : 24;
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const sequelize = getSequelize();
  if (!sequelize) return [];

  const rows = await sequelize.query(
    `
      SELECT
        h.tag AS tag,
        COUNT(
          CASE
            WHEN ch.content_type = 'post' AND p.id IS NOT NULL THEN 1
            WHEN ch.content_type = 'reel' AND r.id IS NOT NULL THEN 1
            ELSE NULL
          END
        ) AS hits,
        COUNT(
          DISTINCT
          CASE
            WHEN ch.content_type = 'post' AND p.id IS NOT NULL THEN p.userId
            WHEN ch.content_type = 'reel' AND r.id IS NOT NULL THEN r.userId
            ELSE NULL
          END
        ) AS users_count,
        COUNT(
          DISTINCT
          CASE
            WHEN :viewerId > 0
            AND (
              (f.followerId = :viewerId AND f.userId = CASE
                WHEN ch.content_type = 'post' THEN p.userId
                WHEN ch.content_type = 'reel' THEN r.userId
                ELSE NULL
              END)
              OR
              (f.userId = :viewerId AND f.followerId = CASE
                WHEN ch.content_type = 'post' THEN p.userId
                WHEN ch.content_type = 'reel' THEN r.userId
                ELSE NULL
              END)
            )
            THEN CASE
              WHEN ch.content_type = 'post' THEN p.userId
              WHEN ch.content_type = 'reel' THEN r.userId
              ELSE NULL
            END
            ELSE NULL
          END
        ) AS mutual_users_count
      FROM content_hashtags ch
      INNER JOIN hashtags h
        ON h.id = ch.hashtagId
      LEFT JOIN posts p
        ON ch.content_type = 'post'
       AND p.id = ch.content_id
       AND p.is_delete = 0
      LEFT JOIN reels r
        ON ch.content_type = 'reel'
       AND r.id = ch.content_id
       AND r.is_delete = 0
       AND r.status = 'ready'
      LEFT JOIN followers f
        ON (
          (f.followerId = :viewerId AND f.userId = CASE
            WHEN ch.content_type = 'post' THEN p.userId
            WHEN ch.content_type = 'reel' THEN r.userId
            ELSE NULL
          END)
          OR
          (f.userId = :viewerId AND f.followerId = CASE
            WHEN ch.content_type = 'post' THEN p.userId
            WHEN ch.content_type = 'reel' THEN r.userId
            ELSE NULL
          END)
        )
      WHERE ch.createdAt >= :cutoff
        AND ch.content_type IN ('post', 'reel')
      GROUP BY h.id, h.tag
      ORDER BY hits DESC, h.tag ASC
      LIMIT ${size}
    `,
    {
      replacements: { cutoff, viewerId },
      type: QueryTypes.SELECT,
    }
  );

  return (Array.isArray(rows) ? rows : [])
    .map((row: any) => {
      const tag = String(row?.tag ?? "").trim().toLowerCase();
      const hits = Number(row?.hits ?? 0) || 0;
      const usersCount = Number(row?.users_count ?? 0) || 0;
      const mutualUsersCount = Number(row?.mutual_users_count ?? 0) || 0;
      if (!tag) return null;
      return {
        tag,
        display: `#${tag}`,
        posts_count: hits,
        users_count: usersCount,
        mutual_users_count: mutualUsersCount,
        count: hits,
      };
    })
    .filter((row): row is NonNullable<typeof row> => !!row);
};
