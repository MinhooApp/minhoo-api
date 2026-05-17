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
import { sendUnifiedSuccess } from "../../../libs/unified_response";
import { getUserReputation } from "../../../repository/user/user_reputation_repository";
import logger from "../../../libs/logger/logger";

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

const sendAdminProfileUnavailable = (
  req: Request,
  res: Response,
  params?: { code?: string; message?: string; status?: number }
) => {
  const status = Number(params?.status ?? 404) || 404;
  const message =
    String(params?.message ?? "admin profile is unavailable").trim() ||
    "admin profile is unavailable";
  const code = String(params?.code ?? "ADMIN_PROFILE_UNAVAILABLE").trim() ||
    "ADMIN_PROFILE_UNAVAILABLE";
  const authenticated = Number(req.userId) > 0;
  return res.status(status).json({
    success: false,
    code,
    message,
    header: {
      success: false,
      authenticated,
      message,
      messages: [message],
    },
    messages: [message],
    body: { code },
  });
};

const assignAdminMarkersToUserObject = (userRaw: any, isAdmin: boolean) => {
  if (!userRaw) return;
  const fields: Record<string, any> = {
    is_admin: isAdmin,
    isAdmin: isAdmin,
  };

  if (typeof (userRaw as any)?.setDataValue === "function") {
    Object.entries(fields).forEach(([key, value]) => {
      (userRaw as any).setDataValue(key, value);
    });
    return;
  }

  const roles = isAdmin
    ? [{ id: 8088, role: "admin", description: "admin role" }]
    : Array.isArray((userRaw as any)?.roles)
    ? (userRaw as any).roles
    : [];
  Object.assign(userRaw, { ...fields, roles });
};

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

const toBoundedRate = (value: any) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  const bounded = Math.min(Math.max(parsed, 0), 5);
  return Math.round(bounded * 10) / 10;
};

const buildReputationSummary = (data: any) => {
  const customer = data?.customer ?? null;
  const worker = data?.worker ?? null;
  const customerRate = toBoundedRate(customer?.rate ?? customer?.rating);
  const workerRate = toBoundedRate(worker?.rate ?? worker?.rating);
  const customerReviewsCount = Math.max(0, Number(customer?.reviews_count ?? 0) || 0);
  const workerReviewsCount = Math.max(0, Number(worker?.reviews_count ?? 0) || 0);
  const primaryRate = workerRate > 0 ? workerRate : customerRate;
  const primaryReviewsCount = workerRate > 0 ? workerReviewsCount : customerReviewsCount;

  return {
    primaryRate,
    primaryReviewsCount,
    customerRate,
    workerRate,
    customerReviewsCount,
    workerReviewsCount,
  };
};

