import Router from "express";
import User from "../../../_models/user/user";
import TokenOptional from "../../../libs/middlewares/optional_jwt";
import { TokenValidation } from "../../../libs/middlewares/verify_jwt";
import { createDistributedRateLimiter as createRequestRateLimiter } from "../../../libs/security/redis_rate_limiter";
import {
  get,
  gets,
  search_profiles,
  validatePhone,
  myData,
  follow,
  follow_by_id,
  report,
  follows,
  followers,
  followers_v2,
  following_v2,
  relationship,
  activeAlerts,
  block_user,
  unblock_user,
  remove_follower,
  unfollow_by_id,
  check_username,
  get_username,
  reputation,
  update_username,
  delete_profile_image,
  update_profile,
  profile_completion,
  update_visibility,
  delete_account,
  get_blocked_users,
  submit_profile_verification,
  get_profile_verification_status,
} from "../../../useCases/user/_controller/controller";
import {
  buildCanonicalShareUrl,
  buildDisplayName,
  buildShortText,
  renderShareLandingPage,
  resolveShareAssetUrl,
  resolveStoreFallback,
} from "../../../libs/share_page";
import { respondNotModifiedIfFresh, setCacheControl } from "../../../libs/http_cache";

const router = Router();

const parsePositiveInt = (value: any, fallback: number, min = 1) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.trunc(parsed);
  if (rounded < min) return fallback;
  return rounded;
};

const USER_GRAPH_RATE_WINDOW_MS = parsePositiveInt(
  process.env.USER_GRAPH_RATE_WINDOW_MS,
  15_000
);
const USER_GRAPH_RATE_MAX_ANON = parsePositiveInt(
  process.env.USER_GRAPH_RATE_MAX_ANON ?? process.env.USER_GRAPH_RATE_MAX,
  50
);
const USER_GRAPH_RATE_MAX_AUTH = parsePositiveInt(
  process.env.USER_GRAPH_RATE_MAX_AUTH,
  120
);
const USER_GRAPH_RATE_MAX_AUTH_SELF = parsePositiveInt(
  process.env.USER_GRAPH_RATE_MAX_AUTH_SELF,
  300
);
const USER_GRAPH_RATE_BLOCK_MS = parsePositiveInt(
  process.env.USER_GRAPH_RATE_BLOCK_MS,
  15_000,
  0
);
const APP_RATE_MAX_ENTRIES = parsePositiveInt(
  process.env.APP_RATE_MAX_ENTRIES,
  50_000,
  500
);

const normalizeIp = (rawIp: any) => {
  const ip = String(rawIp ?? "").trim();
  if (!ip) return "unknown";
  if (ip.startsWith("::ffff:")) return ip.slice("::ffff:".length);
  return ip;
};

const resolveGraphScope = (req: any) => {
  const rawPath = String(req?.path ?? req?.route?.path ?? req?.originalUrl ?? "")
    .trim()
    .toLowerCase();
  if (rawPath.includes("/followers")) return "followers";
  if (rawPath.includes("/following")) return "following";
  if (rawPath.includes("/follows")) return "follows";
  return "graph";
};

const resolveGraphTargetUserId = (req: any, authUserId = 0) => {
  const rawTarget = req?.params?.id ?? req?.query?.id;
  const parsedTarget = Number(rawTarget);
  if (Number.isFinite(parsedTarget) && parsedTarget > 0) return Math.trunc(parsedTarget);
  return Number.isFinite(authUserId) && authUserId > 0 ? Math.trunc(authUserId) : 0;
};

const followGraphReadLimiter = createRequestRateLimiter({
  windowMs: USER_GRAPH_RATE_WINDOW_MS,
  max: USER_GRAPH_RATE_MAX_ANON,
  blockDurationMs: USER_GRAPH_RATE_BLOCK_MS,
  maxEntries: APP_RATE_MAX_ENTRIES,
  keyPrefix: "user:follow_graph:read",
  message: "too many follow list requests, try later",
  maxResolver: (req: any) => {
    const authUserId = Number(req?.userId ?? 0);
    const isAuthenticated = Boolean(req?.authenticated) && Number.isFinite(authUserId) && authUserId > 0;
    if (!isAuthenticated) return USER_GRAPH_RATE_MAX_ANON;
    const targetUserId = resolveGraphTargetUserId(req, authUserId);
    const isSelfGraph = targetUserId > 0 && targetUserId === authUserId;
    return isSelfGraph ? USER_GRAPH_RATE_MAX_AUTH_SELF : USER_GRAPH_RATE_MAX_AUTH;
  },
  keyGenerator: (req: any) => {
    const authUserId = Number(req?.userId ?? 0);
    const graphScope = resolveGraphScope(req);
    const targetUserId = resolveGraphTargetUserId(req, authUserId);
    const targetId = String(targetUserId > 0 ? targetUserId : "self")
      .trim()
      .slice(0, 64);
    if (Boolean(req?.authenticated) && Number.isFinite(authUserId) && authUserId > 0) {
      return `u:${authUserId}:${graphScope}:${targetId || "self"}`;
    }
    const ip = normalizeIp(req?.ip ?? req?.socket?.remoteAddress);
    return `ip:${ip}:${graphScope}:${targetId || "self"}`;
  },
});

