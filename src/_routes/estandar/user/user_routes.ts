import Router from "express";
import TokenOptional from "../../../libs/middlewares/optional_jwt";
import { TokenValidation } from "../../../libs/middlewares/verify_jwt";
import fs from "fs/promises";

const router = Router();

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
  // âœ… NUEVO (asegÃºrate de exportarlo desde tu controller)
  get_blocked_users,
} from "../../../useCases/user/_controller/controller";

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

/**
 * âœ… NUEVO: LISTAR MIS BLOQUEADOS (para el front)
 * GET /user/blocked
 */
router.get("/blocked", TokenValidation(), get_blocked_users);

router.get("/share/:id", async (req, res) => {
  const userId = req.params.id;

  const userAgent = req.headers["user-agent"] || "";
  const isAndroid = /android/i.test(userAgent);
  const isIOS = /iphone|ipad|ipod/i.test(userAgent);

  const deepLink = `minhoo://profile/${userId}`;
  const fallbackAndroid =
    "https://play.google.com/store/apps/details?id=aud.minhoo.io";
  const fallbackIOS = "https://apps.apple.com/app/6748967902";
  const fallback = isAndroid ? fallbackAndroid : fallbackIOS;

  const filePath = "./src/public/html/share/share.html";

  try {
    let html = await fs.readFile(filePath, "utf8");
    html = html
      .replace(/{{deepLink}}/g, deepLink)
      .replace(/{{fallback}}/g, fallback);

    res.setHeader("Content-Type", "text/html");
    res.send(html);
  } catch (error) {
    console.error("âŒ Error loading HTML file:", error);
    res.status(500).send("Internal Server Error");
  }
});

/**
 * âœ… BLOCK / UNBLOCK (robusto para cualquier front)
 *
 * - Block:
 *   DELETE /user/block/:blocked_id
 *
 * - Unblock:
 *   PATCH  /user/unblock/:blocked_id
 *   DELETE /user/unblock/:blocked_id
 *
 * Nota: Mantengo tus rutas exactamente como las tienes, solo documentadas.
 */
router.delete("/block/:blocked_id", TokenValidation(), block_user);

// Clientes nuevos (PATCH)
router.patch("/unblock/:blocked_id", TokenValidation(), unblock_user);

// Clientes viejos (DELETE)
router.delete("/unblock/:blocked_id", TokenValidation(), unblock_user);

/**
 * âœ… LEGACY: /delete/:id/:flag
 * flag = 0 -> bloquear
 * flag = 1 -> desbloquear
 */
router.delete("/delete/:id/:flag", TokenValidation(), (req: any, res: any) => {
  const { id, flag } = req.params;

  // Normalizamos el nombre del parÃ¡metro para tus controladores actuales
  req.params.blocked_id = id;

  if (flag === "0") return block_user(req, res);
  if (flag === "1") return unblock_user(req, res);

  return res.status(400).json({
    header: { success: false },
    messages: ["flag must be '0' (block) or '1' (unblock)"],
  });
});

export default router;
