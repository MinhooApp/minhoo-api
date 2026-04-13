import {
  Request,
  Response,
  formatResponse,
  repository,
  followerRepo,
} from "../_module/module";
import { Op } from "sequelize";
import * as savedRepository from "../../../repository/saved/saved_repository";
import Like from "../../../_models/like/like";
import { respondNotModifiedIfFresh, setCacheControl } from "../../../libs/http_cache";
import { isSummaryMode, toFollowSummary } from "../../../libs/summary_response";
import { attachActiveOrbitStateToUsers } from "../../../repository/reel/orbit_ring_projection";

const collectFollowUsers = (entries: any[]) =>
  (Array.isArray(entries) ? entries : [])
    .map((entry: any) =>
      entry?.user ??
      entry?.following_data ??
      entry?.follower_data ??
      null
    )
    .filter((user: any) => !!user && typeof user === "object");

const enrichFollowUsersWithOrbitState = async (
  entries: any[],
  viewerIdRaw: any
) => {
  const users = collectFollowUsers(entries);
  if (!users.length) return;
  await attachActiveOrbitStateToUsers({
    usersRaw: users,
    viewerIdRaw,
  });
};

const resolveTargetUserId = (idRaw: any, requesterIdRaw: any) => {
  const hasExplicitId =
    idRaw !== undefined &&
    idRaw !== null &&
    String(idRaw).trim().length > 0;

  if (hasExplicitId) {
    const parsed = Number(idRaw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return {
        ok: false as const,
        code: 400,
        message: "id must be a valid number",
      };
    }
    return { ok: true as const, id: Math.trunc(parsed) };
  }

  const requesterId = Number(requesterIdRaw);
  if (!Number.isFinite(requesterId) || requesterId <= 0) {
    return {
      ok: false as const,
      code: 401,
      message: "authentication required when id is omitted",
    };
  }

  return { ok: true as const, id: Math.trunc(requesterId) };
};

const normalizeSavedCounter = (value: any) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
};

const setSavedFlagOnPost = (post: any, isSaved: boolean) => {
  if (!post) return;
  if (typeof (post as any).setDataValue === "function") {
    (post as any).setDataValue("is_saved", isSaved);
    (post as any).setDataValue("isSaved", isSaved);
    return;
  }
  (post as any).is_saved = isSaved;
  (post as any).isSaved = isSaved;
};

const setSavedCountOnPost = (post: any, count: number) => {
  if (!post) return;
  if (typeof (post as any).setDataValue === "function") {
    (post as any).setDataValue("saved_count", count);
    (post as any).setDataValue("savedCount", count);
    return;
  }
  (post as any).saved_count = count;
  (post as any).savedCount = count;
};

const attachSavedStateToUserPosts = async (viewerIdRaw: any, user: any) => {
  const posts = Array.isArray((user as any)?.posts) ? (user as any).posts : [];
  if (!posts.length) return;

  const postIds = posts
    .map((post: any) => Number(post?.id))
    .filter((postId: number) => Number.isFinite(postId) && postId > 0);

  posts.forEach((post: any) => {
    setSavedCountOnPost(post, normalizeSavedCounter((post as any)?.saves_count));
  });

  const viewerId = Number(viewerIdRaw);
  if (!Number.isFinite(viewerId) || viewerId <= 0) {
    posts.forEach((post: any) => setSavedFlagOnPost(post, false));
    return;
  }

  const savedSet = await savedRepository.getSavedPostIdSet(viewerId, postIds);
  posts.forEach((post: any) => {
    setSavedFlagOnPost(post, savedSet.has(Number(post?.id)));
  });
};

