import Router from "express";
import {
  myChats,
  starredChats,
  sendMessage,
  deleteChat,
  deleteMessage,
  messages,
  getUserByMessage,
  pinChat,
  starChat,
  report,
} from "../../../useCases/chat/_controller/controller";
import { TokenValidation } from "../../../libs/middlewares/verify_jwt";
import { createRequestRateLimiter } from "../../../libs/middlewares/request_rate_limiter";
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
const chatReadLimiter = createRequestRateLimiter({
  windowMs: APP_RATE_WINDOW_MS,
  max: parsePositiveInt(process.env.CHAT_RATE_MAX_READ, 120),
  maxEntries: APP_RATE_MAX_ENTRIES,
  keyPrefix: "chat:read",
  message: "too many chat read requests, try later",
});
const chatWriteLimiter = createRequestRateLimiter({
  windowMs: APP_RATE_WINDOW_MS,
  max: parsePositiveInt(process.env.CHAT_RATE_MAX_WRITE, 30),
  maxEntries: APP_RATE_MAX_ENTRIES,
  keyPrefix: "chat:write",
  message: "too many chat write requests, try later",
});
const chatReportLimiter = createRequestRateLimiter({
  windowMs: APP_RATE_WINDOW_MS,
  max: parsePositiveInt(process.env.CHAT_RATE_MAX_REPORT, 10),
  maxEntries: APP_RATE_MAX_ENTRIES,
  keyPrefix: "chat:report",
  message: "too many chat reports, try later",
});

router.get("/", chatReadLimiter, TokenValidation(), myChats);
router.get("/starred", chatReadLimiter, TokenValidation(), starredChats);
router.get("/user/message/:messageId", chatReadLimiter, TokenValidation(), getUserByMessage);
router.get("/message/:id", chatReadLimiter, TokenValidation(), messages);
router.delete("/message/:messageId", chatWriteLimiter, TokenValidation(), deleteMessage);
router.post("/", chatWriteLimiter, TokenValidation(), sendMessage);
router.post("/:id/report", chatReportLimiter, TokenValidation(), report);
router.put("/:id/report", chatReportLimiter, TokenValidation(), report);
router.patch("/:id/report", chatReportLimiter, TokenValidation(), report);
router.post("/report/:id", chatReportLimiter, TokenValidation(), report);
router.put("/report/:id", chatReportLimiter, TokenValidation(), report);
router.patch("/report/:id", chatReportLimiter, TokenValidation(), report);
router.patch("/:id/pin", chatWriteLimiter, TokenValidation(), pinChat);
router.patch("/:id/starred", chatWriteLimiter, TokenValidation(), starChat);
router.delete("/:id", chatWriteLimiter, TokenValidation(), deleteChat);

export default router;
