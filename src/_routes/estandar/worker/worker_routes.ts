import Router from "express";
import {
  workers,
  worker,
  update,
  visibleProfile,
  deleteImageProfile,
} from "../../../useCases/worker/_controller/controller";
import { TokenValidation } from "../../../libs/middlewares/verify_jwt";

const router = Router();
router.get("/", workers);
router.get("/one/:id?", worker);
router.post("/", TokenValidation(), update);
router.put("/visible", TokenValidation(), visibleProfile);
router.delete("/image", TokenValidation(), deleteImageProfile);

export default router;