const setLikedFlagOnPost = (post: any, isLiked: boolean) => {
  if (!post) return;
  if (typeof (post as any).setDataValue === "function") {
    (post as any).setDataValue("is_liked", isLiked);
    (post as any).setDataValue("isLiked", isLiked);
    (post as any).setDataValue("isLike", isLiked);
    (post as any).setDataValue("is_like", isLiked);
    (post as any).setDataValue("liked", isLiked);
    (post as any).setDataValue("is_starred", isLiked);
    (post as any).setDataValue("isStarred", isLiked);
    (post as any).setDataValue("starred", isLiked);
    return;
  }
  (post as any).is_liked = isLiked;
  (post as any).isLiked = isLiked;
  (post as any).isLike = isLiked;
  (post as any).is_like = isLiked;
  (post as any).liked = isLiked;
  (post as any).is_starred = isLiked;
  (post as any).isStarred = isLiked;
  (post as any).starred = isLiked;
};

const setViewerLikeHintOnPost = (post: any, viewerId: number | null, isLiked: boolean) => {
  if (!post) return;
  const currentLikes = Array.isArray((post as any)?.likes) ? [...(post as any).likes] : [];
  const likes = currentLikes.filter((like: any) => {
    const likeUserId = Number(like?.userId ?? like?.user_id ?? 0);
    return Number.isFinite(likeUserId) && likeUserId > 0;
  });

  if (isLiked && viewerId && !likes.some((like: any) => Number(like?.userId) === viewerId)) {
    likes.push({ id: null, userId: viewerId, user_id: viewerId });
  }

  if (!isLiked && viewerId) {
    for (let i = likes.length - 1; i >= 0; i -= 1) {
      if (Number(likes[i]?.userId) === viewerId) likes.splice(i, 1);
    }
  }

  if (typeof (post as any).setDataValue === "function") {
    (post as any).setDataValue("likes", likes);
    return;
  }
  (post as any).likes = likes;
};

const attachLikedStateToUserPosts = async (viewerIdRaw: any, user: any) => {
  const posts = Array.isArray((user as any)?.posts) ? (user as any).posts : [];
  if (!posts.length) return;

  const postIds = posts
    .map((post: any) => Number(post?.id))
    .filter((postId: number) => Number.isFinite(postId) && postId > 0);
  if (!postIds.length) return;

  const viewerId = Number(viewerIdRaw);
  if (!Number.isFinite(viewerId) || viewerId <= 0) {
    posts.forEach((post: any) => setLikedFlagOnPost(post, false));
    return;
  }

  const likes = await Like.findAll({
    where: {
      userId: viewerId,
      postId: { [Op.in]: postIds },
    },
    attributes: ["postId"],
    raw: true,
  });

  const likedPostIds = new Set<number>(
    (Array.isArray(likes) ? likes : [])
      .map((like: any) => Number(like?.postId))
      .filter((postId: number) => Number.isFinite(postId) && postId > 0)
  );

  posts.forEach((post: any) => {
    const likedByViewer = likedPostIds.has(Number(post?.id));
    setLikedFlagOnPost(post, likedByViewer);
    setViewerLikeHintOnPost(post, viewerId, likedByViewer);
  });
};

const enrichUserFollowCounts = async (user: any) => {
  if (!user) return null;

  const userId = Number((user as any).id);
  if (!Number.isFinite(userId) || userId <= 0) {
    const fallback = { followersCount: 0, followingCount: 0 };
    const fallbackFields = {
      followers_count: 0,
      followings_count: 0,
      following_count: 0,
      followersCount: 0,
      followingsCount: 0,
      followingCount: 0,
    };

    if (typeof (user as any).setDataValue === "function") {
      Object.entries(fallbackFields).forEach(([key, value]) => {
        (user as any).setDataValue(key, value);
      });
    } else {
      Object.assign(user, fallbackFields);
    }

    return fallback;
  }

  const counts = await followerRepo.getCounts(userId);
  const fields = {
    followers_count: counts.followersCount,
    followings_count: counts.followingCount,
    following_count: counts.followingCount,
    followersCount: counts.followersCount,
    followingsCount: counts.followingCount,
    followingCount: counts.followingCount,
  };

  if (typeof (user as any).setDataValue === "function") {
    Object.entries(fields).forEach(([key, value]) => {
      (user as any).setDataValue(key, value);
    });
  } else {
    Object.assign(user, fields);
  }

  return counts;
};

