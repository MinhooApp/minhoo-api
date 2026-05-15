import crypto from "crypto";
import jwt from "jsonwebtoken";
import { QueryTypes } from "sequelize";
import sequelize from "../../_db/connection";

const AUTH_MULTI_DEVICE_SESSIONS_ENABLED =
  String(process.env.AUTH_MULTI_DEVICE_SESSIONS ?? "1").trim() !== "0";
const AUTH_MULTI_DEVICE_MAX_SESSIONS = Math.max(
  0,
  Number(process.env.AUTH_MULTI_DEVICE_MAX_SESSIONS ?? 20) || 20
);
const AUTH_MULTI_DEVICE_PERSISTENT_TTL_HOURS = Math.max(
  1,
  Number(process.env.AUTH_MULTI_DEVICE_PERSISTENT_TTL_HOURS ?? 24) || 24
);
const AUTH_MULTI_DEVICE_SESSION_TTL_DAYS = Math.max(
  1,
  Number(process.env.AUTH_MULTI_DEVICE_SESSION_TTL_DAYS ?? 60) || 60
);
const AUTH_SESSION_EXPIRATION_GRACE_DAYS = Math.max(
  0,
  Number(
    process.env.AUTH_SESSION_EXPIRATION_GRACE_DAYS ??
      process.env.JWT_EXPIRATION_GRACE_DAYS ??
      0
  ) || 0
);
const AUTH_SESSION_EXPIRATION_GRACE_SECONDS = Math.max(
  0,
  Math.trunc(AUTH_SESSION_EXPIRATION_GRACE_DAYS * 24 * 60 * 60)
);
const AUTH_REFRESH_ROTATION_GRACE_SECONDS = Math.max(
  0,
  Math.min(
    60 * 60,
    Number(process.env.AUTH_REFRESH_ROTATION_GRACE_SECONDS ?? 10 * 60) || 10 * 60
  )
);
const AUTH_DEVICE_ROTATION_PROTECT_SECONDS = Math.max(
  0,
  Math.min(
    120,
    Number(process.env.AUTH_DEVICE_ROTATION_PROTECT_SECONDS ?? 15) || 15
  )
);

const TABLE_NAME = "user_auth_sessions";
let ensureTablePromise: Promise<void> | null = null;

export type AuthSessionRevokeReason =
  | "token_revoke"
  | "refresh_rotation"
  | "manual_logout"
  | "manual_logout_all"
  | "manual_logout_device"
  | "admin_disable"
  | "admin_enable_relogin"
  | "device_rotation_access"
  | "device_rotation_refresh"
  | "session_cap_prune"
  | "unknown";

const normalizeToken = (raw: any): string => {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  if (value.toLowerCase().startsWith("bearer ")) {
    return value.slice(7).trim();
  }
  return value;
};

const normalizeDeviceUuid = (raw: any): string | null => {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  if (value.toLowerCase() === "null" || value.toLowerCase() === "undefined") return null;
  return value;
};

const normalizeRevokeReason = (
  raw: any,
  fallback: AuthSessionRevokeReason = "unknown"
): string => {
  const normalized = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_:\-./]/g, "_")
    .slice(0, 64);
  if (!normalized) return fallback;
  return normalized;
};

const hashToken = (token: string): string =>
  crypto.createHash("sha256").update(token).digest("hex");

