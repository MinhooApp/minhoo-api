import Router from "express";
import TokenOptional from "../../../libs/middlewares/optional_jwt";
import { home } from "../../../useCases/bootstrap/_controller/controller";

const router = Router();

router.get("/home", TokenOptional(), home);

export default router;