const buildUserSharePage = async (req: any) => {
  const userId = String(req.params.id ?? "").trim();
  const deepLink = `minhoo://profile/${userId}`;
  const fallbackUrl = resolveStoreFallback(req);
  const canonicalUrl = buildCanonicalShareUrl(req);

  const basePayload = {
    pageTitle: "View this profile on Minhoo",
    metaDescription: "Open this profile in Minhoo.",
    metaImageUrl: null,
    canonicalUrl,
    deepLink,
    fallbackUrl,
    ogType: "profile",
    headline: "A profile was shared with you",
    bodyText: "To view this profile, you'll need the Minhoo app.",
    subText: "Open the app if you already have it, or install it to continue.",
  };

  const numericUserId = Number(userId);
  if (!Number.isFinite(numericUserId) || numericUserId <= 0) return basePayload;

  const user = await User.findOne({
    where: { id: numericUserId, available: true, is_deleted: false },
    attributes: ["id", "name", "last_name", "username", "image_profil", "about"],
  });

  if (!user) return basePayload;

  const displayName = buildDisplayName(user);
  const username = String((user as any).username ?? "").trim();
  const profileFallback = username
    ? `Open ${displayName}'s Minhoo profile.`
    : "Open this profile in Minhoo.";

  return {
    ...basePayload,
    pageTitle: `View ${displayName} on Minhoo`,
    metaDescription: buildShortText((user as any).about, profileFallback),
    metaImageUrl: resolveShareAssetUrl(req, (user as any).image_profil ?? null),
  };
};

router.get("/", TokenValidation(), gets);
router.get("/search", TokenOptional(), search_profiles);
router.post("/follow", TokenValidation(), follow);
router.post("/:id/follow", TokenValidation(), follow_by_id);
router.delete("/:id/follow", TokenValidation(), unfollow_by_id);
router.delete("/follow/:id", TokenValidation(), unfollow_by_id);
router.delete("/follow", TokenValidation(), unfollow_by_id);
router.post("/:id/report", TokenValidation(), report);
router.put("/:id/report", TokenValidation(), report);
router.patch("/:id/report", TokenValidation(), report);
router.post("/report/:id", TokenValidation(), report);
router.put("/report/:id", TokenValidation(), report);
router.patch("/report/:id", TokenValidation(), report);
router.get("/follows/:id?", TokenOptional(), followGraphReadLimiter, follows);
router.get("/followers/:id?", TokenOptional(), followGraphReadLimiter, followers);
router.get("/:id/followers", TokenOptional(), followGraphReadLimiter, followers_v2);
router.get("/:id/following", TokenOptional(), followGraphReadLimiter, following_v2);
router.get("/:id/relationship", TokenOptional(), relationship);
router.get("/username/check", TokenOptional(), check_username);
router.get("/username/:username", TokenOptional(), get_username);
router.get("/:userId/reputation", TokenOptional(), reputation);
router.post("/verification/submit", TokenValidation(), submit_profile_verification);
router.get("/verification/status", TokenValidation(), get_profile_verification_status);
router.get("/one/:id?", TokenOptional(), get);
router.get("/myData", TokenValidation(), myData);
router.post("/phone/validate", TokenValidation(), validatePhone);
router.get("/alert", TokenValidation(), activeAlerts);
router.get("/profile-completion", TokenValidation(), profile_completion);
router.patch("/username", TokenValidation(), update_username);
router.put("/profile", TokenValidation(), update_profile);
router.put("/visibility", TokenValidation(), update_visibility);
router.delete("/image", TokenValidation(), delete_profile_image);
router.delete("/account", TokenValidation(), delete_account);
router.delete("/follower/:followerId", TokenValidation(), remove_follower);
router.post("/remove-follower", TokenValidation(), remove_follower);
router.delete("/:id/follower", TokenValidation(), remove_follower);
router.get("/blocked", TokenValidation(), get_blocked_users);
router.get("/share/:id", async (req, res) => {
  try {
    const html = await renderShareLandingPage(await buildUserSharePage(req));
    setCacheControl(res, {
      visibility: "public",
      maxAgeSeconds: 600,
      staleWhileRevalidateSeconds: 3600,
      staleIfErrorSeconds: 86400,
    });
    if (respondNotModifiedIfFresh(req, res, html)) return;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (error) {
    console.error("❌ Error rendering profile share page:", error);
    res.status(500).send("Internal Server Error");
  }
});
router.delete("/block/:blocked_id", TokenValidation(), block_user);
router.patch("/unblock/:blocked_id", TokenValidation(), unblock_user);
router.delete("/unblock/:blocked_id", TokenValidation(), unblock_user);
router.delete("/delete/:id/:flag", TokenValidation(), (req: any, res: any) => {
  const { id, flag } = req.params;
  req.params.blocked_id = id;

  if (flag === "0") return block_user(req, res);
  if (flag === "1") return unblock_user(req, res);

  return res.status(400).json({
    header: { success: false },
    messages: ["flag must be '0' (block) or '1' (unblock)"],
  });
});

export default router;
