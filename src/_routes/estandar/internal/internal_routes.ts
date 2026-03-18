import Router from "express";
import { InternalDebugGuard } from "../../../libs/middlewares/internal_debug_guard";
import {
  debugSummaryRoutes,
  perfCheck,
} from "../../../useCases/internal/_controller/controller";

const router = Router();

router.use(InternalDebugGuard());
router.get("/perf-check", perfCheck);
router.get("/debug/summary-routes", debugSummaryRoutes);

export default router;
