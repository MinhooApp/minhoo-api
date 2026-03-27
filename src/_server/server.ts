import cors from "cors";
import sequelize from "../_db/connection";
import { Server as HttpServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { createClient } from "redis";
import { randomUUID } from "crypto";
import express, { Router } from "express";
import { socketController } from "../_sockets/socket_controller";
import { setSocketInstance } from "../_sockets/socket_instance";
import { responseMetricsMiddleware } from "./middleware/response_metrics";
const compression = require("compression");

interface Options {
  port: number;
  public_path?: string;
}

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

const parseAllowedCorsOrigins = (): string[] => {
  const raw = String(process.env.CORS_ORIGINS ?? "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const isProduction = () =>
  String(process.env.NODE_ENV ?? "").trim().toLowerCase() === "production";

const shouldTrustProxy = () => isTruthy(process.env.TRUST_PROXY);
const shouldEnableHttpCompression = () => !isTruthy(process.env.HTTP_COMPRESSION_DISABLED);
const shouldEnableSocketRedisAdapter = () =>
  !isTruthy(process.env.SOCKET_REDIS_ADAPTER_DISABLED ?? "0");
const resolveSocketRedisUrl = () =>
  String(process.env.SOCKET_REDIS_URL ?? process.env.REDIS_URL ?? "").trim();
const resolveSocketMaxHttpBufferSize = () => {
  const parsed = Number(process.env.SOCKET_MAX_HTTP_BUFFER_SIZE ?? 1_000_000);
  if (!Number.isFinite(parsed)) return 1_000_000;
  return Math.max(32_768, Math.trunc(parsed));
};
const resolveSocketConnectTimeoutMs = () => {
  const parsed = Number(process.env.SOCKET_CONNECT_TIMEOUT_MS ?? 45_000);
  if (!Number.isFinite(parsed)) return 45_000;
  return Math.max(5_000, Math.trunc(parsed));
};
const shouldEnableSocketPerMessageDeflate = () =>
  isTruthy(process.env.SOCKET_PERMESSAGE_DEFLATE ?? "0");
const resolveRequestBodyLimit = (envKey: string, fallback: string) => {
  const raw = String((process.env as any)?.[envKey] ?? "").trim();
  if (!raw) return fallback;
  return raw;
};
const resolveHttpMaxUrlLength = () => {
  const parsed = Number(process.env.HTTP_MAX_URL_LENGTH ?? 8192);
  if (!Number.isFinite(parsed)) return 8192;
  return Math.max(1024, Math.trunc(parsed));
};
const resolveUrlencodedParameterLimit = () => {
  const parsed = Number(process.env.HTTP_URLENCODED_PARAMETER_LIMIT ?? 1000);
  if (!Number.isFinite(parsed)) return 1000;
  return Math.max(100, Math.trunc(parsed));
};
const resolveHttpCompressionLevel = () => {
  const parsed = Number(process.env.HTTP_COMPRESSION_LEVEL ?? 6);
  if (!Number.isFinite(parsed)) return 6;
  return Math.min(9, Math.max(-1, Math.trunc(parsed)));
};
const resolveHttpCompressionThresholdBytes = () => {
  const parsed = Number(process.env.HTTP_COMPRESSION_THRESHOLD_BYTES ?? 1024);
  if (!Number.isFinite(parsed) || parsed < 0) return 1024;
  return Math.trunc(parsed);
};
const resolveHttpMaxHeadersCount = () => {
  const parsed = Number(process.env.HTTP_MAX_HEADERS_COUNT ?? 120);
  if (!Number.isFinite(parsed)) return 120;
  return Math.max(32, Math.trunc(parsed));
};
const resolveHttpMaxRequestsPerSocket = () => {
  const parsed = Number(process.env.HTTP_MAX_REQUESTS_PER_SOCKET ?? 1000);
  if (!Number.isFinite(parsed)) return 1000;
  return Math.max(0, Math.trunc(parsed));
};
const resolveHttpSocketTimeoutMs = () => {
  const parsed = Number(process.env.HTTP_SOCKET_TIMEOUT_MS ?? 60_000);
  if (!Number.isFinite(parsed)) return 60_000;
  return Math.max(5_000, Math.trunc(parsed));
};
const resolveHttpMaxConnections = () => {
  const parsed = Number(process.env.HTTP_MAX_CONNECTIONS ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.trunc(parsed));
};

class Server {
  public readonly app = express();
  private server: HttpServer;
  private io: SocketIOServer;
  private readonly port: number;
  private readonly publicPath: string;
  private redisPubClient: ReturnType<typeof createClient> | null = null;
  private redisSubClient: ReturnType<typeof createClient> | null = null;
  private finalHandlersRegistered = false;
  private shutdownPromise: Promise<void> | null = null;

  //private host: string;

  constructor(options: Options) {
    const { port, public_path = "public" } = options;
    this.port = port;
    this.publicPath = public_path;
    this.app.set("query parser", "simple");
    this.app.set("json escape", true);
    if (shouldTrustProxy()) {
      this.app.set("trust proxy", true);
    }
    const allowedCorsOrigins = parseAllowedCorsOrigins();
    const allowAllCorsInProd = isTruthy(process.env.CORS_ALLOW_ALL_IN_PROD);
    const corsAllowsAll = !isProduction() && !allowedCorsOrigins.length
      ? true
      : allowAllCorsInProd;
    const allowOrigin = (originRaw: any): boolean => {
      const origin = String(originRaw ?? "").trim();
      if (!origin) return true; // server-to-server / curl / native apps
      if (corsAllowsAll) return true;
      return allowedCorsOrigins.includes(origin);
    };

    this.server = new HttpServer(this.app);
    this.server.maxHeadersCount = resolveHttpMaxHeadersCount();
    const maxRequestsPerSocket = resolveHttpMaxRequestsPerSocket();
    if (maxRequestsPerSocket > 0) {
      this.server.maxRequestsPerSocket = maxRequestsPerSocket;
    }
    const maxConnections = resolveHttpMaxConnections();
    if (maxConnections > 0) {
      this.server.maxConnections = maxConnections;
    }
    this.server.setTimeout(resolveHttpSocketTimeoutMs());
    this.server.on("clientError", (error: Error, socket: any) => {
      const message = String(error?.message ?? "");
      const expectedNoise = /ECONNRESET|socket hang up|Parse Error|HPE_/i.test(message);
      if (!expectedNoise) {
        console.warn(`[http] client_error: ${message}`);
      }
      try {
        if (socket?.writable) {
          socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        }
      } catch (_socketError) {
        // ignore socket close errors
      }
    });
    this.io = new SocketIOServer(this.server, {
      transports: ["websocket", "polling"],
      allowUpgrades: true,
      serveClient: false,
      connectionStateRecovery: {
        maxDisconnectionDuration: 2 * 60 * 1000,
        skipMiddlewares: true,
      },
      pingInterval: 25000,
      pingTimeout: 20000,
      connectTimeout: resolveSocketConnectTimeoutMs(),
      maxHttpBufferSize: resolveSocketMaxHttpBufferSize(),
      perMessageDeflate: shouldEnableSocketPerMessageDeflate(),
      cors: {
        origin: (origin, callback) => {
          if (allowOrigin(origin)) return callback(null, true);
          return callback(new Error("socket origin not allowed by CORS"), false);
        },
        methods: ["GET", "POST"],
        credentials: false,
      },
    });
    if (isProduction() && !corsAllowsAll && !allowedCorsOrigins.length) {
      console.warn(
        "[cors] NODE_ENV=production and CORS_ORIGINS is empty. Browser origins will be blocked."
      );
    }
    this.server.keepAliveTimeout = 30_000;
    this.server.headersTimeout = 35_000;
    this.server.requestTimeout = 30_000;
    void this.configureSocketAdapter();
    setSocketInstance(this.io);
    this.middlewares();
    this.dbConnection();
    this.configure();

    /////////Sockets/////////////socketController
    this.sockets();
  }

  async dbConnection() {
    try {
      const shouldSyncOnBoot =
        !isProduction() || isTruthy(process.env.DB_SYNC_ON_BOOT);

      if (shouldSyncOnBoot) {
        // Se usa para crear las tablas de manera inicial
        await sequelize.sync({ force: false });
      } else {
        // En producción preferimos migraciones controladas en lugar de sync automático.
        await sequelize.authenticate();
      }
      console.log("✔️  Database Online !!!");
    } catch (error: any) {
      console.log(error);
      throw new Error("🚫 " + error);
    }
  }

  middlewares() {
    const allowedCorsOrigins = parseAllowedCorsOrigins();
    const allowAllCorsInProd = isTruthy(process.env.CORS_ALLOW_ALL_IN_PROD);
    const corsAllowsAll = !isProduction() && !allowedCorsOrigins.length
      ? true
      : allowAllCorsInProd;
    const jsonBodyLimit = resolveRequestBodyLimit("HTTP_JSON_LIMIT", "1mb");
    const maxUrlLength = resolveHttpMaxUrlLength();

    this.app.disable("x-powered-by");
    this.app.use((req: any, res: any, next: any) => {
      const incoming = String(req.header("x-request-id") ?? "")
        .trim()
        .slice(0, 128);
      const requestId = incoming || randomUUID();
      req.requestId = requestId;
      if (!res.locals) res.locals = {};
      res.locals.requestId = requestId;
      res.setHeader("X-Request-Id", requestId);
      return next();
    });
    this.app.use((req: any, res: any, next: any) => {
      const rawUrl = String(req?.originalUrl ?? req?.url ?? "");
      if (rawUrl.length > maxUrlLength) {
        return res.status(414).json({
          header: { success: false },
          body: { message: "request uri too long" },
          request_id: String(res.locals?.requestId ?? ""),
        });
      }
      return next();
    });
    this.app.use((req: any, res: any, next: any) => {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
      res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");

      const forwardedProto = String(req.header("x-forwarded-proto") ?? "").trim().toLowerCase();
      const isHttps = req.secure || forwardedProto === "https";
      if (isProduction() && isHttps) {
        res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
      }
      return next();
    });
    this.app.use(responseMetricsMiddleware);
    if (shouldEnableHttpCompression()) {
      const level = resolveHttpCompressionLevel();
      const threshold = resolveHttpCompressionThresholdBytes();
      this.app.use(
        compression({
          level,
          threshold,
          filter: (req: any, res: any) => {
            const cacheControl = String(res.getHeader("cache-control") ?? "").toLowerCase();
            if (cacheControl.includes("no-transform")) return false;
            return compression.filter(req, res);
          },
        })
      );
    }
    // CORS con allowlist en producción.
    this.app.use(
      cors({
        origin: (origin, callback) => {
          if (!origin) return callback(null, true);
          if (corsAllowsAll || allowedCorsOrigins.includes(origin)) {
            return callback(null, true);
          }
          return callback(new Error("origin not allowed by CORS"));
        },
        credentials: false,
      })
    );
    //Body Read
    this.app.use(express.json({ limit: jsonBodyLimit }));
    this.app.use((error: any, _req: any, res: any, next: any) => {
      if (error?.type === "entity.too.large") {
        return res.status(413).json({
          header: { success: false },
          body: { message: "request body too large" },
          request_id: String(res.locals?.requestId ?? ""),
        });
      }
      return next(error);
    });

    //Public Folder
    this.app.use(
      express.static("src/public", {
        etag: true,
        maxAge: "1h",
        setHeaders: (res, filePath) => {
          if (/\.(css|js|svg)$/i.test(filePath)) {
            res.setHeader(
              "Cache-Control",
              "public, max-age=3600, stale-while-revalidate=86400"
            );
          } else if (/\.html$/i.test(filePath)) {
            res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
          }
        },
      })
    );
  }

  public setRoutes(ruoter: Router) {
    this.app.use(ruoter);
  }

  private configure() {
    //* Middlewares
    const urlencodedBodyLimit = resolveRequestBodyLimit("HTTP_URLENCODED_LIMIT", "1mb");
    const urlencodedParameterLimit = resolveUrlencodedParameterLimit();
    this.app.use(
      express.urlencoded({
        extended: true,
        limit: urlencodedBodyLimit,
        parameterLimit: urlencodedParameterLimit,
      })
    ); // x-www-form-urlencoded

    //* Public Folder
    this.app.use(
      express.static(this.publicPath, {
        etag: true,
        maxAge: "1h",
      })
    );
  }

  sockets() {
    this.io.on("connection", socketController);
  }

  private registerFinalHandlers() {
    if (this.finalHandlersRegistered) return;

    this.app.use((_req: any, res: any) => {
      if (res.headersSent) return;
      return res.status(404).json({
        header: { success: false },
        body: { message: "route not found" },
        request_id: String(res.locals?.requestId ?? ""),
      });
    });

    this.app.use((error: any, _req: any, res: any, _next: any) => {
      if (res.headersSent) return;
      const status = Number(error?.status ?? error?.statusCode ?? 500);
      const safeStatus = Number.isFinite(status) && status >= 400 && status <= 599 ? status : 500;
      const message =
        safeStatus >= 500 ? "internal server error" : String(error?.message ?? "request failed");
      return res.status(safeStatus).json({
        header: { success: false },
        body: { message },
        request_id: String(res.locals?.requestId ?? ""),
      });
    });

    this.finalHandlersRegistered = true;
  }

  private async configureSocketAdapter() {
    if (!shouldEnableSocketRedisAdapter()) {
      console.log("[socket-adapter] redis adapter disabled by env");
      return;
    }

    const redisUrl = resolveSocketRedisUrl();
    if (!redisUrl) {
      console.log("[socket-adapter] redis url not configured, using local adapter");
      return;
    }

    try {
      const pubClient = createClient({ url: redisUrl });
      const subClient = pubClient.duplicate();

      pubClient.on("error", (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error ?? "unknown");
        console.warn(`[socket-adapter] redis pub error: ${message}`);
      });
      subClient.on("error", (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error ?? "unknown");
        console.warn(`[socket-adapter] redis sub error: ${message}`);
      });

      await Promise.all([pubClient.connect(), subClient.connect()]);
      this.io.adapter(createAdapter(pubClient, subClient));
      this.redisPubClient = pubClient;
      this.redisSubClient = subClient;
      console.log("[socket-adapter] redis adapter enabled");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error ?? "unknown");
      console.warn(`[socket-adapter] redis adapter unavailable, fallback local: ${message}`);
    }
  }
  /////////////////////////////////
  listen() {
    this.registerFinalHandlers();
    this.server.listen(this.port, () => {
      console.log("Servidor corriendo en puerto", this.port);
    });
    return this.server;
  }

  async close(graceMs = 15_000) {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    this.shutdownPromise = (async () => {
      const safeGraceMs = Math.max(2_000, Math.trunc(Number(graceMs) || 15_000));
      const serverAny = this.server as any;

      try {
        // Stop accepting new realtime traffic immediately.
        this.io.disconnectSockets(true);
        this.io.close();
      } catch (_err) {
        // ignore socket close errors during shutdown
      }

      const forceTimer = setTimeout(() => {
        try {
          if (typeof serverAny?.closeIdleConnections === "function") {
            serverAny.closeIdleConnections();
          }
          if (typeof serverAny?.closeAllConnections === "function") {
            serverAny.closeAllConnections();
          }
        } catch (_forceErr) {
          // ignore force-close errors
        }
      }, safeGraceMs);

      if (typeof (forceTimer as any)?.unref === "function") {
        (forceTimer as any).unref();
      }

      try {
        await new Promise<void>((resolve, reject) => {
          this.server.close((error?: Error) => {
            if (error && !/not running/i.test(String(error.message ?? ""))) {
              return reject(error);
            }
            return resolve();
          });
        });
      } finally {
        clearTimeout(forceTimer);
      }

      await Promise.allSettled([
        this.redisPubClient ? this.redisPubClient.quit() : Promise.resolve(),
        this.redisSubClient ? this.redisSubClient.quit() : Promise.resolve(),
      ]);
      this.redisPubClient = null;
      this.redisSubClient = null;
    })();

    return this.shutdownPromise;
  }
}

export default Server;
