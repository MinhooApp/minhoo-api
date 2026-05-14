// ===============================
//  Minhoo API — app.ts (Main Entry)
//  Autor: Sr Eder
//  Fecha: 2025-11-11
//  Nota: Integrado con rutas de administrador
// ===============================

import "./libs/config/bootstrap_env";
import "./_models/association";
import Server from "./_server/server";
import { AppRoutes } from "./_routes/routes";
import { startPushWorker, stopPushWorker } from "./libs/jobs/push_worker";
import logger from "./libs/logger/logger";

// Redirect console.error/warn through the structured logger so all
// existing call sites get JSON-formatted output and Logtail shipping
// without needing to touch every file.
const _origError = console.error.bind(console);
const _origWarn  = console.warn.bind(console);
console.error = (...args: any[]) => {
  logger.error({ event: "console.error", message: args.map(String).join(" ") });
};
console.warn = (...args: any[]) => {
  logger.warn({ event: "console.warn", message: args.map(String).join(" ") });
};

// ⚙️ Puerto del archivo .env o 3000 por defecto
const port = parseInt(process.env.PORT || "3000");

// 🧩 Inicializar servidor HTTP (estructura modular de Minhoo)
const server = new Server({ port });

// ===============================
// 🔗 IMPORTAR RUTAS
// ===============================

// Rutas principales del sistema (ya configuradas en AppRoutes)
server.setRoutes(AppRoutes.routes);

// ===============================
// 🚀 Iniciar servidor
// ===============================

server.listen();
startPushWorker();

logger.info({ event: "server.started", port });
console.log(`🚀 Servidor iniciado correctamente en el puerto ${port}`);

const shutdownGraceMs = Math.max(
  5_000,
  Math.trunc(Number(process.env.SHUTDOWN_GRACE_MS ?? 15_000) || 15_000)
);
let isShuttingDown = false;

const shutdown = async (signal: NodeJS.Signals) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info({ event: "server.shutdown", signal, grace_ms: shutdownGraceMs });
  try {
    await stopPushWorker();
    await server.close(shutdownGraceMs);
    logger.info({ event: "server.shutdown_complete" });
    logger.flush();
    process.exit(0);
  } catch (error) {
    _origError("[shutdown] graceful stop failed", error);
    logger.flush();
    process.exit(1);
  }
};

(["SIGINT", "SIGTERM"] as NodeJS.Signals[]).forEach((signal) => {
  process.on(signal, () => {
    void shutdown(signal);
  });
});

process.on("uncaughtException", (error) => {
  logger.error({ event: "process.uncaught_exception", error: String(error) });
  void shutdown("SIGTERM");
});

process.on("unhandledRejection", (reason) => {
  logger.error({ event: "process.unhandled_rejection", reason: String(reason) });
  // Trigger graceful shutdown so systemd restarts the process cleanly.
  // Staying alive after an unhandled rejection risks silent corrupt state.
  void shutdown("SIGTERM");
});
