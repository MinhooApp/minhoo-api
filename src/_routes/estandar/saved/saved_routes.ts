import Router from "express";
import { TokenValidation } from "../../../libs/middlewares/verify_jwt";
import {
  save_post,
  saved_posts,
  saved_videos,
  unsave_post,
} from "../../../useCases/saved/_controller/controller";

const router = Router();

router.post("/posts/:postId", TokenValidation(), save_post);
router.delete("/posts/:postId", TokenValidation(), unsave_post);
router.get("/posts", TokenValidation(), saved_posts);
router.get("/videos", TokenValidation(), saved_videos);

export default router;
