import Router from "express";
import TokenOptional from "../../../libs/middlewares/optional_jwt";
import { TokenValidation } from "../../../libs/middlewares/verify_jwt";
import {
  create_reel,
  add_reel_comment,
  reels_feed,
  reels_suggested,
  reel_by_id,
  reel_comments,
  my_reels,
  reels_saved,
  reel_download,
  toggle_reel_star,
  save_reel,
  unsave_reel,
  record_reel_view,
  share_reel,
  delete_reel,
  delete_reel_comment,
} from "../../../useCases/reel/_controller/controller";

const router = Router();

router.post("/", TokenValidation(), create_reel);

router.get("/", TokenOptional(), reels_feed);
router.get("/suggested", TokenOptional(), reels_suggested);
router.get("/saved", TokenValidation(), reels_saved);
router.get("/my", TokenValidation(), my_reels);
router.get("/:id", TokenOptional(), reel_by_id);
router.get("/:id/download", TokenOptional(), reel_download);

router.post("/:id/view", TokenOptional(), record_reel_view);
router.post("/:id/share", TokenValidation(), share_reel);

router.put("/like/:id", TokenValidation(), toggle_reel_star);
router.put("/star/:id", TokenValidation(), toggle_reel_star);

router.post("/:id/save", TokenValidation(), save_reel);
router.delete("/:id/save", TokenValidation(), unsave_reel);

router.get("/:id/comments", TokenOptional(), reel_comments);
router.post("/:id/comments", TokenValidation(), add_reel_comment);
router.delete("/comments/:commentId", TokenValidation(), delete_reel_comment);

router.delete("/:id", TokenValidation(), delete_reel);

export default router;
