import Router from "express";
import TokenOptional from "../../../libs/middlewares/optional_jwt";
import { TokenValidation } from "../../../libs/middlewares/verify_jwt";
import path from "path";
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
} from "../../../useCases/user/_controller/controller";
router.get("/", TokenValidation(), gets);
router.post("/follow", TokenValidation(), follow);
router.get("/follows/:id?", TokenOptional(), follows);
router.get("/followers/:id?", TokenOptional(), followers);
router.get("/one/:id?", TokenOptional(), get);
router.get("/myData", TokenValidation(), myData);
router.get("/alert", TokenValidation(), activeAlerts);
router.get("/share/:id", async (req, res) => {
  const userId = req.params.id;

  const userAgent = req.headers["user-agent"] || "";
  const isAndroid = /android/i.test(userAgent);
  const isIOS = /iphone|ipad|ipod/i.test(userAgent);

  const deepLink = `minhoo://profile/${userId}`;
  const fallbackAndroid =
    "https://play.google.com/store/apps/details?id=aud.minhoo.io";
  const fallbackIOS = "https://apps.apple.com/app/id123456789";
  const fallbackIOSTestFlight = "https://testflight.apple.com/join/46uzBSsa";
  const fallback = isAndroid ? fallbackAndroid : fallbackIOSTestFlight;

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

router.delete("/block/:blocked_id", TokenValidation(), block_user);
router.patch("/unblock/:blocked_id", TokenValidation(), unblock_user);
export default router;