const loadUserReputationSnapshot = async (userIdRaw: any) => {
  const reputationResult = await getUserReputation({
    userIdRaw,
    pageRaw: 1,
    limitRaw: 20,
  });

  if (!(reputationResult as any)?.success) {
    return {
      data: { customer: null, worker: null },
      summary: buildReputationSummary({ customer: null, worker: null }),
    };
  }

  const data = (reputationResult as any)?.data ?? { customer: null, worker: null };
  return {
    data,
    summary: buildReputationSummary(data),
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

const hasNonEmptyText = (value: any): boolean =>
  String(value ?? "").trim().length > 0;

const hasArrayValues = (value: any): boolean =>
  Array.isArray(value) && value.length > 0;

const hasPositiveId = (value: any): boolean => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
};

const hasAnyPositiveId = (...values: any[]): boolean => values.some((value) => hasPositiveId(value));

const buildProfileCompletion = (user: any) => {
  const workerAbout = (user as any)?.worker?.about;
  const workerCategories = (user as any)?.worker?.categories;
  const hasCountryOrigin =
    hasAnyPositiveId(
      (user as any)?.country_origin_id,
      (user as any)?.countryOriginId,
      (user as any)?.origin_country_id,
      (user as any)?.originCountryId,
      (user as any)?.origin?.country_id,
      (user as any)?.origin?.countryId,
      (user as any)?.origin?.country?.id
    ) ||
    hasNonEmptyText((user as any)?.country_origin_code) ||
    hasNonEmptyText((user as any)?.countryOriginCode) ||
    hasNonEmptyText((user as any)?.origin_country_code) ||
    hasNonEmptyText((user as any)?.originCountryCode) ||
    hasNonEmptyText((user as any)?.origin?.country_code) ||
    hasNonEmptyText((user as any)?.origin?.countryCode) ||
    hasNonEmptyText((user as any)?.origin?.country?.code);
  const hasCountryResidence =
    hasAnyPositiveId(
      (user as any)?.country_residence_id,
      (user as any)?.countryResidenceId,
      (user as any)?.country_id,
      (user as any)?.countryId,
      (user as any)?.residence?.country_id,
      (user as any)?.residence?.countryId,
      (user as any)?.residence?.country?.id,
      (user as any)?.state_residence_id,
      (user as any)?.stateResidenceId,
      (user as any)?.state_id,
      (user as any)?.stateId,
      (user as any)?.residence?.state_id,
      (user as any)?.residence?.stateId,
      (user as any)?.residence?.state?.id,
      (user as any)?.city_residence_id,
      (user as any)?.cityResidenceId,
      (user as any)?.city_id,
      (user as any)?.cityId,
      (user as any)?.residence?.city_id,
      (user as any)?.residence?.cityId,
      (user as any)?.residence?.city?.id
    ) ||
    hasNonEmptyText((user as any)?.city_residence_name) ||
    hasNonEmptyText((user as any)?.cityResidenceName) ||
    hasNonEmptyText((user as any)?.city_name) ||
    hasNonEmptyText((user as any)?.cityName) ||
    hasNonEmptyText((user as any)?.residence?.city_name) ||
    hasNonEmptyText((user as any)?.residence?.cityName) ||
    hasNonEmptyText((user as any)?.residence?.city?.name);

  const breakdown = {
    name: hasNonEmptyText(user?.name),
    last_name: hasNonEmptyText(user?.last_name),
    image_profil: hasNonEmptyText(user?.image_profil),
    username: hasNonEmptyText(user?.username),
    phone: hasNonEmptyText(user?.phone) && hasNonEmptyText(user?.dialing_code),
    // Some worker flows persist "about" in worker.about instead of users.about.
    // Accept either source so directory activation reflects actual profile state.
    about: hasNonEmptyText(user?.about) || hasNonEmptyText(workerAbout),
    job_preferences:
      hasArrayValues((user as any)?.job_category_ids) || hasArrayValues(workerCategories),
    // Accept explicit language_ids or preferred language fallback.
    languages:
      hasArrayValues((user as any)?.language_ids) ||
      hasArrayValues((user as any)?.language_codes) ||
      hasArrayValues((user as any)?.language_names) ||
      hasNonEmptyText((user as any)?.language),
    // Keep legacy keys for frontend compatibility, but evaluate with broader location aliases.
    country_origin_id: hasCountryOrigin,
    country_residence_id: hasCountryResidence,
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

  return { percent, breakdown };
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
    const modeRaw = (req.query as any)?.mode ?? "all";
    const page = Number.isFinite(Number(pageRaw)) && Number(pageRaw) >= 0 ? Math.floor(Number(pageRaw)) : 0;
    const sizeNumber = Number.isFinite(Number(sizeRaw)) ? Math.floor(Number(sizeRaw)) : 20;
    const size = Math.min(Math.max(sizeNumber, 1), 20);
    const mode = String(modeRaw ?? "all")
      .trim()
      .toLowerCase() === "username"
      ? "username"
      : "all";
    const query = String(qRaw ?? "")
      .trim()
      .toLowerCase()
      .replace(/^@+/, "")
      .replace(/\s+/g, " ");
    const users: any = await repository.search_profiles(
      query,
      req.userId ?? -1,
      page,
      size,
      mode
    );

    return sendUnifiedSuccess(res, {
      items: users.rows ?? [],
      users: users.rows ?? [],
      count: Number(users.count ?? 0),
      page,
      size,
      next_cursor: null,
    });
  } catch (error) {
    return formatResponse({ res: res, success: false, message: error });
  }
};

export const get = async (req: Request, res: Response) => {
  const { id } = req.params;

  try {
    setPrivateNoStore(res);
    const hasExplicitTargetId =
      id !== undefined &&
      id !== null &&
      String(id).trim().length > 0;
    const targetIdCandidate = hasExplicitTargetId ? Number(id) : Number(req.userId);
    const viewerId = Number(req.userId);
    const allowOwnAdminProfile =
      Number.isFinite(viewerId) &&
      viewerId > 0 &&
      Number.isFinite(targetIdCandidate) &&
      targetIdCandidate > 0 &&
      Math.trunc(viewerId) === Math.trunc(targetIdCandidate);

    let targetIsAdmin = false;
    if (
      Number.isFinite(targetIdCandidate) &&
      targetIdCandidate > 0 &&
      !allowOwnAdminProfile
    ) {
      targetIsAdmin = await repository.isUserAdminById(targetIdCandidate);
    }

    const user = await repository.get(id, req.userId);
    if (user) {
      attachAvatarAliases(user);
      const resolvedTargetUserId = Number((user as any)?.id ?? targetIdCandidate);
      if (Number.isFinite(resolvedTargetUserId) && resolvedTargetUserId > 0) {
        targetIsAdmin = await repository.isUserAdminById(resolvedTargetUserId);
      }
      assignAdminMarkersToUserObject(user, targetIsAdmin);
    }

    const targetId = Number((user as any)?.id ?? id);
    const relationshipPromise =
      Number.isFinite(viewerId) &&
      viewerId > 0 &&
      Number.isFinite(targetId) &&
      targetId > 0 &&
      viewerId !== targetId
        ? followerRepo.getRelationship(viewerId, targetId)
        : Promise.resolve(null);

    const [counts, relationshipRaw, _orbitState, _likedState, _savedState, reputationSnapshot] =
      await Promise.all([
      enrichUserFollowCounts(user),
      relationshipPromise,
      attachActiveOrbitStateToUsers({
        usersRaw: [user].filter(Boolean),
        viewerIdRaw: req.userId,
      }),
      attachLikedStateToUserPosts(req.userId, user),
      attachSavedStateToUserPosts(req.userId, user),
      loadUserReputationSnapshot(targetId),
    ]);

    const relationship = normalizeRelationship(relationshipRaw);
    attachRelationshipAliasesToUser(user, relationship);
    const { percent, breakdown } = buildProfileCompletion(user);
    const profileVerified = Boolean(
      (user as any)?.profile_verified ??
        (user as any)?.profileVerified ??
        (user as any)?.verified_badge ??
        false
    );
    const profileVerificationStatus = String(
      (user as any)?.profile_verification_status ??
        (user as any)?.profileVerificationStatus ??
        "unverified"
    )
      .trim()
      .toLowerCase();

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
        reputation: reputationSnapshot.data,
        reputation_summary: reputationSnapshot.summary,
        ratings_summary: reputationSnapshot.summary,
        rate: reputationSnapshot.summary.primaryRate,
        rating: reputationSnapshot.summary.primaryRate,
        reviews_count: reputationSnapshot.summary.primaryReviewsCount,
        customer_rate: reputationSnapshot.summary.customerRate,
        customer_reviews_count: reputationSnapshot.summary.customerReviewsCount,
        worker_rate: reputationSnapshot.summary.workerRate,
        worker_reviews_count: reputationSnapshot.summary.workerReviewsCount,
        profile_verified: profileVerified,
        profileVerified,
        verified_badge: profileVerified,
        is_verified_profile: profileVerified,
        profile_verification_status: profileVerificationStatus,
        profileVerificationStatus,
        is_admin: targetIsAdmin,
        isAdmin: targetIsAdmin,
        roles: targetIsAdmin
          ? [{ id: 8088, role: "admin", description: "admin role" }]
          : Array.isArray((user as any)?.roles)
          ? (user as any).roles
          : [],
      },
    });
  } catch (error) {
    console.error(
      `[user/get one] error ${JSON.stringify({
        viewerId: Number((req as any)?.userId ?? 0) || null,
        targetIdRaw: (req.params as any)?.id ?? null,
        errorName: (error as any)?.name ?? null,
        errorMessage: (error as any)?.message ?? null,
        stack: (error as any)?.stack ?? null,
      })}`
    );
    return formatResponse({ res: res, success: false, message: error });
  }
};

