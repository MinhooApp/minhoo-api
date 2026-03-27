import Router from "express";
import Reel from "../../../_models/reel/reel";
import User from "../../../_models/user/user";
import TokenOptional from "../../../libs/middlewares/optional_jwt";
import { TokenValidation } from "../../../libs/middlewares/verify_jwt";
import {
  create_reel,
  add_reel_comment,
  reels_feed,
  reels_suggested,
  reel_by_id,
  reel_comments,
  my_reels,
  user_reels,
  reels_saved,
  reel_download,
  toggle_reel_star,
  save_reel,
  unsave_reel,
  record_reel_view,
  share_reel,
  report,
  delete_reel,
  delete_reel_comment,
} from "../../../useCases/reel/_controller/controller";
import { createRequestRateLimiter } from "../../../libs/middlewares/request_rate_limiter";
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

const APP_RATE_WINDOW_MS = parsePositiveInt(
  process.env.APP_RATE_WINDOW_MS,
  60_000
);
const APP_RATE_MAX_ENTRIES = parsePositiveInt(
  process.env.APP_RATE_MAX_ENTRIES,
  50_000,
  500
);
const reelReadLimiter = createRequestRateLimiter({
  windowMs: APP_RATE_WINDOW_MS,
  max: parsePositiveInt(process.env.REEL_RATE_MAX_READ, 150),
  maxEntries: APP_RATE_MAX_ENTRIES,
  keyPrefix: "reel:read",
  message: "too many reel read requests, try later",
});
const reelWriteLimiter = createRequestRateLimiter({
  windowMs: APP_RATE_WINDOW_MS,
  max: parsePositiveInt(process.env.REEL_RATE_MAX_WRITE, 30),
  maxEntries: APP_RATE_MAX_ENTRIES,
  keyPrefix: "reel:write",
  message: "too many reel write requests, try later",
});
const reelSharePageLimiter = createRequestRateLimiter({
  windowMs: APP_RATE_WINDOW_MS,
  max: parsePositiveInt(process.env.REEL_RATE_MAX_SHARE_PAGE, 120),
  maxEntries: APP_RATE_MAX_ENTRIES,
  keyPrefix: "reel:share_page",
  message: "too many reel share page requests, try later",
});

const buildReelSharePage = async (req: any) => {
  const reelId = String(req.params.id ?? "").trim();
  const deepLink = `minhoo://orbit/${reelId}`;
  const fallbackUrl = resolveStoreFallback(req);
  const canonicalUrl = buildCanonicalShareUrl(req);

  const basePayload = {
    pageTitle: "View this Orbit on Minhoo",
    metaDescription: "Open this Orbit in Minhoo.",
    metaImageUrl: null,
    canonicalUrl,
    deepLink,
    fallbackUrl,
    ogType: "video.other",
    headline: "An Orbit was shared with you",
    bodyText: "To view this Orbit, you'll need the Minhoo app.",
    subText: "Open the app if you already have it, or install it to continue.",
  };

  const numericReelId = Number(reelId);
  if (!Number.isFinite(numericReelId) || numericReelId <= 0) return basePayload;

  const reel = await Reel.findOne({
    where: { id: numericReelId, is_delete: false, status: "ready" },
    attributes: ["id", "description", "thumbnail_url", "visibility"],
    include: [
      {
        model: User,
        as: "user",
        attributes: ["id", "name", "last_name", "username", "image_profil"],
        required: false,
      },
    ],
  });

  if (!reel || String((reel as any).visibility ?? "public") !== "public") {
    return basePayload;
  }

  const authorName = buildDisplayName((reel as any).user);
  return {
    ...basePayload,
    pageTitle: `${authorName} shared an Orbit on Minhoo`,
    metaDescription: buildShortText(
      (reel as any).description,
      "Open this Orbit in Minhoo."
    ),
    metaImageUrl: resolveShareAssetUrl(
      req,
      (reel as any).thumbnail_url ?? (reel as any)?.user?.image_profil ?? null
    ),
  };
};

router.post("/", reelWriteLimiter, TokenValidation(), create_reel);
router.get("/", reelReadLimiter, TokenOptional(), reels_feed);
router.get("/suggested", reelReadLimiter, TokenOptional(), reels_suggested);
router.get("/saved", reelReadLimiter, TokenValidation(), reels_saved);
router.get("/my", reelReadLimiter, TokenValidation(), my_reels);
router.get("/user/:id", reelReadLimiter, TokenOptional(), user_reels);
router.get("/share/:id", reelSharePageLimiter, async (req, res) => {
  try {
    const html = await renderShareLandingPage(await buildReelSharePage(req));
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
    console.error("❌ Error rendering Orbit share page:", error);
    res.status(500).send("Error interno del servidor");
  }
});
router.get("/:id", reelReadLimiter, TokenOptional(), reel_by_id);
router.get("/:id/download", reelReadLimiter, TokenOptional(), reel_download);
router.post("/:id/view", reelWriteLimiter, TokenOptional(), record_reel_view);
router.post("/:id/share", reelWriteLimiter, TokenValidation(), share_reel);
router.post("/:id/report", reelWriteLimiter, TokenValidation(), report);
router.put("/like/:id", reelWriteLimiter, TokenValidation(), toggle_reel_star);
router.put("/star/:id", reelWriteLimiter, TokenValidation(), toggle_reel_star);
router.post("/:id/save", reelWriteLimiter, TokenValidation(), save_reel);
router.delete("/:id/save", reelWriteLimiter, TokenValidation(), unsave_reel);
router.get("/:id/comments", reelReadLimiter, TokenOptional(), reel_comments);
router.post("/:id/comments", reelWriteLimiter, TokenValidation(), add_reel_comment);
router.delete("/comments/:commentId", reelWriteLimiter, TokenValidation(), delete_reel_comment);
router.delete("/:id", reelWriteLimiter, TokenValidation(), delete_reel);

export default router;
