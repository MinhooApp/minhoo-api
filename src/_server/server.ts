import cors from "cors";
import sequelize from "../_db/connection";
import { Server as HttpServer } from "http";
import * as t from "../_models/association";
import { Server as SocketIOServer } from "socket.io";
import express, { Router, Application } from "express";
import { socketController } from "../_sockets/socket_controller";
import { setSocketInstance } from "../_sockets/socket_instance";
import { responseMetricsMiddleware } from "./middleware/response_metrics";

console.log(t);

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

class Server {
  public readonly app = express();
  private server: HttpServer;
  private io: SocketIOServer;
  private readonly port: number;
  private readonly publicPath: string;

  //private host: string;

  constructor(options: Options) {
    const { port, public_path = "public" } = options;
    this.port = port;
    this.publicPath = public_path;
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

    this.app.disable("x-powered-by");
    this.app.use(responseMetricsMiddleware);
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
    this.app.use(express.json());

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
    this.app.use(express.urlencoded({ extended: true })); // x-www-form-urlencoded

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
  /////////////////////////////////
  listen() {
    this.server.listen(this.port, () => {
      console.log("Servidor corriendo en puerto", this.port);
    });
  }
}

export default Server;
