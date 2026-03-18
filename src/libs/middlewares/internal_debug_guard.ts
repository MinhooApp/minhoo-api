import { NextFunction, Request, RequestHandler, Response } from "express";
import { timingSafeEqual } from "crypto";

const isTruthy = (value: any) => {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
};

const safeTokenEquals = (aRaw: any, bRaw: any) => {
  const a = Buffer.from(String(aRaw ?? ""));
  const b = Buffer.from(String(bRaw ?? ""));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

const normalizeIp = (ipRaw: any) => {
  const raw = String(ipRaw ?? "").trim();
  if (!raw) return "";
  return raw.startsWith("::ffff:") ? raw.slice("::ffff:".length) : raw;
};

const shouldTrustProxy = () => {
  const normalized = String(process.env.TRUST_PROXY ?? "")
    .trim()
    .toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
};

const getRequestIp = (req: Request) => {
  if (shouldTrustProxy()) {
    const forwarded = String(req.header("x-forwarded-for") ?? "")
      .split(",")
      .map((item) => normalizeIp(item))
      .find(Boolean);
    if (forwarded) return forwarded;
  }
  return normalizeIp(req.ip);
};

const parseIpAllowlist = () => {
  const raw = String(process.env.INTERNAL_DEBUG_IP_ALLOWLIST ?? "").trim();
  if (!raw) return new Set<string>();
  return new Set(
    raw
      .split(",")
      .map((entry) => normalizeIp(entry))
      .filter(Boolean)
  );
};

const canUseInternalDebug = (req: Request) => {
  if (String(process.env.NODE_ENV ?? "").trim().toLowerCase() !== "production") {
    return true;
  }

  if (!isTruthy(req.header("x-internal-debug"))) {
    return false;
  }

  const configuredToken = String(process.env.INTERNAL_DEBUG_TOKEN ?? "").trim();
  if (!configuredToken) {
    return false;
  }

  const incomingToken = String(req.header("x-internal-debug-token") ?? "");
  if (!safeTokenEquals(incomingToken, configuredToken)) {
    return false;
  }

  const ipAllowlist = parseIpAllowlist();
  if (!ipAllowlist.size) return true;

  const requestIp = getRequestIp(req);
  return ipAllowlist.has(requestIp);
};

export const InternalDebugGuard = (): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (canUseInternalDebug(req)) return next();

    return res.status(403).json({
      header: { success: false },
      message: "internal debug endpoint is disabled",
    });
  };
};

export default InternalDebugGuard;