const normalizeRelationship = (relationship: any) => {
  const isFollowing = Boolean(relationship?.isFollowing);
  const isFollowedBy = Boolean(relationship?.isFollowedBy);
  return {
    isFollowing,
    isFollowedBy,
    isMutual: isFollowing && isFollowedBy,
  };
};

const attachRelationshipAliasesToUser = (user: any, relationship: any) => {
  if (!user) return;
  const normalized = normalizeRelationship(relationship);
  const fields = {
    isFollowing: normalized.isFollowing,
    is_following: normalized.isFollowing,
    isFollowedBy: normalized.isFollowedBy,
    is_followed_by: normalized.isFollowedBy,
    isMutual: normalized.isMutual,
    is_mutual: normalized.isMutual,
  };

  if (typeof (user as any).setDataValue === "function") {
    Object.entries(fields).forEach(([key, value]) => {
      (user as any).setDataValue(key, value);
    });
  } else {
    Object.assign(user, fields);
  }
};

export const gets = async (req: Request, res: Response) => {
  try {
    const page = Math.max(0, Number(req.query.page ?? 0) || 0);
    const size = Math.min(Math.max(Number(req.query.size ?? 5) || 5, 1), 20);
    const users: any = await repository.users(page, size);
    return formatResponse({
      res: res,
      success: true,
      body: {
        page: +page,
        size,
        count: users.count,
        users: users.rows,
      },
    });
  } catch (error) {
    return formatResponse({ res: res, success: false, message: error });
  }
};

export const search_profiles = async (req: Request, res: Response) => {
  try {
    const qRaw =
      (req.query as any)?.q ??
      (req.query as any)?.query ??
      (req.query as any)?.search ??
      (req.query as any)?.term ??
      (req.query as any)?.text ??
      (req.body as any)?.q ??
      (req.body as any)?.query ??
      "";
    const pageRaw = (req.query as any)?.page ?? 0;
    const sizeRaw = (req.query as any)?.size ?? 20;
    const page = Number.isFinite(Number(pageRaw)) && Number(pageRaw) >= 0 ? Math.floor(Number(pageRaw)) : 0;
    const sizeNumber = Number.isFinite(Number(sizeRaw)) ? Math.floor(Number(sizeRaw)) : 20;
    const size = Math.min(Math.max(sizeNumber, 1), 20);
    const query = String(qRaw ?? "").trim();
    const users: any = await repository.search_profiles(query, req.userId ?? -1, page, size);

    return formatResponse({
      res: res,
      success: true,
      body: {
        query,
        page,
        size,
        count: users.count,
        users: users.rows,
      },
    });
  } catch (error) {
    return formatResponse({ res: res, success: false, message: error });
  }
};

