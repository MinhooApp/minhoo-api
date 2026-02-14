// ===============================
//  Minhoo API — app.ts (Main Entry)
//  Autor: Sr Eder
//  Fecha: 2025-11-11
//  Nota: Integrado con rutas de administrador
// ===============================

import dotenv from "dotenv";
import { createServer } from "http";
import Server from "./_server/server";
import { AppRoutes } from "./_routes/routes";
import { monitorNetwork } from "./libs/networkMonitor";
import express from "express";

// ⚙️ Cargar variables de entorno
dotenv.config();

// ⚙️ Puerto del archivo .env o 3000 por defecto
const port = parseInt(process.env.PORT || "3000");

// 🧩 Inicializar servidor HTTP (estructura modular de Minhoo)
const server = new Server({ port });

// ===============================
// 🔗 IMPORTAR RUTAS
// ===============================

// Rutas principales del sistema (ya configuradas en AppRoutes)
server.setRoutes(AppRoutes.routes);

// Rutas de administrador (habilitar / deshabilitar usuarios)
import adminUserRoutes from "./admin/admin_user_routes";

// Vincular módulo de administración
// (nota: usa /api/v1/admin/... como prefijo)
server.app.use("/api/v1/admin", adminUserRoutes);

// ===============================
// 🚀 Iniciar servidor
// ===============================

server.listen();

// ===============================
// 🧠 Monitor de red
// ===============================
monitorNetwork();

console.log(`🚀 Servidor iniciado correctamente en el puerto ${port}`);
console.log(`🔒 Módulo admin habilitado en /api/v1/admin/users/{id}/disable|enable`);
