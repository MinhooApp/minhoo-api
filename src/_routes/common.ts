import { Router } from "express";
import sequelize from "../_db/connection";
import { getPushWorkerStatus } from "../libs/jobs/push_worker";

const router = Router();

// ------------------------------------------------------------------
// Configuración de timeouts y caché
// ------------------------------------------------------------------
const READY_CHECK_CACHE_MS = Math.max(
  500,
  Math.trunc(Number(process.env.READY_CHECK_CACHE_MS ?? 5_000) || 5_000)
);
const READY_DB_TIMEOUT_MS = Math.max(
  500,
  Math.trunc(Number(process.env.READY_DB_TIMEOUT_MS ?? 2_000) || 2_000)
);
const READY_REDIS_TIMEOUT_MS = Math.max(
  200,
  Math.trunc(Number(process.env.READY_REDIS_TIMEOUT_MS ?? 1_000) || 1_000)
);
const HEALTH_CHECK_CACHE_MS = Math.max(
  500,
  Math.trunc(Number(process.env.HEALTH_CHECK_CACHE_MS ?? 10_000) || 10_000)
);

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> => {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
};

const pingRedis = async (timeoutMs: number): Promise<{ ok: boolean; latencyMs: number | null; error: string | null }> => {
  const url = String(process.env.REDIS_URL ?? "").trim();
  if (!url) {
    return { ok: false, latencyMs: null, error: "REDIS_URL not configured" };
  }

  let client: any = null;
  const start = Date.now();
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const redis = require("redis");
    client = redis.createClient({ url, socket: { connectTimeout: timeoutMs } });
    client.on("error", () => {});
    await withTimeout(client.connect(), timeoutMs, `redis ping timeout after ${timeoutMs}ms`);
    await withTimeout(client.ping(), timeoutMs, `redis ping timeout after ${timeoutMs}ms`);
    const latencyMs = Date.now() - start;
    return { ok: true, latencyMs, error: null };
  } catch (err: any) {
    return { ok: false, latencyMs: null, error: String(err?.message ?? err ?? "redis ping failed") };
  } finally {
    if (client) {
      try { await client.quit(); } catch { /* ignore */ }
    }
  }
};

const checkDb = async (timeoutMs: number): Promise<{ ok: boolean; latencyMs: number | null; error: string | null }> => {
  const start = Date.now();
  try {
    await withTimeout(
      sequelize.authenticate(),
      timeoutMs,
      `db readiness timeout after ${timeoutMs}ms`
    );
    return { ok: true, latencyMs: Date.now() - start, error: null };
  } catch (err: any) {
    return { ok: false, latencyMs: null, error: String(err?.message ?? err ?? "db check failed") };
  }
};

const getProcessMetrics = () => {
  const mem = process.memoryUsage();
  const toMb = (bytes: number) => Math.round(bytes / 1024 / 1024 * 10) / 10;
  return {
    uptime_seconds: Math.round(process.uptime()),
    memory_mb: {
      rss: toMb(mem.rss),
      heap_used: toMb(mem.heapUsed),
      heap_total: toMb(mem.heapTotal),
      external: toMb(mem.external),
    },
    node_version: process.version,
    pid: process.pid,
  };
};

// ------------------------------------------------------------------
// Caché para /ready
// ------------------------------------------------------------------
type ReadySnapshot = {
  statusCode: number;
  payload: {
    ok: boolean;
    degraded: boolean;
    ts: number;
    uptime_seconds: number;
    checks: {
      db: { ok: boolean; latencyMs: number | null; error: string | null };
      redis: { ok: boolean; latencyMs: number | null; error: string | null };
      push_worker: { running: boolean };
    };
  };
};

let cachedReadySnapshot: { expiresAt: number; data: ReadySnapshot } | null = null;
let inFlightReadySnapshot: Promise<ReadySnapshot> | null = null;

const buildReadySnapshot = async (): Promise<ReadySnapshot> => {
  const [db, redis] = await Promise.all([
    checkDb(READY_DB_TIMEOUT_MS),
    pingRedis(READY_REDIS_TIMEOUT_MS),
  ]);

  const workerStatus = getPushWorkerStatus();
  const allOk = db.ok;            // DB es crítico; Redis es degradado
  const degraded = !redis.ok || !workerStatus.running;

  return {
    statusCode: allOk ? 200 : 503,
    payload: {
      ok: allOk,
      degraded: allOk && degraded,
      ts: Date.now(),
      uptime_seconds: Math.round(process.uptime()),
      checks: {
        db,
        redis,
        push_worker: workerStatus,
      },
    },
  };
};