export const get = async (req: Request, res: Response) => {
  const { id } = req.params;

  try {
    const user = await repository.get(id, req.userId);
    await attachActiveOrbitStateToUsers({
      usersRaw: [user].filter(Boolean),
      viewerIdRaw: req.userId,
    });
    await attachLikedStateToUserPosts(req.userId, user);
    await attachSavedStateToUserPosts(req.userId, user);
    const counts = await enrichUserFollowCounts(user);
    const viewerId = Number(req.userId);
    const targetId = Number((user as any)?.id ?? id);
    const relationship =
      Number.isFinite(viewerId) &&
      viewerId > 0 &&
      Number.isFinite(targetId) &&
      targetId > 0 &&
      viewerId !== targetId
        ? normalizeRelationship(await followerRepo.getRelationship(viewerId, targetId))
        : normalizeRelationship(null);
    attachRelationshipAliasesToUser(user, relationship);
    const breakdown = {
      name: !!user?.name,
      last_name: !!user?.last_name,
      image_profil: !!user?.image_profil,
      username: !!user?.username,
      phone: !!user?.phone && !!user?.dialing_code,
      about: !!user?.about,
      job_preferences:
        Array.isArray((user as any)?.job_category_ids) &&
        (user as any).job_category_ids.length > 0,
      languages:
        Array.isArray((user as any)?.language_ids) &&
        (user as any).language_ids.length > 0,
      country_origin_id: !!(user as any)?.country_origin_id,
      country_residence_id: !!(user as any)?.country_residence_id,
    };

    const percent =
      (breakdown.name ? 10 : 0) +
      (breakdown.last_name ? 10 : 0) +
      (breakdown.image_profil ? 10 : 0) +
      (breakdown.username ? 20 : 0) +
      (breakdown.phone ? 10 : 0) +
      (breakdown.about ? 10 : 0) +
      (breakdown.job_preferences ? 10 : 0) +
      (breakdown.languages ? 10 : 0) +
      (breakdown.country_origin_id ? 5 : 0) +
      (breakdown.country_residence_id ? 5 : 0);

    return formatResponse({
      res: res,
      success: true,
      body: {
        user,
        counts: counts
          ? {
              followersCount: counts.followersCount,
              followingCount: counts.followingCount,
              followers_count: counts.followersCount,
              followings_count: counts.followingCount,
              following_count: counts.followingCount,
            }
          : null,
        relationship,
        isFollowing: relationship.isFollowing,
        isFollowedBy: relationship.isFollowedBy,
        isMutual: relationship.isMutual,
        is_following: relationship.isFollowing,
        is_followed_by: relationship.isFollowedBy,
        is_mutual: relationship.isMutual,
        profile_completion: {
          percent,
          breakdown,
        },
      },
    });
  } catch (error) {
    console.log(req.userId);
    return formatResponse({ res: res, success: false, message: error });
  }
};

export const myData = async (req: Request, res: Response) => {
  try {
    const user = await repository.get(req.userId);
    await attachLikedStateToUserPosts(req.userId, user);
    await attachSavedStateToUserPosts(req.userId, user);
    const counts = await enrichUserFollowCounts(user);
    const breakdown = {
      name: !!user?.name,
      last_name: !!user?.last_name,
      image_profil: !!user?.image_profil,
      username: !!user?.username,
      phone: !!user?.phone && !!user?.dialing_code,
      about: !!user?.about,
      job_preferences:
        Array.isArray((user as any)?.job_category_ids) &&
        (user as any).job_category_ids.length > 0,
      languages:
        Array.isArray((user as any)?.language_ids) &&
        (user as any).language_ids.length > 0,
      country_origin_id: !!(user as any)?.country_origin_id,
      country_residence_id: !!(user as any)?.country_residence_id,
    };

    const percent =
      (breakdown.name ? 10 : 0) +
      (breakdown.last_name ? 10 : 0) +
      (breakdown.image_profil ? 10 : 0) +
      (breakdown.username ? 20 : 0) +
      (breakdown.phone ? 10 : 0) +
      (breakdown.about ? 10 : 0) +
      (breakdown.job_preferences ? 10 : 0) +
      (breakdown.languages ? 10 : 0) +
      (breakdown.country_origin_id ? 5 : 0) +
      (breakdown.country_residence_id ? 5 : 0);

    return formatResponse({
      res: res,
      success: true,
      body: {
        user,
        counts: counts
          ? {
              followersCount: counts.followersCount,
              followingCount: counts.followingCount,
              followers_count: counts.followersCount,
              followings_count: counts.followingCount,
              following_count: counts.followingCount,
            }
          : null,
        profile_completion: {
          percent,
          breakdown,
        },
      },
    });
  } catch (error) {
    console.log(req.userId);
    return formatResponse({ res: res, success: false, message: error });
  }
};