export const myData = async (req: Request, res: Response) => {
  try {
    setPrivateNoStore(res);
    const user = await repository.get(req.userId);
    attachAvatarAliases(user);
    const [counts, _likedState, _savedState, reputationSnapshot] = await Promise.all([
      enrichUserFollowCounts(user),
      attachLikedStateToUserPosts(req.userId, user),
      attachSavedStateToUserPosts(req.userId, user),
      loadUserReputationSnapshot(req.userId),
    ]);
    const { percent, breakdown } = buildProfileCompletion(user);
    const profileVerified = Boolean(
      (user as any)?.profile_verified ??
        (user as any)?.profileVerified ??
        (user as any)?.verified_badge ??
        false
    );
    const profileVerificationStatus = String(
      (user as any)?.profile_verification_status ??
        (user as any)?.profileVerificationStatus ??
        "unverified"
    )
      .trim()
      .toLowerCase();

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
        reputation: reputationSnapshot.data,
        reputation_summary: reputationSnapshot.summary,
        ratings_summary: reputationSnapshot.summary,
        rate: reputationSnapshot.summary.primaryRate,
        rating: reputationSnapshot.summary.primaryRate,
        reviews_count: reputationSnapshot.summary.primaryReviewsCount,
        customer_rate: reputationSnapshot.summary.customerRate,
        customer_reviews_count: reputationSnapshot.summary.customerReviewsCount,
        worker_rate: reputationSnapshot.summary.workerRate,
        worker_reviews_count: reputationSnapshot.summary.workerReviewsCount,
        profile_verified: profileVerified,
        profileVerified,
        verified_badge: profileVerified,
        is_verified_profile: profileVerified,
        profile_verification_status: profileVerificationStatus,
        profileVerificationStatus,
      },
    });
  } catch (error) {
    console.log(req.userId);
    return formatResponse({ res: res, success: false, message: error });
  }
};

