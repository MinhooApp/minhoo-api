import { Request, Response, NextFunction } from "express";

type ResponseMetricsSample = {
  route: string;
  method: string;
  summary: boolean;
  status_code: number;
  response_time_ms: number;
  response_size_bytes: number;
  content_encoding: string;
  bootstrap_cache?: string;
  bootstrap_notifications_cache?: string;
};

const MAX_RECENT_SAMPLES = 500;
const SUMMARY_PAYLOAD_WARNING_BYTES = 200 * 1024;
const recentSamples: ResponseMetricsSample[] = [];
const latestLegacyByRoute = new Map<string, ResponseMetricsSample>();
type RouteRollingWindow = {
  timesMs: number[];
  sizesBytes: number[];
  lastLatencyWarnAtMs: number;
  lastPayloadWarnAtMs: number;
};
const routeRollingWindows = new Map<string, RouteRollingWindow>();
const ROUTE_PERF_WINDOW_SIZE = Math.max(
  10,
  Number(process.env.RESP_METRICS_ROUTE_WINDOW_SIZE ?? 30) || 30
);
const ROUTE_WARN_COOLDOWN_MS = Math.max(
  10_000,
  Number(process.env.RESP_METRICS_WARN_COOLDOWN_MS ?? 60_000) || 60_000
);
const ROUTE_LATENCY_BUDGET_MS: Record<string, number> = {
  "GET:/api/v1/bootstrap/home:full": 180,
  "GET:/api/v1/post:summary": 180,
  "GET:/api/v1/reel:summary": 160,
  "GET:/api/v1/chat/message/:id:summary": 100,
  "POST:/api/v1/chat:full": 250,
};
const ROUTE_PAYLOAD_BUDGET_BYTES: Record<string, number> = {
  "GET:/api/v1/bootstrap/home:full": 20 * 1024,
  "GET:/api/v1/post:summary": 18 * 1024,
  "GET:/api/v1/reel:summary": 10 * 1024,
  "POST:/api/v1/chat:full": 12 * 1024,
};

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
const percentile = (values: number[], p: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((p / 100) * sorted.length))
  );
  return sorted[index];
};
const reductionPercent = (legacy: number, current: number) => {
  if (!Number.isFinite(legacy) || legacy <= 0) return null;
  return round2(((legacy - current) / legacy) * 100);
};
const parseBootstrapSections = (req: Request) => {
  const rawInclude = (req.query as any)?.include;
  const defaults = ["posts", "reels", "services", "notifications"];
  if (!rawInclude) return defaults.join(",");
  const parts = String(rawInclude)
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return (parts.length ? parts : defaults).join(",");
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

const evaluateRouteBudgetWarnings = (sample: ResponseMetricsSample) => {
  if (!is2xx(sample.status_code)) return;
  const summaryMode = sample.summary ? "summary" : "full";
  const routeKey = `${sample.method}:${sample.route}:${summaryMode}`;
  const currentAtMs = Date.now();
  const rolling =
    routeRollingWindows.get(routeKey) ??
    ({
      timesMs: [],
      sizesBytes: [],
      lastLatencyWarnAtMs: 0,
      lastPayloadWarnAtMs: 0,
    } as RouteRollingWindow);

  rolling.timesMs.push(sample.response_time_ms);
  rolling.sizesBytes.push(sample.response_size_bytes);
  if (rolling.timesMs.length > ROUTE_PERF_WINDOW_SIZE) {
    rolling.timesMs.splice(0, rolling.timesMs.length - ROUTE_PERF_WINDOW_SIZE);
  }
  if (rolling.sizesBytes.length > ROUTE_PERF_WINDOW_SIZE) {
    rolling.sizesBytes.splice(0, rolling.sizesBytes.length - ROUTE_PERF_WINDOW_SIZE);
  }
  routeRollingWindows.set(routeKey, rolling);

  const latencyBudgetMs = ROUTE_LATENCY_BUDGET_MS[routeKey];
  if (Number.isFinite(latencyBudgetMs) && rolling.timesMs.length >= 5) {
    const p95Ms = percentile(rolling.timesMs, 95);
    if (p95Ms > latencyBudgetMs && currentAtMs - rolling.lastLatencyWarnAtMs >= ROUTE_WARN_COOLDOWN_MS) {
      rolling.lastLatencyWarnAtMs = currentAtMs;
      console.log(
        `[perf-warning] ${JSON.stringify({
          type: "latency_budget",
          route_key: routeKey,
          budget_ms: latencyBudgetMs,
          p95_ms: round2(p95Ms),
          sample_count: rolling.timesMs.length,
        })}`
      );
    }
  }

  const payloadBudgetBytes = ROUTE_PAYLOAD_BUDGET_BYTES[routeKey];
  if (Number.isFinite(payloadBudgetBytes) && rolling.sizesBytes.length >= 5) {
    const p95Bytes = percentile(rolling.sizesBytes, 95);
    if (
      p95Bytes > payloadBudgetBytes &&
      currentAtMs - rolling.lastPayloadWarnAtMs >= ROUTE_WARN_COOLDOWN_MS
    ) {
      rolling.lastPayloadWarnAtMs = currentAtMs;
      console.log(
        `[perf-warning] ${JSON.stringify({
          type: "payload_budget",
          route_key: routeKey,
          budget_bytes: payloadBudgetBytes,
          p95_bytes: Math.round(p95Bytes),
          sample_count: rolling.sizesBytes.length,
        })}`
      );
    }
  }
};

export const getRecentResponseMetricsSamples = () => recentSamples.slice();

const average = (values: number[]) => {
  if (!values.length) return 0;
  return values.reduce((acc, value) => acc + value, 0) / values.length;
};

const statusBucket = (statusCodeRaw: any) => {
  const statusCode = Number(statusCodeRaw);
  if (!Number.isFinite(statusCode) || statusCode <= 0) return "unknown";
  if (statusCode >= 500) return "5xx";
  if (statusCode >= 400) return "4xx";
  if (statusCode >= 300) return "3xx";
  if (statusCode >= 200) return "2xx";
  return "1xx";
};

export const getResponseMetricsOverview = (windowSizeRaw?: any) => {
  const windowSize = Math.max(
    20,
    Math.min(MAX_RECENT_SAMPLES, Number(windowSizeRaw) || MAX_RECENT_SAMPLES)
  );
  const samples = recentSamples.slice(-windowSize);
  const total = samples.length;

  const status_breakdown = {
    "1xx": 0,
    "2xx": 0,
    "3xx": 0,
    "4xx": 0,
    "5xx": 0,
    unknown: 0,
  };

  const routeMap = new Map<
    string,
    {
      method: string;
      route: string;
      summary: boolean;
      count: number;
      errors: number;
      throttled429: number;
      timesMs: number[];
      sizesBytes: number[];
    }
  >();

  const bootstrapCacheStats = {
    hit: 0,
    miss: 0,
    coalesced: 0,
    bypass: 0,
    other: 0,
  };
  const bootstrapNotificationsCacheStats = {
    hit: 0,
    miss: 0,
    coalesced: 0,
    bypass: 0,
    other: 0,
  };

  for (const sample of samples) {
    const bucket = statusBucket(sample.status_code);
    if ((status_breakdown as any)[bucket] === undefined) {
      (status_breakdown as any)[bucket] = 0;
    }
    (status_breakdown as any)[bucket] += 1;

    const key = `${sample.method}:${sample.route}:${sample.summary ? "summary" : "full"}`;
    const routeEntry =
      routeMap.get(key) ??
      {
        method: sample.method,
        route: sample.route,
        summary: sample.summary,
        count: 0,
        errors: 0,
        throttled429: 0,
        timesMs: [],
        sizesBytes: [],
      };

    routeEntry.count += 1;
    if (sample.status_code >= 500) routeEntry.errors += 1;
    if (sample.status_code === 429) routeEntry.throttled429 += 1;
    routeEntry.timesMs.push(sample.response_time_ms);
    routeEntry.sizesBytes.push(sample.response_size_bytes);
    routeMap.set(key, routeEntry);

    if (sample.route === "/api/v1/bootstrap/home") {
      const cacheValue = String(sample.bootstrap_cache ?? "").trim().toLowerCase();
      if (cacheValue === "hit") bootstrapCacheStats.hit += 1;
      else if (cacheValue === "miss") bootstrapCacheStats.miss += 1;
      else if (cacheValue === "coalesced") bootstrapCacheStats.coalesced += 1;
      else if (cacheValue === "bypass") bootstrapCacheStats.bypass += 1;
      else bootstrapCacheStats.other += 1;

      const notificationsCacheValue = String(sample.bootstrap_notifications_cache ?? "")
        .trim()
        .toLowerCase();
      if (notificationsCacheValue === "hit") bootstrapNotificationsCacheStats.hit += 1;
      else if (notificationsCacheValue === "miss") bootstrapNotificationsCacheStats.miss += 1;
      else if (notificationsCacheValue === "coalesced")
        bootstrapNotificationsCacheStats.coalesced += 1;
      else if (notificationsCacheValue === "bypass")
        bootstrapNotificationsCacheStats.bypass += 1;
      else bootstrapNotificationsCacheStats.other += 1;
    }
  }

  const hotspots = Array.from(routeMap.values())
    .map((entry) => {
      const p50Ms = percentile(entry.timesMs, 50);
      const p95Ms = percentile(entry.timesMs, 95);
      const p99Ms = percentile(entry.timesMs, 99);
      const p95Bytes = percentile(entry.sizesBytes, 95);
      const avgMs = average(entry.timesMs);
      const errorRate = entry.count ? (entry.errors / entry.count) * 100 : 0;
      const throttled429Rate = entry.count ? (entry.throttled429 / entry.count) * 100 : 0;
      return {
        method: entry.method,
        route: entry.route,
        summary: entry.summary,
        count: entry.count,
        p50_ms: round2(p50Ms),
        p95_ms: round2(p95Ms),
        p99_ms: round2(p99Ms),
        avg_ms: round2(avgMs),
        p95_bytes: Math.round(p95Bytes),
        error_rate_percent: round2(errorRate),
        throttled_429_rate_percent: round2(throttled429Rate),
      };
    })
    .sort((a, b) => {
      if (b.p95_ms !== a.p95_ms) return b.p95_ms - a.p95_ms;
      return b.count - a.count;
    });

  const globalTimes = samples.map((sample) => sample.response_time_ms);
  const totalErrors = status_breakdown["5xx"];
  const total429 = samples.filter((sample) => sample.status_code === 429).length;
  const totalBootstrapCache =
    bootstrapCacheStats.hit +
    bootstrapCacheStats.miss +
    bootstrapCacheStats.coalesced +
    bootstrapCacheStats.bypass +
    bootstrapCacheStats.other;
  const totalBootstrapNotificationsCache =
    bootstrapNotificationsCacheStats.hit +
    bootstrapNotificationsCacheStats.miss +
    bootstrapNotificationsCacheStats.coalesced +
    bootstrapNotificationsCacheStats.bypass +
    bootstrapNotificationsCacheStats.other;

  return {
    window_size: windowSize,
    generated_at: new Date().toISOString(),
    totals: {
      requests: total,
      status_breakdown,
      error_rate_percent: total > 0 ? round2((totalErrors / total) * 100) : 0,
      throttled_429_rate_percent: total > 0 ? round2((total429 / total) * 100) : 0,
      p50_ms: round2(percentile(globalTimes, 50)),
      p95_ms: round2(percentile(globalTimes, 95)),
      p99_ms: round2(percentile(globalTimes, 99)),
      avg_ms: round2(average(globalTimes)),
    },
    bootstrap_cache: {
      ...bootstrapCacheStats,
      hit_rate_percent:
        totalBootstrapCache > 0 ? round2((bootstrapCacheStats.hit / totalBootstrapCache) * 100) : 0,
    },
    bootstrap_notifications_cache: {
      ...bootstrapNotificationsCacheStats,
      hit_rate_percent:
        totalBootstrapNotificationsCache > 0
          ? round2((bootstrapNotificationsCacheStats.hit / totalBootstrapNotificationsCache) * 100)
          : 0,
    },
    hotspots: hotspots.slice(0, 20),
  };
};

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
      bootstrap_cache: String(res.getHeader("x-bootstrap-cache") ?? ""),
      bootstrap_notifications_cache: String(
        res.getHeader("x-bootstrap-notifications-cache") ?? ""
      ),
    };
    const routeKey = `${sample.method}:${sample.route}`;

    trackSample(sample);
    evaluateRouteBudgetWarnings(sample);
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