export const profile_completion = async (req: Request, res: Response) => {
  try {
    const user = await repository.get(req.userId);
    const breakdown = {
      name: !!user?.name,
      last_name: !!user?.last_name,
      image_profil: !!user?.image_profil,
      username: !!user?.username,
      phone: !!user?.phone && !!user?.dialing_code,
      about: !!user?.about,
      job_preferences:
        Array.isArray((user as any)?.job_category_ids) &&
        (user as any).job_category_ids.length > 0,
      languages:
        Array.isArray((user as any)?.language_ids) &&
        (user as any).language_ids.length > 0,
      country_origin_id: !!(user as any)?.country_origin_id,
      country_residence_id: !!(user as any)?.country_residence_id,
    };

    const percent =
      (breakdown.name ? 10 : 0) +
      (breakdown.last_name ? 10 : 0) +
      (breakdown.image_profil ? 10 : 0) +
      (breakdown.username ? 20 : 0) +
      (breakdown.phone ? 10 : 0) +
      (breakdown.about ? 10 : 0) +
      (breakdown.job_preferences ? 10 : 0) +
      (breakdown.languages ? 10 : 0) +
      (breakdown.country_origin_id ? 5 : 0) +
      (breakdown.country_residence_id ? 5 : 0);

    return formatResponse({
      res,
      success: true,
      body: {
        profile_completion: {
          percent,
          breakdown,
        },
      },
    });
  } catch (error) {
    console.log(req.userId);
    return formatResponse({ res: res, success: false, message: error });
  }
};

export const follows = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const targetResolution = resolveTargetUserId(id, req.userId);
    if (!targetResolution.ok) {
      return formatResponse({
        res,
        success: false,
        code: targetResolution.code,
        message: targetResolution.message,
      });
    }
    const targetId = targetResolution.id;
    const targetCountsPromise = followerRepo.getCounts(targetId);
    const summary = isSummaryMode((req.query as any)?.summary);
    if (summary) {
      const cursorRaw = (req.query as any)?.cursor;
      const limitRaw = (req.query as any)?.limit;
      const limit = limitRaw ? Math.min(Math.max(Number(limitRaw) || 20, 1), 20) : 20;
      const cursor = cursorRaw ? Number(cursorRaw) : null;
      const items = await followerRepo.listFollowingSummary(targetId, req.userId ?? null, {
        cursor,
        limit,
      });
      await enrichFollowUsersWithOrbitState(items, req.userId);
      const targetCounts = await targetCountsPromise;
      const nextCursor =
        items.length >= limit
          ? Number((items[items.length - 1] as any)?.cursor_id ?? 0) || null
          : null;
      res.set("X-Paging-Limit", String(limit));
      res.set("X-Paging-Cursor", cursor == null ? "" : String(cursor));
      res.set("X-Paging-Next-Cursor", nextCursor == null ? "" : String(nextCursor));
      return formatResponse({
        res,
        success: true,
        body: {
          following: items.map((entry: any) => toFollowSummary(entry)),
          follows: items.map((entry: any) => toFollowSummary(entry)),
          followersCount: targetCounts.followersCount,
          followingCount: targetCounts.followingCount,
          followingsCount: targetCounts.followingCount,
          followers_count: targetCounts.followersCount,
          following_count: targetCounts.followingCount,
          followings_count: targetCounts.followingCount,
          counts: {
            followersCount: targetCounts.followersCount,
            followingCount: targetCounts.followingCount,
            followingsCount: targetCounts.followingCount,
            followers_count: targetCounts.followersCount,
            following_count: targetCounts.followingCount,
            followings_count: targetCounts.followingCount,
          },
          nextCursor,
          paging: { next_cursor: nextCursor, limit },
        },
      });
    }
    const follows = await repository.follows(targetId, req.userId);
    await enrichFollowUsersWithOrbitState(follows, req.userId);
    const targetCounts = await targetCountsPromise;

    return formatResponse({
      res: res,
      success: true,
      body: {
        follows,
        following: follows,
        followersCount: targetCounts.followersCount,
        followingCount: targetCounts.followingCount,
        followingsCount: targetCounts.followingCount,
        followers_count: targetCounts.followersCount,
        following_count: targetCounts.followingCount,
        followings_count: targetCounts.followingCount,
        counts: {
          followersCount: targetCounts.followersCount,
          followingCount: targetCounts.followingCount,
          followingsCount: targetCounts.followingCount,
          followers_count: targetCounts.followersCount,
          following_count: targetCounts.followingCount,
          followings_count: targetCounts.followingCount,
        },
        nextCursor: null,
        paging: { next_cursor: null, limit: null },
      },
    });
  } catch (error) {
    console.error("[user/follows] failed", error);
    return formatResponse({
      res: res,
      success: false,
      code: 500,
      message: "Internal error, please consult the administrator",
    });
  }
};

