import { Router } from "express";
import sequelize from "../_db/connection";

const router = Router();
const READY_CHECK_CACHE_MS = Math.max(
  500,
  Math.trunc(Number(process.env.READY_CHECK_CACHE_MS ?? 5_000) || 5_000)
);
const READY_DB_TIMEOUT_MS = Math.max(
  500,
  Math.trunc(Number(process.env.READY_DB_TIMEOUT_MS ?? 2_000) || 2_000)
);

type ReadySnapshot = {
  statusCode: number;
  payload: {
    ok: boolean;
    ts: number;
    uptime_seconds: number;
    checks: {
      db: {
        ok: boolean;
        error: string | null;
        timeout_ms: number;
      };
    };
  };
};

let cachedReadySnapshot: { expiresAt: number; data: ReadySnapshot } | null = null;
let inFlightReadySnapshot: Promise<ReadySnapshot> | null = null;

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> => {
  return await new Promise<T>((resolve, reject) => {
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

const buildReadySnapshot = async (): Promise<ReadySnapshot> => {
  let dbOk = false;
  let dbError: string | null = null;

  try {
    await withTimeout(
      sequelize.authenticate(),
      READY_DB_TIMEOUT_MS,
      `db readiness timeout after ${READY_DB_TIMEOUT_MS}ms`
    );
    dbOk = true;
  } catch (error: any) {
    dbError = String(error?.message ?? error ?? "db readiness failed");
  }

  const payload = {
    ok: dbOk,
    ts: Date.now(),
    uptime_seconds: Math.round(process.uptime()),
    checks: {
      db: {
        ok: dbOk,
        error: dbError,
        timeout_ms: READY_DB_TIMEOUT_MS,
      },
    },
  };

  return {
    statusCode: dbOk ? 200 : 503,
    payload,
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

router.get("/ping", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    ok: true,
    ts: Date.now(),
    uptime_seconds: Math.round(process.uptime()),
  });
});

router.get("/live", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    ok: true,
    ts: Date.now(),
    uptime_seconds: Math.round(process.uptime()),
  });
});

router.get("/ready", async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const snapshot = await getReadySnapshot();
    return res.status(snapshot.statusCode).json(snapshot.payload);
  } catch (error: any) {
    return res.status(503).json({
      ok: false,
      ts: Date.now(),
      uptime_seconds: Math.round(process.uptime()),
      checks: {
        db: {
          ok: false,
          error: String(error?.message ?? error ?? "readiness check failed"),
          timeout_ms: READY_DB_TIMEOUT_MS,
        },
      },
    });
  }
});

export default router;
