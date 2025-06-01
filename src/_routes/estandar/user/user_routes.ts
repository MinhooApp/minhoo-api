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
          margin: 0;
          padding: 0;
          font-family: "Helvetica Neue", sans-serif;
          background-color: #ffffff;
          color: #333333;
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
          height: 100vh;
          text-align: center;
        }
        h1 {
          color: #FBB03B;
          font-size: 24px;
          margin-bottom: 16px;
        }
        p {
          font-size: 16px;
          margin: 0 20px 30px;
        }
        .btn {
          display: block;
          width: 80%;
          max-width: 300px;
          padding: 14px;
          margin: 10px 0;
          text-decoration: none;
          font-size: 16px;
          font-weight: bold;
          border-radius: 8px;
          box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .btn-primary {
          background-color: #FBB03B;
          color: #ffffff;
        }
        .btn-secondary {
          background-color: #ffffff;
          color: #FBB03B;
          border: 2px solid #FBB03B;
        }
        .loader {
          margin-top: 30px;
          width: 40px;
          height: 40px;
          border: 4px solid #f3f3f3;
          border-top: 4px solid #FBB03B;
          border-radius: 50%;
          animation: spin 1s linear infinite;
        }
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      </style>
    
    </head>
    <body>
      <h1>¡Abre Minhoo!</h1>
      <p>Estamos intentando abrir la app. Si no ocurre automáticamente, puedes hacerlo tú mismo:</p>
      <a class="btn btn-primary" href="${deepLink}">Abrir la app</a>
      <a class="btn btn-secondary" href="${fallback}">Descargar la app</a>
      <div class="loader"></div>
    </body>
    </html>
  `);
});

export default router;
