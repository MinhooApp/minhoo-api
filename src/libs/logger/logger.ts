/**
 * Centralized structured logger.
 *
 * - Writes JSON lines to stdout (captured by journald/systemd)
 * - Writes JSON lines to a daily-rotating file in logs/
 * - Optionally ships to Better Stack (Logtail) when LOGTAIL_SOURCE_TOKEN is set
 *
 * Usage:
 *   import logger from "../libs/logger/logger";
 *   logger.info({ event: "user.login", userId: 123 });
 *   logger.error({ event: "db.query_failed", error: err.message });
 */

import fs from "fs";
import path from "path";
import os from "os";

// ------------------------------------------------------------------
// Config
// ------------------------------------------------------------------
const LOG_DIR = path.resolve(process.cwd(), "logs");
const LOG_LEVEL_ENV = String(process.env.LOG_LEVEL ?? "info").trim().toLowerCase();
const LOG_TO_FILE = !["0", "false", "no", "off"].includes(
  String(process.env.LOG_TO_FILE ?? "1").trim().toLowerCase()
);
const LOG_TO_STDOUT = !["0", "false", "no", "off"].includes(
  String(process.env.LOG_TO_STDOUT ?? "1").trim().toLowerCase()
);
const LOGTAIL_TOKEN = String(process.env.LOGTAIL_SOURCE_TOKEN ?? "").trim();
const LOGTAIL_FLUSH_MS = Math.max(
  1_000,
  Number(process.env.LOGTAIL_FLUSH_MS ?? 3_000) || 3_000
);
const LOG_MAX_FILE_DAYS = Math.max(
  1,
  Number(process.env.LOG_MAX_FILE_DAYS ?? 7) || 7
);

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;
const minLevel: number = LEVELS[LOG_LEVEL_ENV as Level] ?? LEVELS.info;

const SERVICE_NAME = "minhoo-api";
const HOSTNAME = os.hostname();
const PORT = String(process.env.PORT ?? "unknown");

// ------------------------------------------------------------------
// File writer with daily rotation
// ------------------------------------------------------------------
let _currentDay = "";
let _fileStream: fs.WriteStream | null = null;

const todayStr = () => new Date().toISOString().slice(0, 10); // YYYY-MM-DD

const ensureLogDir = () => {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
};

const getFileStream = (): fs.WriteStream | null => {
  if (!LOG_TO_FILE) return null;
  try {
    ensureLogDir();
    const day = todayStr();
    if (day !== _currentDay || !_fileStream) {
      if (_fileStream) {
        try { _fileStream.end(); } catch { /* ignore */ }
      }
      _currentDay = day;
      const filePath = path.join(LOG_DIR, `app-${day}.log`);
      _fileStream = fs.createWriteStream(filePath, { flags: "a", encoding: "utf8" });
      _fileStream.on("error", () => { _fileStream = null; });
      pruneOldLogs();
    }
    return _fileStream;
  } catch {
    return null;
  }
};

const pruneOldLogs = () => {
  try {
    const files = fs.readdirSync(LOG_DIR)
      .filter((f) => /^app-\d{4}-\d{2}-\d{2}\.log$/.test(f))
      .sort();
    const cutoff = LOG_MAX_FILE_DAYS + 1;
    if (files.length > cutoff) {
      files.slice(0, files.length - cutoff).forEach((f) => {
        try { fs.unlinkSync(path.join(LOG_DIR, f)); } catch { /* ignore */ }
      });
    }
  } catch { /* ignore */ }
};

// ------------------------------------------------------------------
// Better Stack (Logtail) HTTP transport — batched, non-blocking
// ------------------------------------------------------------------
let _logtailBatch: object[] = [];
let _logtailTimer: ReturnType<typeof setTimeout> | null = null;

const flushToLogtail = () => {
  if (!LOGTAIL_TOKEN || !_logtailBatch.length) return;
  const batch = _logtailBatch.splice(0);
  _logtailTimer = null;

  // Fire-and-forget HTTP POST, no dependency on axios
  const body = JSON.stringify(batch);
  try {
    const https = require("https") as typeof import("https");
    const req = https.request(
      {
        hostname: "in.logtail.com",
        path: "/",
        method: "POST",
        headers: {
          "Authorization": `Bearer ${LOGTAIL_TOKEN}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 8_000,
      },
      (res) => { res.resume(); }
    );
    req.on("error", () => { /* silent — logging must never crash the app */ });
    req.write(body);
    req.end();
  } catch { /* ignore */ }
};

const scheduleLogtailFlush = () => {
  if (_logtailTimer || !LOGTAIL_TOKEN) return;
  _logtailTimer = setTimeout(flushToLogtail, LOGTAIL_FLUSH_MS);
  if (typeof (_logtailTimer as any)?.unref === "function") {
    (_logtailTimer as any).unref();
  }
};

const sendToLogtail = (entry: object) => {
  if (!LOGTAIL_TOKEN) return;
  _logtailBatch.push(entry);
  if (_logtailBatch.length >= 100) {
    flushToLogtail();
  } else {
    scheduleLogtailFlush();
  }
};

// ------------------------------------------------------------------
// Core write
// ------------------------------------------------------------------
const write = (level: Level, data: string | object, extra?: object) => {
  if (LEVELS[level] < minLevel) return;

  const entry: Record<string, any> = {
    ts: new Date().toISOString(),
    level,
    service: SERVICE_NAME,
    host: HOSTNAME,
    port: PORT,
  };

  if (typeof data === "string") {
    entry.message = data;
  } else {
    Object.assign(entry, data);
  }
  if (extra) Object.assign(entry, extra);

  const line = JSON.stringify(entry) + "\n";

  if (LOG_TO_STDOUT) {
    try { process.stdout.write(line); } catch { /* ignore */ }
  }

  const stream = getFileStream();
  if (stream) {
    try { stream.write(line); } catch { /* ignore */ }
  }

  sendToLogtail(entry);
};

// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------
const logger = {
  debug: (data: string | object, extra?: object) => write("debug", data, extra),
  info:  (data: string | object, extra?: object) => write("info",  data, extra),
  warn:  (data: string | object, extra?: object) => write("warn",  data, extra),
  error: (data: string | object, extra?: object) => write("error", data, extra),

  /** Flush any buffered Logtail entries immediately (call on graceful shutdown). */
  flush: () => {
    if (_logtailTimer) { clearTimeout(_logtailTimer); _logtailTimer = null; }
    flushToLogtail();
    if (_fileStream) { try { _fileStream.end(); } catch { /* ignore */ } _fileStream = null; }
  },
};

export default logger;
