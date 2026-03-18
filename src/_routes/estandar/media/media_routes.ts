import Router from "express";
import { TokenValidation } from "../../../libs/middlewares/verify_jwt";
import {
  audio_playback,
  document_download,
  image_playback,
  video_playback,
  video_download,
  confirm_audio_upload,
  confirm_document_upload,
  confirm_image_upload,
  confirm_video_upload,
  create_audio_direct_upload,
  create_document_direct_upload,
  create_image_direct_upload,
  create_video_direct_upload,
  delete_audio_asset,
  delete_document_asset,
  delete_image_asset,
  delete_video_asset,
  media_rules,
} from "../../../useCases/media/_controller/controller";

const router = Router();

router.get("/audio/play", audio_playback);
router.get("/document/download", document_download);
router.get("/image/play", image_playback);
router.get("/video/play", video_playback);
router.get("/video/download", video_download);

router.get("/rules", TokenValidation(), media_rules);

router.post("/image/direct-upload", TokenValidation(), create_image_direct_upload);
router.post("/image/confirm", TokenValidation(), confirm_image_upload);
router.delete("/image/:id", TokenValidation(), delete_image_asset);

router.post("/video/direct-upload", TokenValidation(), create_video_direct_upload);
router.post("/video/confirm", TokenValidation(), confirm_video_upload);
router.delete("/video/:uid", TokenValidation(), delete_video_asset);

router.post("/audio/direct-upload", TokenValidation(), create_audio_direct_upload);
router.post("/audio/confirm", TokenValidation(), confirm_audio_upload);
router.delete("/audio/:uid", TokenValidation(), delete_audio_asset);

router.post("/document/direct-upload", TokenValidation(), create_document_direct_upload);
router.post("/document/confirm", TokenValidation(), confirm_document_upload);
router.delete("/document/:uid", TokenValidation(), delete_document_asset);

export default router;
