import Router from "express";
import TokenOptional from "../../../libs/middlewares/optional_jwt";
import { TokenValidation } from "../../../libs/middlewares/verify_jwt";
import fs from "fs/promises";

const router = Router();

import {
  get,
  gets,
  myData,
  follow,
  follows,
  followers,
  activeAlerts,
  block_user,
  unblock_user,
  // ✅ NUEVO (asegúrate de exportarlo desde tu controller)
  get_blocked_users,
} from "../../../useCases/user/_controller/controller";

router.get("/", TokenValidation(), gets);
router.post("/follow", TokenValidation(), follow);
router.get("/follows/:id?", TokenOptional(), follows);
router.get("/followers/:id?", TokenOptional(), followers);
router.get("/one/:id?", TokenOptional(), get);
router.get("/myData", TokenValidation(), myData);
router.get("/alert", TokenValidation(), activeAlerts);

/**
 * ✅ NUEVO: LISTAR MIS BLOQUEADOS (para el front)
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
    console.error("❌ Error loading HTML file:", error);
    res.status(500).send("Internal Server Error");
  }
});

/**
 * ✅ BLOCK / UNBLOCK (robusto para cualquier front)
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
 * ✅ LEGACY: /delete/:id/:flag
 * flag = 0 -> bloquear
 * flag = 1 -> desbloquear
 */
router.delete("/delete/:id/:flag", TokenValidation(), (req: any, res: any) => {
  const { id, flag } = req.params;

  // Normalizamos el nombre del parámetro para tus controladores actuales
  req.params.blocked_id = id;

  if (flag === "0") return block_user(req, res);
  if (flag === "1") return unblock_user(req, res);

  return res.status(400).json({
    header: { success: false },
    messages: ["flag must be '0' (block) or '1' (unblock)"],
  });
});

export default router;

