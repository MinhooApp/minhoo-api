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

router.post("/", TokenValidation(), add);
router.get("/", TokenOptional(), gets);
router.get("/suggested", TokenOptional(), getsSuggested);
router.put("/like/:id", TokenValidation(), like);
router.post("/:id/report", TokenValidation(), report);
router.post("/:id/share", TokenValidation(), share);
router.get("/:id", TokenOptional(), get);
router.delete("/admin/:id", TokenValidation([8088]), deletePostAdmin);
router.delete("/:id", TokenValidation(), deletePost);
router.get("/share/:id", async (req, res) => {
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
