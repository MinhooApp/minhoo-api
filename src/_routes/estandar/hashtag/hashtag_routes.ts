import Router from "express";
import TokenOptional from "../../../libs/middlewares/optional_jwt";
import { createRequestRateLimiter } from "../../../libs/middlewares/request_rate_limiter";
import {
  hashtag_feed,
  hashtags_suggest,
  hashtags_trending,
} from "../../../useCases/hashtag/_controller/controller";

const router = Router();

const parsePositiveInt = (value: any, fallback: number, min = 1) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.trunc(parsed);
  if (rounded < min) return fallback;
  return rounded;
};

const APP_RATE_WINDOW_MS = parsePositiveInt(
  process.env.APP_RATE_WINDOW_MS,
  60_000
);
const APP_RATE_MAX_ENTRIES = parsePositiveInt(
  process.env.APP_RATE_MAX_ENTRIES,
  50_000,
  500
);
const hashtagReadLimiter = createRequestRateLimiter({
  windowMs: APP_RATE_WINDOW_MS,
  max: parsePositiveInt(process.env.HASHTAG_RATE_MAX_READ, 180),
  maxEntries: APP_RATE_MAX_ENTRIES,
  keyPrefix: "hashtag:read",
  message: "too many hashtag requests, try later",
});

router.get("/suggest", hashtagReadLimiter, TokenOptional(), hashtags_suggest);
router.get("/trending", hashtagReadLimiter, TokenOptional(), hashtags_trending);
router.get("/:tag/feed", hashtagReadLimiter, TokenOptional(), hashtag_feed);

export default router;
