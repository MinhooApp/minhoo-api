import Router from "express";
import {
  workers,
  worker,
  update,
  visibleProfile,
  deleteImageProfile,
  ids,
} from "../../../useCases/worker/_controller/controller";
import TokenOptional from "../../../libs/middlewares/optional_jwt";
import { TokenValidation } from "../../../libs/middlewares/verify_jwt";

const router = Router();
router.get("/", TokenOptional(), workers);
router.get("/one/:id?", TokenOptional(), worker);
router.get("/id/:id?", TokenOptional(), ids);
router.post("/", TokenValidation(), update);
router.put("/visible", TokenValidation(), visibleProfile);
router.delete("/image", TokenValidation(), deleteImageProfile);

export default router;