export const reputation = async (req: Request, res: Response) => {
  try {
    const reputationResult = await getUserReputation({
      userIdRaw: (req.params as any)?.userId,
      pageRaw: (req.query as any)?.page,
      limitRaw: (req.query as any)?.limit,
    });

    if ((reputationResult as any)?.invalidUserId) {
      return res.status(400).json({
        success: false,
        message: "userId must be a valid number",
      });
    }

    if ((reputationResult as any)?.notFound) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: (reputationResult as any)?.data ?? { customer: null, worker: null },
    });
  } catch (error: any) {
    console.log("[user/reputation] error", error);
    return res.status(500).json({
      success: false,
      message: error?.message ?? "Internal server error",
    });
  }
};

export const profile_completion = async (req: Request, res: Response) => {
  try {
    const user = await repository.get(req.userId);
    const { percent, breakdown } = buildProfileCompletion(user);

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
    setPrivateNoStore(res);
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
      const hasMore = nextCursor !== null;
      const isLastPage = !hasMore;
      res.set("X-Paging-Limit", String(limit));
      res.set("X-Paging-Cursor", cursor == null ? "" : String(cursor));
      res.set("X-Paging-Next-Cursor", nextCursor == null ? "" : String(nextCursor));
      res.set("X-Paging-Has-More", hasMore ? "1" : "0");
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
          hasMore,
          has_more: hasMore,
          isLastPage,
          is_last_page: isLastPage,
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
        hasMore: false,
        has_more: false,
        isLastPage: true,
        is_last_page: true,
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
    setPrivateNoStore(res);
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
      const hasMore = nextCursor !== null;
      const isLastPage = !hasMore;
      res.set("X-Paging-Limit", String(limit));
      res.set("X-Paging-Cursor", cursor == null ? "" : String(cursor));
      res.set("X-Paging-Next-Cursor", nextCursor == null ? "" : String(nextCursor));
      res.set("X-Paging-Has-More", hasMore ? "1" : "0");
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
          hasMore,
          has_more: hasMore,
          isLastPage,
          is_last_page: isLastPage,
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
        hasMore: false,
        has_more: false,
        isLastPage: true,
        is_last_page: true,
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
    logger.error({ event: "error", error: String(error), stack: (error as Error)?.stack });
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
    logger.error({ event: "error", error: String(error), stack: (error as Error)?.stack });
    return formatResponse({ res: res, success: false, message: error });
  }
};

export const followers_v2 = async (req: Request, res: Response) => {
  try {
    setPrivateNoStore(res);
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
    const hasMore = nextCursor !== null;
    const isLastPage = !hasMore;
    res.set("X-Paging-Limit", String(limit));
    res.set("X-Paging-Cursor", cursor == null ? "" : String(cursor));
    res.set("X-Paging-Next-Cursor", nextCursor == null ? "" : String(nextCursor));
    res.set("X-Paging-Has-More", hasMore ? "1" : "0");

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
        hasMore,
        has_more: hasMore,
        isLastPage,
        is_last_page: isLastPage,
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
    setPrivateNoStore(res);
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
    const hasMore = nextCursor !== null;
    const isLastPage = !hasMore;
    res.set("X-Paging-Limit", String(limit));
    res.set("X-Paging-Cursor", cursor == null ? "" : String(cursor));
    res.set("X-Paging-Next-Cursor", nextCursor == null ? "" : String(nextCursor));
    res.set("X-Paging-Has-More", hasMore ? "1" : "0");

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
        hasMore,
        has_more: hasMore,
        isLastPage,
        is_last_page: isLastPage,
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
    setPrivateNoStore(res);
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
    logger.error({ event: "error", error: String(error), stack: (error as Error)?.stack });
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
    logger.error({ event: "error", error: String(error), stack: (error as Error)?.stack });
    return formatResponse({ res, success: false, message: error });
  }
};
