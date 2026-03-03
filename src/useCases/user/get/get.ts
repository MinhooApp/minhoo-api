import {
  Request,
  Response,
  formatResponse,
  repository,
  followerRepo,
} from "../_module/module";

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

export const gets = async (req: Request, res: Response) => {
  try {
    const { page = 0, size = 5 } = req.query;
    const users: any = await repository.users(page, size);
    return formatResponse({
      res: res,
      success: true,
      body: {
        page: +page,
        size: +size,
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
    const size = Math.min(Math.max(sizeNumber, 1), 100);
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

export const myData = async (req: Request, res: Response) => {
  try {
    const user = await repository.get(req.userId);
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
    const follows = await repository.follows(id ?? req.userId, req.userId);

    return formatResponse({ res: res, success: true, body: { follows } });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};

export const followers = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const followers = await repository.followers(id ?? req.userId, req.userId);
    return formatResponse({ res: res, success: true, body: { followers } });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
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

    return formatResponse({
      res,
      success: true,
      body: { id: existing.id, username: existing.username },
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
    const targetId = Number(id ?? req.userId);

    if (!Number.isFinite(targetId)) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: "id must be a valid number",
      });
    }

    const items = await followerRepo.listFollowersWithFlags(targetId, req.userId ?? null, {
      cursor: cursorRaw ? Number(cursorRaw) : null,
      limit: limitRaw ? Number(limitRaw) : undefined,
    });

    return formatResponse({ res, success: true, body: { followers: items } });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};

export const following_v2 = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const cursorRaw = (req.query as any)?.cursor;
    const limitRaw = (req.query as any)?.limit;
    const targetId = Number(id ?? req.userId);

    if (!Number.isFinite(targetId)) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: "id must be a valid number",
      });
    }

    const items = await followerRepo.listFollowingWithFlags(targetId, req.userId ?? null, {
      cursor: cursorRaw ? Number(cursorRaw) : null,
      limit: limitRaw ? Number(limitRaw) : undefined,
    });

    return formatResponse({ res: res, success: true, body: { following: items } });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
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