const resolveExpiresAtFromToken = (token: string): Date => {
  try {
    const decoded = jwt.decode(token) as any;
    const exp = Number(decoded?.exp ?? 0);
    if (Number.isFinite(exp) && exp > 0) {
      return new Date(exp * 1000);
    }
  } catch (_error) {
    // ignore malformed token and fallback to ttl
  }
  return new Date(Date.now() + AUTH_MULTI_DEVICE_SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
};

type SessionTokenKind = "access" | "refresh" | "unknown";

const normalizeTokenKind = (
  raw: SessionTokenKind
): "access" | "refresh" | "unknown" => {
  if (raw === "access" || raw === "refresh") return raw;
  return "unknown";
};

const resolveSessionTokenKind = (
  token: string,
  expiresAt: Date
): SessionTokenKind => {
  try {
    const decoded = jwt.decode(token) as any;
    const tokenType = String(decoded?.tokenType ?? decoded?.token_type ?? "")
      .trim()
      .toLowerCase();
    if (tokenType === "access") return "access";
    if (tokenType === "refresh") return "refresh";
  } catch (_error) {
    // ignore malformed token type and fallback to TTL heuristic
  }

  const expiresAtMs = expiresAt.getTime();
  if (!Number.isFinite(expiresAtMs)) return "unknown";
  const persistentThresholdMs =
    Date.now() + AUTH_MULTI_DEVICE_PERSISTENT_TTL_HOURS * 60 * 60 * 1000;
  return expiresAtMs > persistentThresholdMs ? "refresh" : "access";
};

const nowSql = "NOW()";
const sessionGraceCutoffSql =
  sequelize.getDialect() === "postgres"
    ? `${nowSql} - (:graceSeconds * INTERVAL '1 second')`
    : `DATE_SUB(${nowSql}, INTERVAL :graceSeconds SECOND)`;
const refreshGraceCutoffSql =
  sequelize.getDialect() === "postgres"
    ? `${nowSql} - (:refreshGraceSeconds * INTERVAL '1 second')`
    : `DATE_SUB(${nowSql}, INTERVAL :refreshGraceSeconds SECOND)`;
const rotationProtectCutoffSql =
  sequelize.getDialect() === "postgres"
    ? `${nowSql} - (:rotationProtectSeconds * INTERVAL '1 second')`
    : `DATE_SUB(${nowSql}, INTERVAL :rotationProtectSeconds SECOND)`;
const persistentSessionCutoffSql =
  sequelize.getDialect() === "postgres"
    ? `${nowSql} + (:persistentHours * INTERVAL '1 hour')`
    : `DATE_ADD(${nowSql}, INTERVAL :persistentHours HOUR)`;
const unknownTokenKindSql =
  "(token_kind IS NULL OR TRIM(token_kind) = '' OR token_kind = 'unknown')";
const refreshSessionKindFilterSql = `(token_kind = 'refresh' OR (${unknownTokenKindSql} AND (expires_at IS NULL OR expires_at > ${persistentSessionCutoffSql})))`;
const accessSessionKindFilterSql = `(token_kind = 'access' OR (${unknownTokenKindSql} AND expires_at IS NOT NULL AND expires_at <= ${persistentSessionCutoffSql}))`;

const ensureTable = async (): Promise<void> => {
  if (!AUTH_MULTI_DEVICE_SESSIONS_ENABLED) return;
  if (ensureTablePromise) return ensureTablePromise;

  ensureTablePromise = (async () => {
    const dialect = sequelize.getDialect();
    if (dialect === "postgres") {
      await sequelize.query(
        `
          CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
            id BIGSERIAL PRIMARY KEY,
            user_id BIGINT NOT NULL,
            device_uuid VARCHAR(255) NULL,
            token_hash VARCHAR(64) NOT NULL UNIQUE,
            token_kind VARCHAR(16) NULL,
            expires_at TIMESTAMPTZ NULL,
            revoked_at TIMESTAMPTZ NULL,
            revoked_reason VARCHAR(64) NULL,
            last_seen_at TIMESTAMPTZ NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `,
        { type: QueryTypes.RAW }
      );
      await sequelize.query(
        `
          ALTER TABLE ${TABLE_NAME}
          ADD COLUMN IF NOT EXISTS revoked_reason VARCHAR(64) NULL;
        `,
        { type: QueryTypes.RAW }
      );
      await sequelize.query(
        `
          ALTER TABLE ${TABLE_NAME}
          ADD COLUMN IF NOT EXISTS token_kind VARCHAR(16) NULL;
        `,
        { type: QueryTypes.RAW }
      );
      await sequelize.query(
        `CREATE INDEX IF NOT EXISTS idx_user_auth_sessions_user_active ON ${TABLE_NAME}(user_id, revoked_at, expires_at);`,
        { type: QueryTypes.RAW }
      );
      await sequelize.query(
        `CREATE INDEX IF NOT EXISTS idx_user_auth_sessions_device_uuid ON ${TABLE_NAME}(device_uuid);`,
        { type: QueryTypes.RAW }
      );
      await sequelize.query(
        `CREATE INDEX IF NOT EXISTS idx_user_auth_sessions_revoked_reason ON ${TABLE_NAME}(revoked_reason, revoked_at);`,
        { type: QueryTypes.RAW }
      );
      await sequelize.query(
        `CREATE INDEX IF NOT EXISTS idx_user_auth_sessions_token_kind ON ${TABLE_NAME}(token_kind, revoked_at, expires_at);`,
        { type: QueryTypes.RAW }
      );
      return;
    }

    await sequelize.query(
      `
        CREATE TABLE IF NOT EXISTS \`${TABLE_NAME}\` (
          \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          \`user_id\` BIGINT UNSIGNED NOT NULL,
          \`device_uuid\` VARCHAR(255) NULL,
          \`token_hash\` VARCHAR(64) NOT NULL,
          \`token_kind\` VARCHAR(16) NULL,
          \`expires_at\` DATETIME NULL,
          \`revoked_at\` DATETIME NULL,
          \`revoked_reason\` VARCHAR(64) NULL,
          \`last_seen_at\` DATETIME NULL,
          \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (\`id\`),
          UNIQUE KEY \`uq_user_auth_sessions_token_hash\` (\`token_hash\`),
          KEY \`idx_user_auth_sessions_user_active\` (\`user_id\`, \`revoked_at\`, \`expires_at\`),
          KEY \`idx_user_auth_sessions_device_uuid\` (\`device_uuid\`),
          KEY \`idx_user_auth_sessions_token_kind\` (\`token_kind\`, \`revoked_at\`, \`expires_at\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `,
      { type: QueryTypes.RAW }
    );

    const hasColumn = async (columnName: string): Promise<boolean> => {
      const rows = (await sequelize.query(
        `
          SELECT COUNT(*) AS column_exists
          FROM information_schema.columns
          WHERE table_schema = DATABASE()
            AND table_name = :tableName
            AND column_name = :columnName
        `,
        {
          replacements: { tableName: TABLE_NAME, columnName },
          type: QueryTypes.SELECT,
        }
      )) as Array<{ column_exists?: number | string }>;
      return Number(rows?.[0]?.column_exists ?? 0) > 0;
    };

    const hasRevokedReasonColumn = await hasColumn("revoked_reason");
    if (!hasRevokedReasonColumn) {
      await sequelize.query(
        `
          ALTER TABLE \`${TABLE_NAME}\`
          ADD COLUMN \`revoked_reason\` VARCHAR(64) NULL AFTER \`revoked_at\`;
        `,
        { type: QueryTypes.RAW }
      );
    }

    const hasTokenKindColumn = await hasColumn("token_kind");
    if (!hasTokenKindColumn) {
      await sequelize.query(
        `
          ALTER TABLE \`${TABLE_NAME}\`
          ADD COLUMN \`token_kind\` VARCHAR(16) NULL AFTER \`token_hash\`;
        `,
        { type: QueryTypes.RAW }
      );
    }

    try {
      await sequelize.query(
        `
          ALTER TABLE \`${TABLE_NAME}\`
          ADD KEY \`idx_user_auth_sessions_revoked_reason\` (\`revoked_reason\`, \`revoked_at\`);
        `,
        { type: QueryTypes.RAW }
      );
    } catch (error: any) {
      const msg = String(error?.message || error).toLowerCase();
      if (!msg.includes("duplicate key name")) throw error;
    }

    try {
      await sequelize.query(
        `
          ALTER TABLE \`${TABLE_NAME}\`
          ADD KEY \`idx_user_auth_sessions_token_kind\` (\`token_kind\`, \`revoked_at\`, \`expires_at\`);
        `,
        { type: QueryTypes.RAW }
      );
    } catch (error: any) {
      const msg = String(error?.message || error).toLowerCase();
      if (!msg.includes("duplicate key name")) throw error;
    }
  })().catch((error) => {
    ensureTablePromise = null;
    throw error;
  });

  return ensureTablePromise;
};

const pruneUserSessions = async (userId: number): Promise<void> => {
  if (!AUTH_MULTI_DEVICE_SESSIONS_ENABLED) return;
  if (AUTH_MULTI_DEVICE_MAX_SESSIONS <= 0) return;

  // Only cap persistent sessions (e.g. refresh-style lifetimes).
  // Access tokens are short-lived and should not evict durable sessions.
  const rows = (await sequelize.query(
    `
      SELECT id
      FROM ${TABLE_NAME}
      WHERE user_id = :userId
        AND revoked_at IS NULL
        AND ${refreshSessionKindFilterSql}
      ORDER BY COALESCE(last_seen_at, created_at) DESC, id DESC
    `,
    {
      replacements: {
        userId,
        persistentHours: AUTH_MULTI_DEVICE_PERSISTENT_TTL_HOURS,
      },
      type: QueryTypes.SELECT,
    }
  )) as Array<{ id: number }>;

  if (!Array.isArray(rows) || rows.length <= AUTH_MULTI_DEVICE_MAX_SESSIONS) return;
  const ids = rows.slice(AUTH_MULTI_DEVICE_MAX_SESSIONS).map((row) => Number(row.id));
  if (!ids.length) return;

  await sequelize.query(
    `
      UPDATE ${TABLE_NAME}
      SET revoked_at = ${nowSql},
          revoked_reason = :revokedReason
      WHERE id IN (:ids)
    `,
    {
      replacements: {
        ids,
        revokedReason: normalizeRevokeReason("session_cap_prune"),
      },
      type: QueryTypes.UPDATE,
    }
  );
};

export const registerUserAuthSession = async (
  userIdRaw: any,
  tokenRaw: any,
  options?: { deviceUuid?: string | null }
): Promise<void> => {
  if (!AUTH_MULTI_DEVICE_SESSIONS_ENABLED) return;

  const userId = Number(userIdRaw);
  const token = normalizeToken(tokenRaw);
  if (!Number.isFinite(userId) || userId <= 0) return;
  if (!token) return;

  await ensureTable();

  const tokenHash = hashToken(token);
  const deviceUuid = normalizeDeviceUuid(options?.deviceUuid);
  const expiresAt = resolveExpiresAtFromToken(token);
  const tokenKind = normalizeTokenKind(resolveSessionTokenKind(token, expiresAt));
  const dialect = sequelize.getDialect();

  if (dialect === "postgres") {
      await sequelize.query(
        `
        INSERT INTO ${TABLE_NAME}
          (user_id, device_uuid, token_hash, token_kind, expires_at, revoked_at, revoked_reason, last_seen_at, created_at)
        VALUES
          (:userId, :deviceUuid, :tokenHash, :tokenKind, :expiresAt, NULL, NULL, ${nowSql}, ${nowSql})
        ON CONFLICT (token_hash)
        DO UPDATE SET
          user_id = EXCLUDED.user_id,
          device_uuid = EXCLUDED.device_uuid,
          token_kind = EXCLUDED.token_kind,
          expires_at = EXCLUDED.expires_at,
          revoked_at = NULL,
          revoked_reason = NULL,
          last_seen_at = ${nowSql}
      `,
        {
        replacements: {
          userId,
          deviceUuid,
          tokenHash,
          tokenKind,
          expiresAt,
        },
        type: QueryTypes.INSERT,
      }
    );
  } else {
    await sequelize.query(
      `
        INSERT INTO ${TABLE_NAME}
          (user_id, device_uuid, token_hash, token_kind, expires_at, revoked_at, revoked_reason, last_seen_at, created_at)
        VALUES
          (:userId, :deviceUuid, :tokenHash, :tokenKind, :expiresAt, NULL, NULL, ${nowSql}, ${nowSql})
        ON DUPLICATE KEY UPDATE
          user_id = VALUES(user_id),
          device_uuid = VALUES(device_uuid),
          token_kind = VALUES(token_kind),
          expires_at = VALUES(expires_at),
          revoked_at = NULL,
          revoked_reason = NULL,
          last_seen_at = ${nowSql}
      `,
      {
        replacements: {
          userId,
          deviceUuid,
          tokenHash,
          tokenKind,
          expiresAt,
        },
        type: QueryTypes.INSERT,
      }
    );
  }

  if (deviceUuid) {
    // Keep one "current" token per device for each token family.
    // Critical: do not revoke refresh when persisting access (e.g. /auth/device-token).
    const sameKindFilterSql =
      tokenKind === "refresh"
        ? `AND ${refreshSessionKindFilterSql}`
        : tokenKind === "access"
          ? `AND ${accessSessionKindFilterSql}`
          : "";
    const recentProtectionSql =
      AUTH_DEVICE_ROTATION_PROTECT_SECONDS > 0
        ? `AND created_at < ${rotationProtectCutoffSql}`
        : "";
    const rotationReason =
      tokenKind === "refresh" ? "device_rotation_refresh" : "device_rotation_access";
    await sequelize.query(
      `
        UPDATE ${TABLE_NAME}
        SET revoked_at = ${nowSql},
            revoked_reason = :revokedReason
        WHERE user_id = :userId
          AND device_uuid = :deviceUuid
          AND token_hash <> :tokenHash
          AND revoked_at IS NULL
          ${sameKindFilterSql}
          ${recentProtectionSql}
      `,
      {
        replacements: {
          userId,
          deviceUuid,
          tokenHash,
          persistentHours: AUTH_MULTI_DEVICE_PERSISTENT_TTL_HOURS,
          rotationProtectSeconds: AUTH_DEVICE_ROTATION_PROTECT_SECONDS,
          revokedReason: normalizeRevokeReason(rotationReason),
        },
        type: QueryTypes.UPDATE,
      }
    );
  }

  await pruneUserSessions(userId);
};

export const isUserAuthSessionActive = async (
  userIdRaw: any,
  tokenRaw: any,
  options?: { allowRefreshGrace?: boolean }
): Promise<boolean> => {
  if (!AUTH_MULTI_DEVICE_SESSIONS_ENABLED) return false;

  const userId = Number(userIdRaw);
  const token = normalizeToken(tokenRaw);
  if (!Number.isFinite(userId) || userId <= 0) return false;
  if (!token) return false;

  await ensureTable();

  const tokenHash = hashToken(token);
  const allowRefreshGrace =
    Boolean(options?.allowRefreshGrace) && AUTH_REFRESH_ROTATION_GRACE_SECONDS > 0;
  const allowRefreshGraceInt = allowRefreshGrace ? 1 : 0;
  const rows = (await sequelize.query(
    `
      SELECT s.id
      FROM ${TABLE_NAME} s
      WHERE s.user_id = :userId
        AND s.token_hash = :tokenHash
        AND (
          (
            s.revoked_at IS NULL
            AND (s.expires_at IS NULL OR s.expires_at > ${sessionGraceCutoffSql})
          )
          OR
          (
            :allowRefreshGrace = 1
            AND s.revoked_at IS NOT NULL
            AND s.revoked_at >= ${refreshGraceCutoffSql}
            AND ${refreshSessionKindFilterSql}
            AND EXISTS (
              SELECT 1
              FROM ${TABLE_NAME} n
              WHERE n.user_id = s.user_id
                AND n.id <> s.id
                AND n.revoked_at IS NULL
                AND ${refreshSessionKindFilterSql}
                AND (
                  s.device_uuid IS NULL
                  OR n.device_uuid = s.device_uuid
                )
            )
          )
        )
      LIMIT 1
    `,
    {
      replacements: {
        userId,
        tokenHash,
        graceSeconds: AUTH_SESSION_EXPIRATION_GRACE_SECONDS,
        allowRefreshGrace: allowRefreshGraceInt,
        refreshGraceSeconds: AUTH_REFRESH_ROTATION_GRACE_SECONDS,
        persistentHours: AUTH_MULTI_DEVICE_PERSISTENT_TTL_HOURS,
      },
      type: QueryTypes.SELECT,
    }
  )) as Array<{ id: number }>;

  if (!Array.isArray(rows) || rows.length === 0) return false;

  const id = Number(rows[0].id);
  if (Number.isFinite(id) && id > 0) {
    void sequelize
      .query(
        `
          UPDATE ${TABLE_NAME}
          SET last_seen_at = ${nowSql}
          WHERE id = :id
        `,
        {
          replacements: { id },
          type: QueryTypes.UPDATE,
        }
      )
      .catch(() => null);
  }

  return true;
};

export const hasUserActivePersistentAuthSession = async (
  userIdRaw: any,
  options?: { deviceUuid?: any }
): Promise<boolean> => {
  if (!AUTH_MULTI_DEVICE_SESSIONS_ENABLED) return false;

  const userId = Number(userIdRaw);
  if (!Number.isFinite(userId) || userId <= 0) return false;
  const deviceUuid = normalizeDeviceUuid(options?.deviceUuid ?? null);

  await ensureTable();

  const whereDeviceSql = deviceUuid ? "AND device_uuid = :deviceUuid" : "";
  const rows = (await sequelize.query(
    `
      SELECT id
      FROM ${TABLE_NAME}
      WHERE user_id = :userId
        AND revoked_at IS NULL
        AND ${refreshSessionKindFilterSql}
        ${whereDeviceSql}
      LIMIT 1
    `,
    {
      replacements: {
        userId,
        deviceUuid,
        persistentHours: AUTH_MULTI_DEVICE_PERSISTENT_TTL_HOURS,
      },
      type: QueryTypes.SELECT,
    }
  )) as Array<{ id: number }>;

  return Array.isArray(rows) && rows.length > 0;
};

export const revokeUserAuthSessionToken = async (
  userIdRaw: any,
  tokenRaw: any,
  reason: AuthSessionRevokeReason = "token_revoke"
): Promise<void> => {
  if (!AUTH_MULTI_DEVICE_SESSIONS_ENABLED) return;

  const userId = Number(userIdRaw);
  const token = normalizeToken(tokenRaw);
  if (!Number.isFinite(userId) || userId <= 0) return;
  if (!token) return;

  await ensureTable();
  const tokenHash = hashToken(token);

  await sequelize.query(
    `
      UPDATE ${TABLE_NAME}
      SET revoked_at = ${nowSql},
          revoked_reason = :revokedReason
      WHERE user_id = :userId
        AND token_hash = :tokenHash
        AND revoked_at IS NULL
    `,
    {
      replacements: {
        userId,
        tokenHash,
        revokedReason: normalizeRevokeReason(reason),
      },
      type: QueryTypes.UPDATE,
    }
  );
};

export const revokeAllUserAuthSessions = async (
  userIdRaw: any,
  reason: AuthSessionRevokeReason = "manual_logout_all"
): Promise<void> => {
  if (!AUTH_MULTI_DEVICE_SESSIONS_ENABLED) return;

  const userId = Number(userIdRaw);
  if (!Number.isFinite(userId) || userId <= 0) return;

  await ensureTable();

  await sequelize.query(
    `
      UPDATE ${TABLE_NAME}
      SET revoked_at = ${nowSql},
          revoked_reason = :revokedReason
      WHERE user_id = :userId
        AND revoked_at IS NULL
    `,
    {
      replacements: {
        userId,
        revokedReason: normalizeRevokeReason(reason),
      },
      type: QueryTypes.UPDATE,
    }
  );
};

/**
 * Returns true ONLY when the token exists in the session table AND has been
 * explicitly revoked (revoked_at IS NOT NULL).
 * Returns false if the record is missing, active, or the call fails.
 *
 * Use this to distinguish "token was cancelled" from "token record simply
 * isn't here" — the latter should not force a hard logout.
 */
export const isUserAuthSessionExplicitlyRevoked = async (
  userIdRaw: any,
  tokenRaw: any
): Promise<boolean> => {
  if (!AUTH_MULTI_DEVICE_SESSIONS_ENABLED) return false;

  const userId = Number(userIdRaw);
  const token = normalizeToken(tokenRaw);
  if (!Number.isFinite(userId) || userId <= 0) return false;
  if (!token) return false;

  await ensureTable();
  const tokenHash = hashToken(token);

  const rows = (await sequelize.query(
    `SELECT id FROM ${TABLE_NAME}
     WHERE user_id = :userId
       AND token_hash = :tokenHash
       AND revoked_at IS NOT NULL
     LIMIT 1`,
    {
      replacements: { userId, tokenHash },
      type: QueryTypes.SELECT,
    }
  )) as Array<{ id: number }>;

  return Array.isArray(rows) && rows.length > 0;
};

export const revokeAuthSessionsByDeviceUuid = async (
  deviceUuidRaw: any,
  options?: {
    userId?: number | null;
    excludeUserId?: number | null;
    reason?: AuthSessionRevokeReason;
  }
): Promise<void> => {
  if (!AUTH_MULTI_DEVICE_SESSIONS_ENABLED) return;

  const deviceUuid = normalizeDeviceUuid(deviceUuidRaw);
  if (!deviceUuid) return;

  const userId = Number(options?.userId ?? 0);
  const excludeUserId = Number(options?.excludeUserId ?? 0);
  const reason = normalizeRevokeReason(options?.reason ?? "manual_logout_device");

  await ensureTable();

  const whereParts = ["device_uuid = :deviceUuid", "revoked_at IS NULL"];
  const replacements: Record<string, any> = { deviceUuid };

  if (Number.isFinite(userId) && userId > 0) {
    whereParts.push("user_id = :userId");
    replacements.userId = userId;
  }

  if (Number.isFinite(excludeUserId) && excludeUserId > 0) {
    whereParts.push("user_id <> :excludeUserId");
    replacements.excludeUserId = excludeUserId;
  }

  await sequelize.query(
    `
      UPDATE ${TABLE_NAME}
      SET revoked_at = ${nowSql},
          revoked_reason = :revokedReason
      WHERE ${whereParts.join(" AND ")}
    `,
    {
      replacements: {
        ...replacements,
        revokedReason: reason,
      },
      type: QueryTypes.UPDATE,
    }
  );
};
