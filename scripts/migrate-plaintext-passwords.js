#!/usr/bin/env node
"use strict";

/**
 * Migra contraseñas en texto plano a bcrypt.
 *
 * El servidor ya auto-migra en cada login exitoso (src/useCases/auth/login/login.ts:498).
 * Este script cubre usuarios que no han iniciado sesión recientemente.
 *
 * DETECCIÓN DE BCRYPT: usa LEFT(password, 4) IN ('$2a$','$2b$','$2y$')
 *   No usa REGEXP porque MySQL elimina el backslash de '\$' en string literals,
 *   rompiendo silenciosamente el patrón y haciendo que REGEXP nunca haga match.
 *
 * Uso:
 *   node scripts/migrate-plaintext-passwords.js             # migración real
 *   node scripts/migrate-plaintext-passwords.js --dry-run   # solo cuenta, sin modificar
 *   node scripts/migrate-plaintext-passwords.js --test-id=N # prueba una sola cuenta (id=N)
 *
 * Requiere acceso a .secrets/ — correr como: sudo -u appuser node scripts/migrate-plaintext-passwords.js
 */

/* eslint-disable no-console */
const path   = require("path");
const dotenv = require("dotenv");
const bcrypt = require("bcryptjs");
const mysql2 = require("mysql2/promise");
const { applyFileBackedSecrets } = require("./_utils/apply-file-backed-secrets");

// ── Configuración ────────────────────────────────────────────────────────────
const BATCH_SIZE      = 50;
const BATCH_PAUSE_MS  = 200;
const BCRYPT_ROUNDS   = 10;    // Igual que generatePassword.ts → genSaltSync() default
const BCRYPT_HASH_RE  = /^\$2[aby]\$\d{2}\$/;  // solo para el check en memoria JS
const CONNECT_TIMEOUT = 10_000;

// Prefijos bcrypt que usa LEFT(password,4) — SIN REGEXP para evitar escaping de MySQL
const BCRYPT_PREFIXES = ["'$2a$'", "'$2b$'", "'$2y$'"].join(", ");
// Expresión SQL para "IS bcrypt"
const SQL_IS_BCRYPT     = `LEFT(password, 4) IN ('$2a$', '$2b$', '$2y$')`;
// Expresión SQL para "IS plaintext"
const SQL_IS_PLAINTEXT  = `password IS NOT NULL AND LEFT(password, 4) NOT IN ('$2a$', '$2b$', '$2y$')`;

const DRY_RUN   = process.argv.includes("--dry-run");
const TEST_ID   = (() => {
  const arg = process.argv.find((a) => a.startsWith("--test-id="));
  return arg ? Number(arg.split("=")[1]) : null;
})();

// ── Entorno ──────────────────────────────────────────────────────────────────
dotenv.config({ path: path.resolve(process.cwd(), ".env") });
applyFileBackedSecrets(process.env, {
  forceOverride: false,
  allowCreateMissingTargets: false,
  baseDir: process.cwd(),
});

const DB_HOST     = process.env.DB_HOST     || "127.0.0.1";
const DB_USER     = process.env.USER_DB     || process.env.DB_USER || "";
const DB_PASSWORD = process.env.DB_PASSWORD || "";
const DB_NAME     = process.env.DB          || process.env.DB_NAME || "";

if (!DB_USER || !DB_PASSWORD || !DB_NAME) {
  console.error(JSON.stringify({
    event: "config_error",
    error: "Faltan variables: USER_DB / DB_PASSWORD / DB",
    ts: new Date().toISOString(),
  }));
  process.exit(1);
}

