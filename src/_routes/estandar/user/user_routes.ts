import Router from "express";
import { TokenValidation } from "../../../libs/middlewares/verify_jwt";
const router = Router();
import {
  get,
  gets,
  myData,
  follow,
  follows,
  followers,
  activeAlerts,
  validatePhone,
} from "../../../useCases/user/_controller/controller";
router.get("/", TokenValidation(), gets);
router.post("/follow", TokenValidation(), follow);
router.get("/follows/:id?", TokenValidation(), follows);
router.get("/followers/:id?", TokenValidation(), followers);
router.get("/one/:id?", get);
router.get("/myData", TokenValidation(), myData);
router.get("/alert", TokenValidation(), activeAlerts);
router.post("/phone/validate", TokenValidation(), validatePhone);

router.get("/share/:id", (req, res) => {
  const postId = req.params.id;

  const userAgent = req.headers["user-agent"] || "";
  const isAndroid = /android/i.test(userAgent);
  const isIOS = /iphone|ipad|ipod/i.test(userAgent);

  const deepLink = `minhoo://profile/${postId}`;
  const fallbackAndroid =
    "https://play.google.com/store/apps/details?id=aud.minhoo.io";
  const fallbackIOS = "https://apps.apple.com/app/id123456789";

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
            padding-top: 40px;
          }
          a.button {
            display: inline-block;
            margin-top: 20px;
            padding: 12px 20px;
            background-color: #007bff;
            color: white;
            text-decoration: none;
            border-radius: 8px;
            font-size: 18px;
          }
        </style>
      </head>
      <body>
        <h2>¿Tienes instalada la app Minhoo?</h2>
        <a class="button" href="${deepLink}">Abrir la app</a>
        <p>Si no tienes la app, instálala aquí:</p>
        <a href="${
          isAndroid ? fallbackAndroid : fallbackIOS
        }" class="button">Ir a la tienda</a>
      </body>
    </html>
  `);
});

export default router;
