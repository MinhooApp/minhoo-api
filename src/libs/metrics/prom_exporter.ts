/**
 * Prometheus-compatible metrics exporter.
 *
 * No external dependencies — renders the standard Prometheus text exposition format
 * (https://prometheus.io/docs/instrumenting/exposition_formats/) from in-process data.
 *
 * Data sources:
 *  - process.memoryUsage() / process.uptime()
 *  - Sequelize connectionManager.pool (size / available / using / waiting)
 *  - Socket.IO engine.clientsCount
 *  - BullMQ Queue.getJobCounts()
 *  - response_metrics rolling window (per-route p50/p95/p99)
 */

import sequelize from "../../_db/connection";
import { getSocketInstance } from "../../_sockets/socket_instance";
import { getPushQueue } from "../jobs/push_queue";
import { getResponseMetricsOverview } from "../../_server/middleware/response_metrics";

// ---------------------------------------------------------------------------
// Text format helpers
// ---------------------------------------------------------------------------

const escapeLabelValue = (v: string): string =>
  v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

const fmtLabels = (labels: Record<string, string>): string => {
  const pairs = Object.entries(labels)
    .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`)
    .join(",");
  return `{${pairs}}`;
};

const line = (name: string, value: number, labels?: Record<string, string>): string =>
  `${name}${labels && Object.keys(labels).length ? fmtLabels(labels) : ""} ${value}`;

const section = (
  name: string,
  help: string,
  type: "gauge" | "counter" | "histogram",
  lines: string[]
): string =>
  [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...lines, ""].join("\n");

// ---------------------------------------------------------------------------
// Data collectors
// ---------------------------------------------------------------------------

const collectProcess = (): string[] => {
  const mem = process.memoryUsage();
  return [
    section("process_uptime_seconds", "Process uptime in seconds", "gauge", [
      line("process_uptime_seconds", Math.round(process.uptime())),
    ]),
    section("process_heap_bytes", "Node.js heap memory in bytes", "gauge", [
      line("process_heap_bytes", mem.heapUsed, { type: "used" }),
      line("process_heap_bytes", mem.heapTotal, { type: "total" }),
      line("process_heap_bytes", mem.rss, { type: "rss" }),
      line("process_heap_bytes", mem.external, { type: "external" }),
    ]),
  ];
};

const collectDbPool = (): string[] => {
  try {
    const pool = (sequelize as any)?.connectionManager?.pool;
    if (!pool) return [];

    const total = Number(pool.size ?? 0) || 0;
    const idle = Number(pool.available ?? 0) || 0;
    const active = Number(pool.using ?? 0) || 0;
    const pending = Number(pool.waiting ?? 0) || 0;
    const maxPool = Math.max(1, Number(process.env.DB_POOL_MAX ?? 35) || 35);
    const utilization = Math.round((active / maxPool) * 100);

    return [
      section("db_pool_connections", "Sequelize DB pool connections by state", "gauge", [
        line("db_pool_connections", total, { state: "total" }),
        line("db_pool_connections", active, { state: "active" }),
        line("db_pool_connections", idle, { state: "idle" }),
        line("db_pool_connections", pending, { state: "pending" }),
      ]),
      section("db_pool_utilization_percent", "DB pool active connections as % of max", "gauge", [
        line("db_pool_utilization_percent", utilization),
      ]),
    ];
  } catch {
    return [];
  }
};

const collectSockets = (): string[] => {
  try {
    const io = getSocketInstance();
    const count = Number((io as any)?.engine?.clientsCount ?? 0) || 0;
    return [
      section("socket_connections_active", "Active WebSocket connections", "gauge", [
        line("socket_connections_active", count),
      ]),
    ];
  } catch {
    return [];
  }
};

const collectQueue = async (): Promise<string[]> => {
  try {
    const counts = await getPushQueue().getJobCounts();
    return [
      section("bullmq_jobs", "BullMQ job counts by queue and state", "gauge",
        (["waiting", "active", "failed", "delayed", "completed"] as const).map((state) =>
          line("bullmq_jobs", Number((counts as any)[state] ?? 0), {
            queue: "push-notifications",
            state,
          })
        )
      ),
    ];
  } catch {
    return [];
  }
};

const collectHttp = (): string[] => {
  try {
    const ov = getResponseMetricsOverview();
    if (!ov || ov.totals.requests === 0) return [];

    const globalLines = [
      section("http_requests_sampled_total", "HTTP requests in current metrics window", "gauge", [
        line("http_requests_sampled_total", ov.totals.requests),
      ]),
      section("http_error_rate_percent", "HTTP 5xx error rate in window (%)", "gauge", [
        line("http_error_rate_percent", ov.totals.error_rate_percent),
      ]),
      section("http_request_duration_ms", "Global HTTP request duration percentiles (ms)", "gauge", [
        line("http_request_duration_ms", ov.totals.p50_ms, { quantile: "p50" }),
        line("http_request_duration_ms", ov.totals.p95_ms, { quantile: "p95" }),
        line("http_request_duration_ms", ov.totals.p99_ms, { quantile: "p99" }),
      ]),
    ];

    const hotspots = Array.isArray(ov.hotspots) ? ov.hotspots.slice(0, 25) : [];
    if (!hotspots.length) return globalLines;

    const durationLines = hotspots.map((h) =>
      line("http_route_duration_ms", h.p95_ms, { method: h.method, route: h.route, quantile: "p95" })
    );
    const countLines = hotspots.map((h) =>
      line("http_route_requests", h.count, { method: h.method, route: h.route })
    );
    const errorLines = hotspots
      .filter((h) => h.error_rate_percent > 0)
      .map((h) =>
        line("http_route_error_rate_percent", h.error_rate_percent, {
          method: h.method,
          route: h.route,
        })
      );

    return [
      ...globalLines,
      section("http_route_duration_ms", "Per-route HTTP p95 response time (ms)", "gauge", durationLines),
      section("http_route_requests", "Per-route request count in metrics window", "counter", countLines),
      ...(errorLines.length
        ? [section("http_route_error_rate_percent", "Per-route 5xx error rate (%)", "gauge", errorLines)]
        : []),
    ];
  } catch {
    return [];
  }
};

// ---------------------------------------------------------------------------
// Main render function
// ---------------------------------------------------------------------------

export const renderPrometheusMetrics = async (): Promise<string> => {
  const [queueSections] = await Promise.all([collectQueue()]);

  const parts = [
    ...collectProcess(),
    ...collectDbPool(),
    ...collectSockets(),
    ...queueSections,
    ...collectHttp(),
  ];

  return parts.join("");
};

// ---------------------------------------------------------------------------
// Pool saturation snapshot — used by /ready
// ---------------------------------------------------------------------------

export const getDbPoolSaturation = (): {
  active: number;
  pending: number;
  total: number;
  maxPool: number;
  saturated: boolean;
  critical: boolean;
} => {
  try {
    const pool = (sequelize as any)?.connectionManager?.pool;
    const maxPool = Math.max(1, Number(process.env.DB_POOL_MAX ?? 35) || 35);
    if (!pool) {
      return { active: 0, pending: 0, total: 0, maxPool, saturated: false, critical: false };
    }
    const active = Number(pool.using ?? 0) || 0;
    const pending = Number(pool.waiting ?? 0) || 0;
    const total = Number(pool.size ?? 0) || 0;
    const utilPct = (active / maxPool) * 100;
    return {
      active,
      pending,
      total,
      maxPool,
      saturated: utilPct >= 70 || pending > 0,
      critical: utilPct >= 90 || pending >= 5,
    };
  } catch {
    const maxPool = Math.max(1, Number(process.env.DB_POOL_MAX ?? 35) || 35);
    return { active: 0, pending: 0, total: 0, maxPool, saturated: false, critical: false };
  }
};

// ---------------------------------------------------------------------------
// BullMQ queue depth snapshot — used by /ready
// ---------------------------------------------------------------------------

export const getQueueDepthSnapshot = async (): Promise<{
  waiting: number;
  active: number;
  failed: number;
  delayed: number;
  lagging: boolean;
}> => {
  try {
    const counts = await getPushQueue().getJobCounts();
    const waiting = Number((counts as any).waiting ?? 0) || 0;
    const active = Number((counts as any).active ?? 0) || 0;
    const failed = Number((counts as any).failed ?? 0) || 0;
    const delayed = Number((counts as any).delayed ?? 0) || 0;
    const QUEUE_LAG_THRESHOLD = Math.max(
      10,
      Number(process.env.BULLMQ_LAG_THRESHOLD ?? 50) || 50
    );
    return {
      waiting,
      active,
      failed,
      delayed,
      lagging: waiting > QUEUE_LAG_THRESHOLD,
    };
  } catch {
    return { waiting: 0, active: 0, failed: 0, delayed: 0, lagging: false };
  }
};
