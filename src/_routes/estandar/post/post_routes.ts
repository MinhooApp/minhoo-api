import path from "path";
import fs from "fs/promises";
import Router from "express";
import {
  add,
  get,
  gets,
  like,
  deletePost,
  deletePostAdmin,
} from "../../../useCases/post/_controller/controller";
import { TokenValidation } from "../../../libs/middlewares/verify_jwt";
import TokenOptional from "../../../libs/middlewares/optional_jwt";
const router = Router();
router.post("/", TokenValidation(), add);
//router.get("/", gets);
router.get("/", TokenOptional(), gets);
router.put("/like/:id", TokenValidation(), like);
router.get("/:id", get);
router.delete("/admin/:id", TokenValidation([8088]), deletePostAdmin);
router.delete("/:id", TokenValidation(), deletePost);
router.get("/share/:id", async (req, res) => {
  const postId = req.params.id;

  const userAgent = req.headers["user-agent"] || "";

  const isAndroid = /android/i.test(userAgent);
  const isIOS = /iphone|ipad|ipod/i.test(userAgent);

  const deepLink = `minhoo://post/${postId}`;
  const fallbackAndroid =
    "https://play.google.com/store/apps/details?id=aud.minhoo.io";
  const fallbackIOS = "https://apps.apple.com/app/6748967902";
  const fallback = isAndroid ? fallbackAndroid : fallbackIOS;

  // Ajusta esta ruta si tu archivo está en otra ubicación
  const filePath = "./src/public/html/share/share.html";

  try {
    let html = await fs.readFile(filePath, "utf8");

    html = html
      .replace(/{{deepLink}}/g, deepLink)
      .replace(/{{fallback}}/g, fallback);

    res.setHeader("Content-Type", "text/html");
    res.send(html);
  } catch (error) {
    console.error("❌ Error al leer el archivo HTML:", error);
    res.status(500).send("Error interno del servidor");
  }
});

export default router;
