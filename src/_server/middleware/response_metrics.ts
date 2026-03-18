import { Request, Response, NextFunction } from "express";

type ResponseMetricsSample = {
  route: string;
  method: string;
  summary: boolean;
  status_code: number;
  response_time_ms: number;
  response_size_bytes: number;
  content_encoding: string;
};

const MAX_RECENT_SAMPLES = 500;
const SUMMARY_PAYLOAD_WARNING_BYTES = 200 * 1024;
const recentSamples: ResponseMetricsSample[] = [];
const latestLegacyByRoute = new Map<string, ResponseMetricsSample>();

const nowMs = () => Number(process.hrtime.bigint()) / 1_000_000;
const round2 = (value: number) => Math.round(value * 100) / 100;
const toBufferEncoding = (value: unknown): BufferEncoding | undefined => {
  if (typeof value !== "string" || !value) return undefined;
  return value as BufferEncoding;
};
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
const normalizeRoutePath = (routeRaw: string) => {
  const route = String(routeRaw ?? "")
    .split("?")[0]
    .trim();
  if (!route) return "/";
  if (route.length > 1 && route.endsWith("/")) {
    return route.slice(0, -1);
  }
  return route;
};
const is2xx = (statusCode: number) => statusCode >= 200 && statusCode < 300;
const reductionPercent = (legacy: number, current: number) => {
  if (!Number.isFinite(legacy) || legacy <= 0) return null;
  return round2(((legacy - current) / legacy) * 100);
};
const parseBootstrapSections = (req: Request) => {
  const rawInclude = (req.query as any)?.include;
  const defaults = ["posts", "reels", "services", "notifications"];
  const defaultSet = new Set(defaults);
  if (!rawInclude) return defaults.join(",");
  const parts = String(rawInclude)
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const valid = parts.filter((entry) => defaultSet.has(entry));
  return (valid.length ? valid : defaults).join(",");
};

const getResolvedRoute = (req: Request) => {
  const routePath = req.route?.path ? String(req.route.path) : "";
  const baseUrl = req.baseUrl ? String(req.baseUrl) : "";
  if (routePath) return normalizeRoutePath(`${baseUrl}${routePath}`);
  return normalizeRoutePath(req.originalUrl || req.url || req.path || "unknown");
};

const trackSample = (sample: ResponseMetricsSample) => {
  recentSamples.push(sample);
  if (recentSamples.length > MAX_RECENT_SAMPLES) {
    recentSamples.splice(0, recentSamples.length - MAX_RECENT_SAMPLES);
  }
};

export const getRecentResponseMetricsSamples = () => recentSamples.slice();

export const responseMetricsMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const startedAt = nowMs();
  const summary = isTruthy((req.query as any)?.summary);
  let responseSizeBytes = 0;

  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);

  res.write = ((chunk: any, encoding?: any, callback?: any) => {
    if (chunk) {
      responseSizeBytes += Buffer.isBuffer(chunk)
        ? chunk.length
        : Buffer.byteLength(String(chunk), toBufferEncoding(encoding));
    }
    return originalWrite(chunk, encoding, callback);
  }) as Response["write"];

  res.end = ((chunk?: any, encoding?: any, callback?: any) => {
    if (chunk) {
      responseSizeBytes += Buffer.isBuffer(chunk)
        ? chunk.length
        : Buffer.byteLength(String(chunk), toBufferEncoding(encoding));
    }
    return originalEnd(chunk, encoding, callback);
  }) as Response["end"];

  res.on("finish", () => {
    const contentLengthHeader = Number(res.getHeader("content-length") ?? 0);
    const finalSizeBytes =
      Number.isFinite(contentLengthHeader) && contentLengthHeader > 0
        ? contentLengthHeader
        : responseSizeBytes;
    const route = getResolvedRoute(req);
    const sample: ResponseMetricsSample = {
      route,
      method: req.method,
      summary,
      status_code: res.statusCode,
      response_time_ms: round2(nowMs() - startedAt),
      response_size_bytes: finalSizeBytes,
      content_encoding: String(res.getHeader("content-encoding") ?? "identity"),
    };
    const routeKey = `${sample.method}:${sample.route}`;

    trackSample(sample);
    console.log(`[resp-metrics] ${JSON.stringify(sample)}`);

    if (!sample.summary && is2xx(sample.status_code)) {
      latestLegacyByRoute.set(routeKey, sample);
    }

    if (sample.summary) {
      console.log(
        `[summary-metrics] ${JSON.stringify({
          route: sample.route,
          summary: true,
          response_size_bytes: sample.response_size_bytes,
          response_time_ms: sample.response_time_ms,
          status_code: sample.status_code,
        })}`
      );

      if (sample.response_size_bytes > SUMMARY_PAYLOAD_WARNING_BYTES) {
        console.log(
          `[summary-warning] ${JSON.stringify({
            route: sample.route,
            summary: true,
            payload_exceeded: true,
            size: sample.response_size_bytes,
            threshold_bytes: SUMMARY_PAYLOAD_WARNING_BYTES,
          })}`
        );
      }

      const legacySample = latestLegacyByRoute.get(routeKey);
      if (legacySample) {
        console.log(
          `[summary-compare] ${JSON.stringify({
            route: sample.route,
            payload_reduction_percent: reductionPercent(
              legacySample.response_size_bytes,
              sample.response_size_bytes
            ),
            time_reduction_percent: reductionPercent(
              legacySample.response_time_ms,
              sample.response_time_ms
            ),
            legacy_response_size_bytes: legacySample.response_size_bytes,
            summary_response_size_bytes: sample.response_size_bytes,
            legacy_response_time_ms: legacySample.response_time_ms,
            summary_response_time_ms: sample.response_time_ms,
          })}`
        );
      }
    }

    if (sample.route === "/api/v1/bootstrap/home") {
      console.log(
        `[bootstrap-metrics] ${JSON.stringify({
          sections_loaded: parseBootstrapSections(req),
          response_size_bytes: sample.response_size_bytes,
          response_time_ms: sample.response_time_ms,
          status_code: sample.status_code,
        })}`
      );
    }
  });

  next();
};