export const followers = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const targetResolution = resolveTargetUserId(id, req.userId);
    if (!targetResolution.ok) {
      return formatResponse({
        res,
        success: false,
        code: targetResolution.code,
        message: targetResolution.message,
      });
    }
    const targetId = targetResolution.id;
    const targetCountsPromise = followerRepo.getCounts(targetId);
    const summary = isSummaryMode((req.query as any)?.summary);
    if (summary) {
      const cursorRaw = (req.query as any)?.cursor;
      const limitRaw = (req.query as any)?.limit;
      const limit = limitRaw ? Math.min(Math.max(Number(limitRaw) || 20, 1), 20) : 20;
      const cursor = cursorRaw ? Number(cursorRaw) : null;
      const items = await followerRepo.listFollowersSummary(targetId, req.userId ?? null, {
        cursor,
        limit,
      });
      await enrichFollowUsersWithOrbitState(items, req.userId);
      const targetCounts = await targetCountsPromise;
      const nextCursor =
        items.length >= limit
          ? Number((items[items.length - 1] as any)?.cursor_id ?? 0) || null
          : null;
      res.set("X-Paging-Limit", String(limit));
      res.set("X-Paging-Cursor", cursor == null ? "" : String(cursor));
      res.set("X-Paging-Next-Cursor", nextCursor == null ? "" : String(nextCursor));
      return formatResponse({
        res,
        success: true,
        body: {
          followers: items.map((entry: any) => toFollowSummary(entry)),
          followersCount: targetCounts.followersCount,
          followingCount: targetCounts.followingCount,
          followingsCount: targetCounts.followingCount,
          followers_count: targetCounts.followersCount,
          following_count: targetCounts.followingCount,
          followings_count: targetCounts.followingCount,
          counts: {
            followersCount: targetCounts.followersCount,
            followingCount: targetCounts.followingCount,
            followingsCount: targetCounts.followingCount,
            followers_count: targetCounts.followersCount,
            following_count: targetCounts.followingCount,
            followings_count: targetCounts.followingCount,
          },
          nextCursor,
          paging: { next_cursor: nextCursor, limit },
        },
      });
    }
    const followers = await repository.followers(targetId, req.userId);
    await enrichFollowUsersWithOrbitState(followers, req.userId);
    const targetCounts = await targetCountsPromise;
    return formatResponse({
      res: res,
      success: true,
      body: {
        followers,
        followersCount: targetCounts.followersCount,
        followingCount: targetCounts.followingCount,
        followingsCount: targetCounts.followingCount,
        followers_count: targetCounts.followersCount,
        following_count: targetCounts.followingCount,
        followings_count: targetCounts.followingCount,
        counts: {
          followersCount: targetCounts.followersCount,
          followingCount: targetCounts.followingCount,
          followingsCount: targetCounts.followingCount,
          followers_count: targetCounts.followersCount,
          following_count: targetCounts.followingCount,
          followings_count: targetCounts.followingCount,
        },
        nextCursor: null,
        paging: { next_cursor: null, limit: null },
      },
    });
  } catch (error) {
    console.error("[user/followers] failed", error);
    return formatResponse({
      res: res,
      success: false,
      code: 500,
      message: "Internal error, please consult the administrator",
    });
  }
};

