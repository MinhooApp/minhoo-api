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
  delete_reel,
  delete_reel_comment,
} from "../../../useCases/reel/_controller/controller";
import {
  buildCanonicalShareUrl,
  buildDisplayName,
  buildShortText,
  renderShareLandingPage,
  resolveShareAssetUrl,
  resolveStoreFallback,
} from "../../../libs/share_page";

const router = Router();

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

router.post("/", TokenValidation(), create_reel);
router.get("/", TokenOptional(), reels_feed);
router.get("/suggested", TokenOptional(), reels_suggested);
router.get("/saved", TokenValidation(), reels_saved);
router.get("/my", TokenValidation(), my_reels);
router.get("/user/:id", TokenOptional(), user_reels);
router.get("/share/:id", async (req, res) => {
  try {
    const html = await renderShareLandingPage(await buildReelSharePage(req));
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (error) {
    console.error("❌ Error rendering Orbit share page:", error);
    res.status(500).send("Error interno del servidor");
  }
});
router.get("/:id", TokenOptional(), reel_by_id);
router.get("/:id/download", TokenOptional(), reel_download);
router.post("/:id/view", TokenOptional(), record_reel_view);
router.post("/:id/share", TokenValidation(), share_reel);
router.put("/like/:id", TokenValidation(), toggle_reel_star);
router.put("/star/:id", TokenValidation(), toggle_reel_star);
router.post("/:id/save", TokenValidation(), save_reel);
router.delete("/:id/save", TokenValidation(), unsave_reel);
router.get("/:id/comments", TokenOptional(), reel_comments);
router.post("/:id/comments", TokenValidation(), add_reel_comment);
router.delete("/comments/:commentId", TokenValidation(), delete_reel_comment);
router.delete("/:id", TokenValidation(), delete_reel);

export default router;
