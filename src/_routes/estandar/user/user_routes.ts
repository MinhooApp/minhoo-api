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

router.get("/share/profile/:id", (req, res) => {
  const userId = req.params.id;

  const userAgent = req.headers["user-agent"] || "";

  const isAndroid = /android/i.test(userAgent);
  const isIOS = /iphone|ipad|ipod/i.test(userAgent);

  const deepLink = `minhoo://profile/${userId}`;
  const fallbackAndroid =
    "https://play.google.com/store/apps/details?id=aud.minhoo.io";
  const fallbackIOS = "https://apps.apple.com/app/id123456789"; // tu ID real de App Store

  res.setHeader("Content-Type", "text/html");
  res.send(`
    <!DOCTYPE html>
    <html lang="es">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Redirigiendo al perfil...</title>
        <style>
          body {
            font-family: sans-serif;
            text-align: center;
            padding-top: 50px;
          }
        </style>
      </head>
      <body>
        <p>Abriendo perfil en Minhoo...</p>
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
