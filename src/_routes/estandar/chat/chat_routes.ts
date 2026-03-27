import Router, { Request, RequestHandler } from "express";
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
import { isSummaryMode } from "../../../libs/summary_response";
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

const normalizeTokenCandidate = (raw: any): string => {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  if (value.toLowerCase().startsWith("bearer ")) {
    return value.slice(7).trim();
  }
  return value;
};

const chatRateLimitKey = (req: Request) => {
  const headerCandidates = [
    req.header("Authorization"),
    req.header("x-auth-token"),
    req.header("x-access-token"),
    req.header("auth_token"),
  ];
  for (const candidate of headerCandidates) {
    const token = normalizeTokenCandidate(candidate);
    if (token) {
      const tail = token.slice(-32);
      return `tok:${tail}`;
    }
  }

  const forwarded = String(req.header("x-forwarded-for") ?? "")
    .split(",")[0]
    ?.trim();
  if (forwarded) return `ip:${forwarded}`;

  const ip = String((req as any)?.ip ?? (req as any)?.socket?.remoteAddress ?? "").trim();
  if (ip) return `ip:${ip}`;

  return "ip:unknown";
};

const chatReadLimiter = createRequestRateLimiter({
  windowMs: APP_RATE_WINDOW_MS,
  max: parsePositiveInt(process.env.CHAT_RATE_MAX_READ, 120),
  maxEntries: APP_RATE_MAX_ENTRIES,
  keyPrefix: "chat:read",
  keyGenerator: chatRateLimitKey,
  message: "too many chat read requests, try later",
});
const chatReadSummaryLimiter = createRequestRateLimiter({
  windowMs: APP_RATE_WINDOW_MS,
  max: parsePositiveInt(process.env.CHAT_RATE_MAX_READ_SUMMARY, 12_000),
  maxEntries: APP_RATE_MAX_ENTRIES,
  keyPrefix: "chat:read:summary",
  keyGenerator: chatRateLimitKey,
  message: "too many chat summary requests, try later",
});
const chatWriteLimiter = createRequestRateLimiter({
  windowMs: APP_RATE_WINDOW_MS,
  max: parsePositiveInt(process.env.CHAT_RATE_MAX_WRITE, 30),
  maxEntries: APP_RATE_MAX_ENTRIES,
  keyPrefix: "chat:write",
  keyGenerator: chatRateLimitKey,
  message: "too many chat write requests, try later",
});
const chatReportLimiter = createRequestRateLimiter({
  windowMs: APP_RATE_WINDOW_MS,
  max: parsePositiveInt(process.env.CHAT_RATE_MAX_REPORT, 10),
  maxEntries: APP_RATE_MAX_ENTRIES,
  keyPrefix: "chat:report",
  keyGenerator: chatRateLimitKey,
  message: "too many chat reports, try later",
});

const chatReadAdaptiveLimiter: RequestHandler = (req, res, next) => {
  if (isSummaryMode((req.query as any)?.summary)) {
    return chatReadSummaryLimiter(req, res, next);
  }
  return chatReadLimiter(req, res, next);
};

router.get("/", chatReadAdaptiveLimiter, TokenValidation(), myChats);
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
