import Router from "express";
import TokenOptional from "../../../libs/middlewares/optional_jwt";
import { feed_services } from "../../../useCases/feed/_controller/controller";

const router = Router();

router.get("/services", TokenOptional(), feed_services);

export default router;
