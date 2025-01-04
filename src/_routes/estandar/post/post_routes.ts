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
router.delete("/admin/:id", TokenValidation([8088]), deletePost);
router.delete("/:id", TokenValidation(), deletePost);

export default router;