export const validatePhone = async (req: Request, res: Response) => {
  const { phone, dialing_code } = req.body;

  if (!phone) {
    return formatResponse({ res, success: false, message: "Phone is required" });
  }
  if (!dialing_code) {
    return formatResponse({ res, success: false, message: "Dialing Code is required" });
  }

  try {
    const user = await repository.findByPhone(req.userId, phone, dialing_code);

    return formatResponse({
      res,
      success: true,
      body: { already_exists: !!user },
    });
  } catch (error) {
    console.error("Error in validatePhone:", error);
    return formatResponse({ res, success: false, message: "Internal server error" });
  }
};

const normalizeUsername = (raw: any) => {
  const trimmed = String(raw ?? "").trim();
  const normalized = trimmed.toLowerCase();
  return normalized;
};

const isValidUsername = (username: string) => {
  if (username.length < 1 || username.length > 30) return false;
  return /^[a-z0-9._]+$/.test(username);
};

const buildSuggestions = async (base: string, excludeUserId?: number) => {
  const suggestions: string[] = [];
  const max = 5;
  let counter = 1;

  while (suggestions.length < max && counter <= 30) {
    const suffix = String(100 + counter);
    const candidate = `${base}`.slice(0, 30 - suffix.length) + suffix;
    const available = !(await repository.findByUsernameLower(candidate, excludeUserId));
    if (available && !suggestions.includes(candidate)) suggestions.push(candidate);
    counter += 1;
  }

  return suggestions.slice(0, 5);
};

export const check_username = async (req: Request, res: Response) => {
  try {
    const input = (req.query as any)?.username;
    const username = normalizeUsername(
      String(input ?? "").replace(/^@/, "")
    );

    if (!username || !isValidUsername(username)) {
      return formatResponse({
        res,
        success: true,
        body: { available: false, suggested: [] },
      });
    }

    const existing = await repository.findByUsernameLower(username);
    if (!existing) {
      return formatResponse({
        res,
        success: true,
        body: { available: true },
      });
    }

    const suggested = await buildSuggestions(username);
    return formatResponse({
      res,
      success: true,
      body: { available: false, suggested },
    });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};

export const get_username = async (req: Request, res: Response) => {
  try {
    const raw = (req.params as any)?.username;
    const username = normalizeUsername(String(raw ?? "").replace(/^@/, ""));

    if (!username || !isValidUsername(username)) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: "invalid username",
      });
    }

    const existing = await repository.findByUsernameLower(username);
    if (!existing) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "username not found",
      });
    }

    const payload = { id: existing.id, username: existing.username };
    setCacheControl(res, {
      visibility: "public",
      maxAgeSeconds: 300,
      staleWhileRevalidateSeconds: 1800,
      staleIfErrorSeconds: 3600,
    });
    if (respondNotModifiedIfFresh(req, res, payload)) return;
    return formatResponse({
      res,
      success: true,
      body: payload,
    });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};

export const followers_v2 = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const cursorRaw = (req.query as any)?.cursor;
    const limitRaw = (req.query as any)?.limit;
    const limit = limitRaw ? Math.min(Math.max(Number(limitRaw) || 20, 1), 20) : 20;
    const cursor = cursorRaw ? Number(cursorRaw) : null;
    const targetId = Number(id ?? req.userId);

    if (!Number.isFinite(targetId)) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: "id must be a valid number",
      });
    }
    const targetCountsPromise = followerRepo.getCounts(targetId);

    const items = await followerRepo.listFollowersWithFlags(targetId, req.userId ?? null, {
      cursor,
      limit,
    });
    await enrichFollowUsersWithOrbitState(items, req.userId);
    const targetCounts = await targetCountsPromise;
    const nextCursor =
      items.length >= limit
        ? Number((items[items.length - 1] as any)?.cursor_id ?? 0) || null
        : null;
    res.set("X-Paging-Limit", String(limit));
    res.set("X-Paging-Cursor", cursor == null ? "" : String(cursor));
    res.set("X-Paging-Next-Cursor", nextCursor == null ? "" : String(nextCursor));

    return formatResponse({
      res,
      success: true,
      body: {
        followers: items,
        followersCount: targetCounts.followersCount,
        followingCount: targetCounts.followingCount,
        followingsCount: targetCounts.followingCount,
        followers_count: targetCounts.followersCount,
        following_count: targetCounts.followingCount,
        followings_count: targetCounts.followingCount,
        counts: {
          followersCount: targetCounts.followersCount,
          followingCount: targetCounts.followingCount,
          followingsCount: targetCounts.followingCount,
          followers_count: targetCounts.followersCount,
          following_count: targetCounts.followingCount,
          followings_count: targetCounts.followingCount,
        },
        nextCursor,
        paging: { next_cursor: nextCursor, limit },
      },
    });
  } catch (error) {
    console.error("[user/followers_v2] failed", error);
    return formatResponse({
      res: res,
      success: false,
      code: 500,
      message: "Internal error, please consult the administrator",
    });
  }
};

