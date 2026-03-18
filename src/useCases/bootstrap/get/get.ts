import {
  Request,
  Response,
  formatResponse,
  postRepository,
  reelRepository,
  serviceRepository,
  notificationRepository,
  savedRepository,
} from "../_module/module";
import crypto from "crypto";
import { respondNotModifiedIfFresh, setCacheControl } from "../../../libs/http_cache";
import * as userRepository from "../../../repository/user/user_repository";
import { AppLocale, resolveLocale } from "../../../libs/localization/locale";
import {
  toNotificationSummary,
  toPostSummary,
  toReelSummary,
  toServiceSummary,
} from "../../../libs/summary_response";

const normalizeSize = (value: any, fallback: number, max = 10) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.max(1, Math.floor(parsed)), max);
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

const parseIncludeSections = (raw: any) => {
  const defaults = new Set(["posts", "reels", "services", "notifications"]);
  const input = String(raw ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  if (!input.length) return defaults;
  const valid = input.filter((item) => defaults.has(item));
  if (!valid.length) return defaults;
  return new Set(valid);
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

  const viewerId = Number(viewerIdRaw ?? 0);
  const postIds = posts
    .map((post: any) => Number(post?.id))
    .filter((id: number) => Number.isFinite(id) && id > 0);

  posts.forEach((post: any) => {
    setSavedCount(post, normalizeCount((post as any)?.saves_count));
  });

  if (!Number.isFinite(viewerId) || viewerId <= 0) {
    posts.forEach((post: any) => setSavedFlag(post, false));
    return;
  }

  const savedSet = await savedRepository.getSavedPostIdSet(viewerId, postIds);
  posts.forEach((post: any) => {
    setSavedFlag(post, savedSet.has(Number(post?.id)));
  });
};

const resolveRequestLocale = async (req: Request, viewerId: number | null): Promise<AppLocale> => {
  const preferredLanguage =
    (req.query as any)?.language ??
    (req.query as any)?.lang ??
    req.header("x-app-language") ??
    req.header("x-language") ??
    req.header("x-lang");
  const acceptLanguage = req.header("accept-language");

  if (!viewerId) {
    return resolveLocale({
      preferredLanguage,
      acceptLanguage,
    });
  }

  try {
    const pushSettings = await userRepository.getPushSettings(viewerId);
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

export const home = async (req: Request, res: Response) => {
  try {
    const include = parseIncludeSections((req.query as any)?.include);
    const sessionKey = toSessionKey(req);
    const viewerId = Number((req as any)?.userId ?? 0) || null;
    const locale = await resolveRequestLocale(req, viewerId);
    const failedSections = new Set<string>();

    const postsSize = normalizeSize((req.query as any)?.posts_size, 5, 20);
    const reelsSize = normalizeSize((req.query as any)?.reels_size, 6, 20);
    const servicesSize = normalizeSize((req.query as any)?.services_size, 4, 20);
    const notificationsLimit = normalizeSize((req.query as any)?.notifications_limit, 5, 20);

    const loadSection = async <T>(key: string, loader: () => Promise<T>): Promise<T | null> => {
      try {
        return await loader();
      } catch (error) {
        failedSections.add(key);
        console.error(`[bootstrap/home] section '${key}' failed`, error);
        return null;
      }
    };

    const [postsRaw, reelsRaw, servicesRaw, notificationsData] = await Promise.all([
      include.has("posts")
        ? loadSection("posts", () => postRepository.getsSummary(0, postsSize, req.userId, { sessionKey }))
        : Promise.resolve(null),
      include.has("reels")
        ? loadSection("reels", () =>
            reelRepository.listFeed(0, reelsSize, req.userId, false, {
              sessionKey,
              summary: true,
            })
          )
        : Promise.resolve(null),
      include.has("services")
        ? loadSection("services", () => serviceRepository.getsSummary(servicesSize))
        : Promise.resolve(null),
      include.has("notifications") && viewerId
        ? loadSection("notifications", async () => {
            const [items, unreadCount] = await Promise.all([
              notificationRepository.myNotificationsSummary(viewerId, {
                limit: notificationsLimit,
                cursor: null,
              }),
              notificationRepository.countUnreadByUser(viewerId),
            ]);
            return {
              items,
              unreadCount: Number(unreadCount ?? 0) || 0,
            };
          })
        : Promise.resolve(null),
    ]);

    await attachSavedFlags(req.userId, postsRaw?.rows ?? []);

    const sections: any = {};

    if (include.has("posts") && postsRaw) {
      sections.posts = {
        page: 0,
        size: postsSize,
        count: Number(postsRaw?.count ?? 0) || 0,
        items: (postsRaw?.rows ?? []).map((post: any) => toPostSummary(post, req.userId)),
      };
    }

    if (include.has("reels") && reelsRaw) {
      sections.reels = {
        page: 0,
        size: reelsSize,
        count: Number(reelsRaw?.count ?? 0) || 0,
        items: (reelsRaw?.rows ?? []).map((reel: any) => toReelSummary(reel)),
      };
    }

    if (include.has("services") && servicesRaw) {
      sections.services = {
        size: servicesSize,
        items: (servicesRaw ?? []).map((service: any) => toServiceSummary(service)),
      };
    }

    if (include.has("notifications")) {
      if (viewerId && notificationsData) {
        sections.notifications = {
          limit: notificationsLimit,
          unreadCount: Number((notificationsData as any)?.unreadCount ?? 0) || 0,
          items: ((notificationsData as any)?.items ?? []).map((notification: any) =>
            toNotificationSummary(notification, locale)
          ),
        };
      } else if (!viewerId) {
        sections.notifications = {
          limit: notificationsLimit,
          unreadCount: 0,
          items: [],
        };
      }
    }

    const payload = {
      meta: {
        authenticated: Boolean((req as any)?.authenticated && viewerId),
        userId: viewerId,
        requestedSections: Array.from(include),
        loadedSections: Object.keys(sections),
        failedSections: Array.from(failedSections),
      },
      sections,
    };

    setCacheControl(res, {
      visibility: viewerId ? "private" : "public",
      maxAgeSeconds: 15,
      staleWhileRevalidateSeconds: 30,
      staleIfErrorSeconds: 60,
    });
    if (respondNotModifiedIfFresh(req, res, payload)) return;

    return formatResponse({
      res,
      success: true,
      body: payload,
    });
  } catch (error) {
    console.log(error);
    return formatResponse({ res, success: false, message: error });
  }
};
