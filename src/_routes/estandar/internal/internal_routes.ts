import Router from "express";
import { InternalDebugGuard } from "../../../libs/middlewares/internal_debug_guard";
import {
  chatRealtimeMetrics,
  debugSummaryRoutes,
  perfCheck,
} from "../../../useCases/internal/_controller/controller";

const router = Router();

router.use(InternalDebugGuard());
router.get("/perf-check", perfCheck);
router.get("/debug/summary-routes", debugSummaryRoutes);
router.get("/debug/chat-realtime-metrics", chatRealtimeMetrics);

export default router;
