import Router from "express";
import { InternalDebugGuard } from "../../../libs/middlewares/internal_debug_guard";
import { createRequestRateLimiter } from "../../../libs/middlewares/request_rate_limiter";
import {
  debugSummaryRoutes,
  perfCheck,
} from "../../../useCases/internal/_controller/controller";

const router = Router();
const parsePositiveInt = (value: any, fallback: number, min = 1) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.trunc(parsed);
  if (rounded < min) return fallback;
  return rounded;
};

const internalLimiter = createRequestRateLimiter({
  windowMs: parsePositiveInt(process.env.APP_RATE_WINDOW_MS, 60_000),
  max: parsePositiveInt(process.env.INTERNAL_RATE_MAX, 20),
  blockDurationMs: parsePositiveInt(process.env.AUTH_RATE_BLOCK_MS, 10 * 60_000, 0),
  maxEntries: parsePositiveInt(process.env.APP_RATE_MAX_ENTRIES, 50_000, 500),
  keyPrefix: "internal:debug",
  message: "too many internal debug requests, try later",
});

router.use(InternalDebugGuard());
router.use(internalLimiter);
router.get("/perf-check", perfCheck);
router.get("/debug/summary-routes", debugSummaryRoutes);

export default router;
