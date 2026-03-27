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

console.log(`🚀 Servidor iniciado correctamente en el puerto ${port}`);
console.log(`🔒 Módulo admin habilitado en /api/v1/admin/users/{id}/disable|enable`);

const shutdownGraceMs = Math.max(
  5_000,
  Math.trunc(Number(process.env.SHUTDOWN_GRACE_MS ?? 15_000) || 15_000)
);
let isShuttingDown = false;

const shutdown = async (signal: NodeJS.Signals) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[shutdown] signal=${signal} grace_ms=${shutdownGraceMs}`);
  try {
    await server.close(shutdownGraceMs);
    console.log("[shutdown] graceful stop completed");
    process.exit(0);
  } catch (error) {
    console.error("[shutdown] graceful stop failed", error);
    process.exit(1);
  }
};

(["SIGINT", "SIGTERM"] as NodeJS.Signals[]).forEach((signal) => {
  process.on(signal, () => {
    void shutdown(signal);
  });
});

process.on("uncaughtException", (error) => {
  console.error("[uncaughtException]", error);
  void shutdown("SIGTERM");
});

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});