const getReadySnapshot = async (): Promise<ReadySnapshot> => {
  const now = Date.now();
  if (cachedReadySnapshot && cachedReadySnapshot.expiresAt > now) {
    return cachedReadySnapshot.data;
  }

  if (!inFlightReadySnapshot) {
    inFlightReadySnapshot = buildReadySnapshot()
      .then((snapshot) => {
        cachedReadySnapshot = {
          expiresAt: Date.now() + READY_CHECK_CACHE_MS,
          data: snapshot,
        };
        return snapshot;
      })
      .finally(() => {
        inFlightReadySnapshot = null;
      });
  }

  return inFlightReadySnapshot;
};

// ------------------------------------------------------------------
// Caché para /health
// ------------------------------------------------------------------
type HealthSnapshot = {
  statusCode: number;
  payload: {
    ok: boolean;
    degraded: boolean;
    ts: number;
    service: string;
    version: string;
    process: ReturnType<typeof getProcessMetrics>;
    checks: {
      db: { ok: boolean; latencyMs: number | null; error: string | null };
      redis: { ok: boolean; latencyMs: number | null; error: string | null };
      push_worker: { running: boolean };
    };
  };
};

let cachedHealthSnapshot: { expiresAt: number; data: HealthSnapshot } | null = null;
let inFlightHealthSnapshot: Promise<HealthSnapshot> | null = null;

const buildHealthSnapshot = async (): Promise<HealthSnapshot> => {
  const [db, redis] = await Promise.all([
    checkDb(READY_DB_TIMEOUT_MS),
    pingRedis(READY_REDIS_TIMEOUT_MS),
  ]);

  const workerStatus = getPushWorkerStatus();
  const allOk = db.ok;
  const degraded = !redis.ok || !workerStatus.running;

  return {
    statusCode: allOk ? 200 : 503,
    payload: {
      ok: allOk,
      degraded: allOk && degraded,
      ts: Date.now(),
      service: "minhoo-api",
      version: String(process.env.npm_package_version ?? process.env.APP_VERSION ?? "unknown"),
      process: getProcessMetrics(),
      checks: {
        db,
        redis,
        push_worker: workerStatus,
      },
    },
  };
};

const getHealthSnapshot = async (): Promise<HealthSnapshot> => {
  const now = Date.now();
  if (cachedHealthSnapshot && cachedHealthSnapshot.expiresAt > now) {
    return cachedHealthSnapshot.data;
  }

  if (!inFlightHealthSnapshot) {
    inFlightHealthSnapshot = buildHealthSnapshot()
      .then((snapshot) => {
        cachedHealthSnapshot = {
          expiresAt: Date.now() + HEALTH_CHECK_CACHE_MS,
          data: snapshot,
        };
        return snapshot;
      })
      .finally(() => {
        inFlightHealthSnapshot = null;
      });
  }

  return inFlightHealthSnapshot;
};

// ------------------------------------------------------------------
// Rutas
// ------------------------------------------------------------------

/** Liveness: solo verifica que el proceso Node responde */
router.get("/ping", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    ok: true,
    ts: Date.now(),
    uptime_seconds: Math.round(process.uptime()),
  });
});

/** Alias de /ping para compatibilidad */
router.get("/live", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    ok: true,
    ts: Date.now(),
    uptime_seconds: Math.round(process.uptime()),
  });
});

/**
 * Readiness: ¿puede esta instancia recibir tráfico?
 * - 200 si DB responde (Redis degradado no saca la instancia de rotación)
 * - 503 si DB no responde
 * Usado por load balancers / systemd / Nginx upstream health checks.
 */
router.get("/ready", async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const snapshot = await getReadySnapshot();
    return res.status(snapshot.statusCode).json(snapshot.payload);
  } catch (error: any) {
    return res.status(503).json({
      ok: false,
      degraded: false,
      ts: Date.now(),
      uptime_seconds: Math.round(process.uptime()),
      checks: {
        db: { ok: false, latencyMs: null, error: String(error?.message ?? "readiness check failed") },
        redis: { ok: false, latencyMs: null, error: null },
        push_worker: { running: false },
      },
    });
  }
});

/**
 * Health: estado detallado para monitores externos (Betterstack, UptimeRobot, etc.)
 * - Incluye métricas de proceso, memoria y latencias de dependencias
 * - 200 si DB responde; `degraded: true` si Redis o el worker están caídos
 * - 503 si DB no responde
 */
router.get("/health", async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const snapshot = await getHealthSnapshot();
    return res.status(snapshot.statusCode).json(snapshot.payload);
  } catch (error: any) {
    return res.status(503).json({
      ok: false,
      degraded: false,
      ts: Date.now(),
      service: "minhoo-api",
      checks: {
        db: { ok: false, latencyMs: null, error: String(error?.message ?? "health check failed") },
        redis: { ok: false, latencyMs: null, error: null },
        push_worker: { running: false },
      },
    });
  }
});

export default router;
