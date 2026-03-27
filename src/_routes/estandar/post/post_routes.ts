import Router from "express";
import Post from "../../../_models/post/post";
import MediaPost from "../../../_models/post/media_post";
import User from "../../../_models/user/user";
import { TokenValidation } from "../../../libs/middlewares/verify_jwt";
import TokenOptional from "../../../libs/middlewares/optional_jwt";
import {
  add,
  get,
  gets,
  getsSuggested,
  like,
  report,
  share,
  deletePost,
  deletePostAdmin,
} from "../../../useCases/post/_controller/controller";
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
const postReadLimiter = createRequestRateLimiter({
  windowMs: APP_RATE_WINDOW_MS,
  max: parsePositiveInt(process.env.POST_RATE_MAX_READ, 150),
  maxEntries: APP_RATE_MAX_ENTRIES,
  keyPrefix: "post:read",
  message: "too many post read requests, try later",
});
const postWriteLimiter = createRequestRateLimiter({
  windowMs: APP_RATE_WINDOW_MS,
  max: parsePositiveInt(process.env.POST_RATE_MAX_WRITE, 25),
  maxEntries: APP_RATE_MAX_ENTRIES,
  keyPrefix: "post:write",
  message: "too many post write requests, try later",
});
const postSharePageLimiter = createRequestRateLimiter({
  windowMs: APP_RATE_WINDOW_MS,
  max: parsePositiveInt(process.env.POST_RATE_MAX_SHARE_PAGE, 120),
  maxEntries: APP_RATE_MAX_ENTRIES,
  keyPrefix: "post:share_page",
  message: "too many post share page requests, try later",
});

const buildPostSharePage = async (req: any) => {
  const postId = String(req.params.id ?? "").trim();
  const deepLink = `minhoo://post/${postId}`;
  const fallbackUrl = resolveStoreFallback(req);
  const canonicalUrl = buildCanonicalShareUrl(req);

  const basePayload = {
    pageTitle: "View this post on Minhoo",
    metaDescription: "Open this post in Minhoo.",
    metaImageUrl: null,
    canonicalUrl,
    deepLink,
    fallbackUrl,
    ogType: "article",
    headline: "A post was shared with you",
    bodyText: "To view this post, you'll need the Minhoo app.",
    subText: "Open the app if you already have it, or install it to continue.",
  };

  const numericPostId = Number(postId);
  if (!Number.isFinite(numericPostId) || numericPostId <= 0) return basePayload;

  const post = await Post.findOne({
    where: { id: numericPostId, is_delete: false },
    attributes: ["id", "post", "userId"],
    include: [
      {
        model: User,
        as: "user",
        attributes: ["id", "name", "last_name", "username", "image_profil"],
        required: false,
      },
    ],
  });

  if (!post) return basePayload;

  const media = await MediaPost.findOne({
    where: { postId: numericPostId },
    attributes: ["id", "url", "is_img"],
    order: [["id", "ASC"]],
  });

  const authorName = buildDisplayName((post as any).user);
  return {
    ...basePayload,
    pageTitle: `${authorName} shared a post on Minhoo`,
    metaDescription: buildShortText((post as any).post, "Open this post in Minhoo."),
    metaImageUrl: resolveShareAssetUrl(
      req,
      (media as any)?.url ?? (post as any)?.user?.image_profil ?? null
    ),
  };
};

router.post("/", postWriteLimiter, TokenValidation(), add);
router.get("/", postReadLimiter, TokenOptional(), gets);
router.get("/suggested", postReadLimiter, TokenOptional(), getsSuggested);
router.put("/like/:id", postWriteLimiter, TokenValidation(), like);
router.post("/:id/report", postWriteLimiter, TokenValidation(), report);
router.post("/:id/share", postWriteLimiter, TokenValidation(), share);
router.get("/:id", postReadLimiter, TokenOptional(), get);
router.delete("/admin/:id", postWriteLimiter, TokenValidation([8088]), deletePostAdmin);
router.delete("/:id", postWriteLimiter, TokenValidation(), deletePost);
router.get("/share/:id", postSharePageLimiter, async (req, res) => {
  try {
    const html = await renderShareLandingPage(await buildPostSharePage(req));
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
    console.error("❌ Error rendering post share page:", error);
    res.status(500).send("Error interno del servidor");
  }
});

export default router;
