import Router from "express";
import { TokenValidation } from "../../../libs/middlewares/verify_jwt";
import {
  confirm_image_upload,
  confirm_video_upload,
  create_image_direct_upload,
  create_video_direct_upload,
  delete_image_asset,
  delete_video_asset,
  media_rules,
} from "../../../useCases/media/_controller/controller";

const router = Router();

router.get("/rules", TokenValidation(), media_rules);

router.post("/image/direct-upload", TokenValidation(), create_image_direct_upload);
router.post("/image/confirm", TokenValidation(), confirm_image_upload);
router.delete("/image/:id", TokenValidation(), delete_image_asset);

router.post("/video/direct-upload", TokenValidation(), create_video_direct_upload);
router.post("/video/confirm", TokenValidation(), confirm_video_upload);
router.delete("/video/:uid", TokenValidation(), delete_video_asset);

export default router;