export const following_v2 = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const cursorRaw = (req.query as any)?.cursor;
    const limitRaw = (req.query as any)?.limit;
    const limit = limitRaw ? Math.min(Math.max(Number(limitRaw) || 20, 1), 20) : 20;
    const cursor = cursorRaw ? Number(cursorRaw) : null;
    const targetId = Number(id ?? req.userId);

    if (!Number.isFinite(targetId)) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: "id must be a valid number",
      });
    }
    const targetCountsPromise = followerRepo.getCounts(targetId);

    const items = await followerRepo.listFollowingWithFlags(targetId, req.userId ?? null, {
      cursor,
      limit,
    });
    await enrichFollowUsersWithOrbitState(items, req.userId);
    const targetCounts = await targetCountsPromise;
    const nextCursor =
      items.length >= limit
        ? Number((items[items.length - 1] as any)?.cursor_id ?? 0) || null
        : null;
    res.set("X-Paging-Limit", String(limit));
    res.set("X-Paging-Cursor", cursor == null ? "" : String(cursor));
    res.set("X-Paging-Next-Cursor", nextCursor == null ? "" : String(nextCursor));

    return formatResponse({
      res: res,
      success: true,
      body: {
        following: items,
        follows: items,
        followersCount: targetCounts.followersCount,
        followingCount: targetCounts.followingCount,
        followingsCount: targetCounts.followingCount,
        followers_count: targetCounts.followersCount,
        following_count: targetCounts.followingCount,
        followings_count: targetCounts.followingCount,
        counts: {
          followersCount: targetCounts.followersCount,
          followingCount: targetCounts.followingCount,
          followingsCount: targetCounts.followingCount,
          followers_count: targetCounts.followersCount,
          following_count: targetCounts.followingCount,
          followings_count: targetCounts.followingCount,
        },
        nextCursor,
        paging: { next_cursor: nextCursor, limit },
      },
    });
  } catch (error) {
    console.error("[user/following_v2] failed", error);
    return formatResponse({
      res: res,
      success: false,
      code: 500,
      message: "Internal error, please consult the administrator",
    });
  }
};

export const relationship = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const targetId = Number(id);

    if (!Number.isFinite(targetId)) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: "id must be a valid number",
      });
    }

    if (!req.userId) {
      return formatResponse({
        res,
        success: true,
        body: { isFollowing: false, isFollowedBy: false, isMutual: false },
      });
    }

    const result = await followerRepo.getRelationship(req.userId, targetId);

    return formatResponse({ res, success: true, body: result });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};

/**
 * ✅ NUEVO: Lista de usuarios que YO bloqueé
 * Ruta: GET /user/blocked
 * Requiere TokenValidation()
 */
export const get_blocked_users = async (req: Request, res: Response) => {
  try {
    // ✅ si no existe en repo, fallará aquí (mejor mensaje)
    if (typeof (repository as any).get_blocked_users !== "function") {
      return formatResponse({
        res,
        success: false,
        message: "repository.get_blocked_users is not implemented",
      });
    }

    const users = await repository.get_blocked_users(req.userId);

    return formatResponse({
      res,
      success: true,
      body: { users },
    });
  } catch (error) {
    console.log(error);
    return formatResponse({ res, success: false, message: error });
  }
};
