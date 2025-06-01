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
  const fallbackIOS = "https://apps.apple.com/app/id123456789";
  const fallback = isAndroid ? fallbackAndroid : fallbackIOS;

  res.setHeader("Content-Type", "text/html");
  res.send(`
    <!DOCTYPE html>
    <html lang="es">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Minhoo</title>
        <style>
          body {
            font-family: sans-serif;
            text-align: center;
            padding: 40px 20px;
          }
          .button {
            display: inline-block;
            margin-top: 20px;
            padding: 12px 24px;
            background-color: #007bff;
            color: white;
            text-decoration: none;
            border-radius: 8px;
            font-size: 18px;
          }
          .small {
            margin-top: 20px;
            font-size: 14px;
            color: #666;
          }
        </style>
        <script>
          // Fallback automático si el usuario no interactúa
          setTimeout(() => {
            window.location.href = "${fallback}";
          }, 3000);
        </script>
      </head>
      <body>
        <h2>Estamos abriendo Minhoo...</h2>
        <p>Si no se abre automáticamente, toca el botón:</p>
        <a class="button" href="${deepLink}">Abrir la app</a>
        <p class="small">Si no tienes la app instalada, serás redirigido a la tienda.</p>
      </body>
    </html>
  `);
});

export default router;
