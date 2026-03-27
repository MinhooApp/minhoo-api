import { Request } from "express";

export type SecurityAuditLevel = "info" | "warn" | "error";

export type SecurityAuditEvent = {
  event: string;
  level?: SecurityAuditLevel;
  actorUserId?: number | null;
  targetUserId?: number | null;
  success?: boolean;
  reason?: string;
  method?: string;
  route?: string;
  ip?: string;
  userAgent?: string;
  requestId?: string;
  meta?: Record<string, any>;
};

const isTruthy = (value: any) => {
  const v = String(value ?? "")
    .trim()
    .toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
};

const auditLogEnabled = !isTruthy(process.env.SECURITY_AUDIT_LOG_DISABLED ?? "0");
const maxUserAgentLength = 180;
const maxReasonLength = 200;
const maxRouteLength = 140;
const maxRequestIdLength = 96;

const normalizeIp = (rawIp: any) => {
  const ip = String(rawIp ?? "").trim();
  if (!ip) return "unknown";
  if (ip.startsWith("::ffff:")) return ip.slice("::ffff:".length);
  return ip;
};

const toOptionalPositiveInt = (value: any): number | null => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
};

const truncate = (value: any, maxLength: number) => {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength);
};

const sanitizeMeta = (metaRaw: any): Record<string, any> | undefined => {
  if (!metaRaw || typeof metaRaw !== "object") return undefined;
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(metaRaw)) {
    if (!key) continue;
    if (value === undefined) continue;
    if (value === null) {
      out[key] = null;
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
      continue;
    }
    if (typeof value === "string") {
      out[key] = truncate(value, 220);
      continue;
    }
    out[key] = truncate(JSON.stringify(value), 220);
  }
  return Object.keys(out).length ? out : undefined;
};

export const writeSecurityAuditEvent = (event: SecurityAuditEvent) => {
  if (!auditLogEnabled) return;
  if (!event?.event) return;

  const payload = {
    ts: new Date().toISOString(),
    event: truncate(event.event, 120),
    level: event.level ?? "info",
    actorUserId: toOptionalPositiveInt(event.actorUserId),
    targetUserId: toOptionalPositiveInt(event.targetUserId),
    success: Boolean(event.success),
    reason: truncate(event.reason, maxReasonLength) || undefined,
    method: truncate(event.method, 12) || undefined,
    route: truncate(event.route, maxRouteLength) || undefined,
    ip: normalizeIp(event.ip),
    userAgent: truncate(event.userAgent, maxUserAgentLength) || undefined,
    requestId: truncate(event.requestId, maxRequestIdLength) || undefined,
    meta: sanitizeMeta(event.meta),
  };

  const line = `[security_audit] ${JSON.stringify(payload)}`;
  if (payload.level === "error") {
    console.error(line);
  } else if (payload.level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
};

export const writeSecurityAuditFromRequest = (
  req: Request,
  event: Omit<SecurityAuditEvent, "method" | "route" | "ip" | "userAgent" | "requestId">
) => {
  writeSecurityAuditEvent({
    ...event,
    method: req.method,
    route: req.originalUrl || req.path,
    ip: req.ip ?? (req as any)?.socket?.remoteAddress,
    userAgent: req.header("user-agent") ?? "",
    requestId: req.header("x-request-id") ?? "",
  });
};

export default {
  writeSecurityAuditEvent,
  writeSecurityAuditFromRequest,
};
