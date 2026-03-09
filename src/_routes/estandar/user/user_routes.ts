import Router from "express";
import User from "../../../_models/user/user";
import TokenOptional from "../../../libs/middlewares/optional_jwt";
import { TokenValidation } from "../../../libs/middlewares/verify_jwt";
import {
  get,
  gets,
  search_profiles,
  myData,
  follow,
  follow_by_id,
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
  update_username,
  delete_profile_image,
  update_profile,
  profile_completion,
  update_visibility,
  delete_account,
  get_blocked_users,
} from "../../../useCases/user/_controller/controller";
import {
  buildCanonicalShareUrl,
  buildDisplayName,
  buildShortText,
  renderShareLandingPage,
  resolveShareAssetUrl,
  resolveStoreFallback,
} from "../../../libs/share_page";

const router = Router();

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
router.get("/follows/:id?", TokenOptional(), follows);
router.get("/followers/:id?", TokenOptional(), followers);
router.get("/:id/followers", TokenOptional(), followers_v2);
router.get("/:id/following", TokenOptional(), following_v2);
router.get("/:id/relationship", TokenOptional(), relationship);
router.get("/username/check", TokenOptional(), check_username);
router.get("/username/:username", TokenOptional(), get_username);
router.get("/one/:id?", TokenOptional(), get);
router.get("/myData", TokenValidation(), myData);
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
