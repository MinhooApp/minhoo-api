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
const router = Router();
router.post("/", TokenValidation(), add);
router.get("/", gets);
router.put("/like/:id", TokenValidation(), like);
router.get("/:id", get);
router.delete("/admin/:id", TokenValidation([8088]), deletePostAdmin);
router.delete("/:id", TokenValidation(), deletePost);

router.get("/share/:id", (req, res) => {
  const postId = req.params.id;

  const userAgent = req.headers["user-agent"] || "";

  const isAndroid = /android/i.test(userAgent);
  const isIOS = /iphone|ipad|ipod/i.test(userAgent);

  const deepLink = `minhoo://post/${postId}`;
  const fallbackAndroid =
    "https://play.google.com/store/apps/details?id=aud.minhoo.io";
  const fallbackIOS = "https://apps.apple.com/app/id123456789"; // Reemplaza con tu App Store ID real

  res.setHeader("Content-Type", "text/html");
  res.send(`
    <!DOCTYPE html>
    <html lang="es">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Redirigiendo...</title>
        <style>
          body {
            font-family: sans-serif;
            text-align: center;
            padding-top: 50px;
          }
        </style>
      </head>
      <body>
        <p>Abriendo Minhoo...</p>
        <script>
          setTimeout(function() {
            window.location.href = '${
              isAndroid ? fallbackAndroid : fallbackIOS
            }';
          }, 1500);
          window.location.href = '${deepLink}';
        </script>
      </body>
    </html>
  `);
});

export default router;