// ── Logger JSON ──────────────────────────────────────────────────────────────
const log = (event, data = {}) =>
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), dry_run: DRY_RUN, ...data }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Cierre gracioso ──────────────────────────────────────────────────────────
let shuttingDown = false;
process.on("SIGINT",  () => { shuttingDown = true; log("signal", { signal: "SIGINT",  message: "Finalizando lote actual..." }); });
process.on("SIGTERM", () => { shuttingDown = true; log("signal", { signal: "SIGTERM", message: "Finalizando lote actual..." }); });

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  log("start", { batch_size: BATCH_SIZE, bcrypt_rounds: BCRYPT_ROUNDS, test_id: TEST_ID });

  let db;
  try {
    db = await mysql2.createConnection({
      host:           DB_HOST,
      user:           DB_USER,
      password:       DB_PASSWORD,
      database:       DB_NAME,
      charset:        "utf8mb4",
      connectTimeout: CONNECT_TIMEOUT,
    });

    // ── Muestra de contraseñas (diagnóstico sin exponer valores) ────────────
    // Permite confirmar el estado real ANTES de cualquier acción
    const [samples] = await db.query(`
      SELECT
        id,
        LEFT(password, 7)  AS pass_prefix,
        LENGTH(password)   AS pass_len,
        IF(${SQL_IS_BCRYPT}, 'bcrypt', 'plaintext') AS pass_type
      FROM users
      WHERE is_deleted = 0 AND password IS NOT NULL
      ORDER BY id ASC
      LIMIT 5
    `);
    log("samples", { rows: samples });

    // ── Diagnóstico correcto con LEFT/IN ──────────────────────────────────
    const [[summary]] = await db.query(`
      SELECT
        COUNT(*)                                                     AS total_users,
        SUM(password IS NULL)                                        AS sin_password,
        SUM(password IS NOT NULL AND ${SQL_IS_BCRYPT})               AS bcrypt_ok,
        SUM(${SQL_IS_PLAINTEXT})                                     AS plaintext_pendiente
      FROM users
      WHERE is_deleted = 0
    `);

    const total    = Number(summary.total_users);
    const pending  = Number(summary.plaintext_pendiente);
    const bcryptOk = Number(summary.bcrypt_ok);
    const noPass   = Number(summary.sin_password);

    log("diagnostic", {
      total_users:         total,
      sin_password:        noPass,
      bcrypt_ok:           bcryptOk,
      plaintext_pendiente: pending,
      pct_migrated:        total > 0 ? `${((bcryptOk / total) * 100).toFixed(1)}%` : "n/a",
    });

    if (pending === 0 && !TEST_ID) {
      log("done", { message: "No hay contraseñas en texto plano. Migración completa." });
      return;
    }

    if (DRY_RUN) {
      log("dry_run_exit", {
        message:             `${pending} cuentas pendientes.`,
        accion:              "Ejecutar sin --dry-run para aplicar.",
        tiempo_estimado_min: estimatedMinutes(pending),
      });
      return;
    }

    // ── Modo test: procesa una sola cuenta específica ────────────────────
    if (TEST_ID) {
      await testSingleAccount(db, TEST_ID);
      return;
    }

    // ── Migración por lotes ──────────────────────────────────────────────
    let offset        = 0;
    let totalProcessed = 0;
    let totalUpdated   = 0;
    let totalSkipped   = 0;
    let totalErrors    = 0;

    const startMs = Date.now();

    while (!shuttingDown) {
      const [rows] = await db.query(
        `SELECT id, password
         FROM users
         WHERE is_deleted = 0
           AND ${SQL_IS_PLAINTEXT}
         ORDER BY id ASC
         LIMIT ? OFFSET ?`,
        [BATCH_SIZE, offset]
      );

      if (rows.length === 0) break;

      const batchStart = Date.now();
      let batchErrors  = 0;

      log("batch_start", {
        offset,
        count:     rows.length,
        processed: totalProcessed,
        remaining: pending - totalUpdated - totalSkipped,
      });

      for (const row of rows) {
        if (shuttingDown) break;

        totalProcessed++;

        // Doble-check en memoria (paranoia: lo que devuelve el SELECT debería ser plaintext)
        if (BCRYPT_HASH_RE.test(row.password || "")) {
          // Si llega aquí, SQL_IS_BCRYPT / SQL_IS_PLAINTEXT es incorrecto para este valor
          log("warn_unexpected_bcrypt", { user_id: row.id, prefix: String(row.password).slice(0, 7) });
          totalSkipped++;
          continue;
        }

        if (!row.password || row.password.trim() === "") {
          log("skip_empty", { user_id: row.id });
          totalSkipped++;
          continue;
        }

        try {
          const hash = await bcrypt.hash(row.password, BCRYPT_ROUNDS);

          // WHERE password = ? es la guardia contra race condition con login concurrente:
          // si el login ya actualizó la fila, el valor en disco ya no es el plaintext → no-op
          const [result] = await db.query(
            "UPDATE users SET password = ? WHERE id = ? AND password = ?",
            [hash, row.id, row.password]
          );

          if (result.affectedRows > 0) {
            totalUpdated++;
          } else {
            // El login concurrente ya migró a este usuario entre el SELECT y el UPDATE
            totalSkipped++;
            log("skipped_concurrent", { user_id: row.id });
          }
        } catch (err) {
          batchErrors++;
          totalErrors++;
          log("error", { user_id: row.id, message: err.message });
        }
      }

      const batchMs = Date.now() - batchStart;
      log("batch_done", {
        batch_ms:      batchMs,
        total_updated: totalUpdated,
        total_skipped: totalSkipped,
        total_errors:  totalErrors,
        progress_pct:  pending > 0
          ? `${(((totalUpdated + totalSkipped) / pending) * 100).toFixed(1)}%`
          : "n/a",
      });

      // Avanzar offset solo si TODOS los del lote fallaron (guarda anti-bucle infinito)
      if (batchErrors > 0 && batchErrors === rows.length) {
        log("batch_all_failed", { offset, advancing_by: BATCH_SIZE });
        offset += BATCH_SIZE;
      }

      await sleep(BATCH_PAUSE_MS);
    }

    if (shuttingDown) {
      log("interrupted", { message: "Detenido por señal. Re-ejecutar para continuar." });
    }

    // ── Diagnóstico final ────────────────────────────────────────────────
    const [[after]] = await db.query(`
      SELECT SUM(${SQL_IS_PLAINTEXT}) AS plaintext_restante
      FROM users WHERE is_deleted = 0
    `);

    log("done", {
      elapsed_sec:        ((Date.now() - startMs) / 1000).toFixed(1),
      total_processed:    totalProcessed,
      total_updated:      totalUpdated,
      total_skipped:      totalSkipped,
      total_errors:       totalErrors,
      plaintext_restante: Number(after.plaintext_restante),
      success:            totalErrors === 0 && !shuttingDown,
    });

    if (totalErrors > 0) process.exit(1);

  } finally {
    if (db) try { await db.end(); } catch (_) {}
  }
}

// ── Test de una sola cuenta ──────────────────────────────────────────────────
async function testSingleAccount(db, userId) {
  log("test_start", { user_id: userId });

  const [[row]] = await db.query(
    `SELECT id, LEFT(password, 7) AS prefix, LENGTH(password) AS len,
            IF(${SQL_IS_BCRYPT}, 'bcrypt', 'plaintext') AS type
     FROM users WHERE id = ? AND is_deleted = 0`,
    [userId]
  );

  if (!row) {
    log("test_error", { user_id: userId, message: "Usuario no encontrado o eliminado" });
    return;
  }

  log("test_account_state", { user_id: userId, pass_prefix: row.prefix, pass_len: row.len, pass_type: row.type });

  if (row.type === "bcrypt") {
    log("test_skip", { user_id: userId, message: "Ya tiene bcrypt. No se modifica." });
    return;
  }

  // Leer el valor real para poder hashear
  const [[full]] = await db.query("SELECT id, password FROM users WHERE id = ?", [userId]);

  if (!full.password || full.password.trim() === "") {
    log("test_skip", { user_id: userId, message: "Password vacío. No se puede migrar." });
    return;
  }

  const hash = await bcrypt.hash(full.password, BCRYPT_ROUNDS);

  // Verificar que el hash es válido antes de escribir
  const valid = await bcrypt.compare(full.password, hash);
  if (!valid) {
    log("test_error", { user_id: userId, message: "bcrypt.compare falló tras hash. Abortando." });
    process.exit(1);
  }

  log("test_hash_ok", { user_id: userId, hash_prefix: hash.slice(0, 10) });

  const [result] = await db.query(
    "UPDATE users SET password = ? WHERE id = ? AND password = ?",
    [hash, userId, full.password]
  );

  log("test_result", {
    user_id:       userId,
    affected_rows: result.affectedRows,
    success:       result.affectedRows > 0,
    message:       result.affectedRows > 0
      ? "Migración de test exitosa. Verifica que el login funciona."
      : "affectedRows=0. El password cambió entre SELECT y UPDATE (login concurrente).",
  });
}

// ── Estimación de tiempo ─────────────────────────────────────────────────────
function estimatedMinutes(count) {
  const msPerUser     = 100;  // bcrypt 10 rounds ≈ 100ms en hardware moderno
  const pausePerBatch = BATCH_PAUSE_MS / BATCH_SIZE;
  return `~${Math.ceil((count * (msPerUser + pausePerBatch)) / 60_000)} min`;
}

main().catch((err) => {
  console.error(JSON.stringify({
    event: "fatal",
    error: err.message,
    stack: err.stack,
    ts:    new Date().toISOString(),
  }));
  process.exit(1);
});
