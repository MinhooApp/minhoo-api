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
const AUTH_MULTI_DEVICE_SESSION_TTL_DAYS = Math.max(
  1,
  Number(process.env.AUTH_MULTI_DEVICE_SESSION_TTL_DAYS ?? 60) || 60
);

const TABLE_NAME = "user_auth_sessions";
let ensureTablePromise: Promise<void> | null = null;

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

const nowSql = "NOW()";

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
            expires_at TIMESTAMPTZ NULL,
            revoked_at TIMESTAMPTZ NULL,
            last_seen_at TIMESTAMPTZ NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
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
      return;
    }

    await sequelize.query(
      `
        CREATE TABLE IF NOT EXISTS \`${TABLE_NAME}\` (
          \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          \`user_id\` BIGINT UNSIGNED NOT NULL,
          \`device_uuid\` VARCHAR(255) NULL,
          \`token_hash\` VARCHAR(64) NOT NULL,
          \`expires_at\` DATETIME NULL,
          \`revoked_at\` DATETIME NULL,
          \`last_seen_at\` DATETIME NULL,
          \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (\`id\`),
          UNIQUE KEY \`uq_user_auth_sessions_token_hash\` (\`token_hash\`),
          KEY \`idx_user_auth_sessions_user_active\` (\`user_id\`, \`revoked_at\`, \`expires_at\`),
          KEY \`idx_user_auth_sessions_device_uuid\` (\`device_uuid\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `,
      { type: QueryTypes.RAW }
    );
  })().catch((error) => {
    ensureTablePromise = null;
    throw error;
  });

  return ensureTablePromise;
};

const pruneUserSessions = async (userId: number): Promise<void> => {
  if (!AUTH_MULTI_DEVICE_SESSIONS_ENABLED) return;
  if (AUTH_MULTI_DEVICE_MAX_SESSIONS <= 0) return;

  const rows = (await sequelize.query(
    `
      SELECT id
      FROM ${TABLE_NAME}
      WHERE user_id = :userId
        AND revoked_at IS NULL
      ORDER BY COALESCE(last_seen_at, created_at) DESC, id DESC
    `,
    {
      replacements: { userId },
      type: QueryTypes.SELECT,
    }
  )) as Array<{ id: number }>;

  if (!Array.isArray(rows) || rows.length <= AUTH_MULTI_DEVICE_MAX_SESSIONS) return;
  const ids = rows.slice(AUTH_MULTI_DEVICE_MAX_SESSIONS).map((row) => Number(row.id));
  if (!ids.length) return;

  await sequelize.query(
    `
      UPDATE ${TABLE_NAME}
      SET revoked_at = ${nowSql}
      WHERE id IN (:ids)
    `,
    {
      replacements: { ids },
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
  const dialect = sequelize.getDialect();

  if (dialect === "postgres") {
    await sequelize.query(
      `
        INSERT INTO ${TABLE_NAME}
          (user_id, device_uuid, token_hash, expires_at, revoked_at, last_seen_at, created_at)
        VALUES
          (:userId, :deviceUuid, :tokenHash, :expiresAt, NULL, ${nowSql}, ${nowSql})
        ON CONFLICT (token_hash)
        DO UPDATE SET
          user_id = EXCLUDED.user_id,
          device_uuid = EXCLUDED.device_uuid,
          expires_at = EXCLUDED.expires_at,
          revoked_at = NULL,
          last_seen_at = ${nowSql}
      `,
      {
        replacements: {
          userId,
          deviceUuid,
          tokenHash,
          expiresAt,
        },
        type: QueryTypes.INSERT,
      }
    );
  } else {
    await sequelize.query(
      `
        INSERT INTO ${TABLE_NAME}
          (user_id, device_uuid, token_hash, expires_at, revoked_at, last_seen_at, created_at)
        VALUES
          (:userId, :deviceUuid, :tokenHash, :expiresAt, NULL, ${nowSql}, ${nowSql})
        ON DUPLICATE KEY UPDATE
          user_id = VALUES(user_id),
          device_uuid = VALUES(device_uuid),
          expires_at = VALUES(expires_at),
          revoked_at = NULL,
          last_seen_at = ${nowSql}
      `,
      {
        replacements: {
          userId,
          deviceUuid,
          tokenHash,
          expiresAt,
        },
        type: QueryTypes.INSERT,
      }
    );
  }

  if (deviceUuid) {
    await sequelize.query(
      `
        UPDATE ${TABLE_NAME}
        SET revoked_at = ${nowSql}
        WHERE user_id = :userId
          AND device_uuid = :deviceUuid
          AND token_hash <> :tokenHash
          AND revoked_at IS NULL
      `,
      {
        replacements: {
          userId,
          deviceUuid,
          tokenHash,
        },
        type: QueryTypes.UPDATE,
      }
    );
  }

  await pruneUserSessions(userId);
};

export const isUserAuthSessionActive = async (
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
    `
      SELECT id
      FROM ${TABLE_NAME}
      WHERE user_id = :userId
        AND token_hash = :tokenHash
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > ${nowSql})
      LIMIT 1
    `,
    {
      replacements: { userId, tokenHash },
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

export const revokeUserAuthSessionToken = async (
  userIdRaw: any,
  tokenRaw: any
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
      SET revoked_at = ${nowSql}
      WHERE user_id = :userId
        AND token_hash = :tokenHash
        AND revoked_at IS NULL
    `,
    {
      replacements: { userId, tokenHash },
      type: QueryTypes.UPDATE,
    }
  );
};

export const revokeAllUserAuthSessions = async (userIdRaw: any): Promise<void> => {
  if (!AUTH_MULTI_DEVICE_SESSIONS_ENABLED) return;

  const userId = Number(userIdRaw);
  if (!Number.isFinite(userId) || userId <= 0) return;

  await ensureTable();

  await sequelize.query(
    `
      UPDATE ${TABLE_NAME}
      SET revoked_at = ${nowSql}
      WHERE user_id = :userId
        AND revoked_at IS NULL
    `,
    {
      replacements: { userId },
      type: QueryTypes.UPDATE,
    }
  );
};

export const revokeAuthSessionsByDeviceUuid = async (
  deviceUuidRaw: any,
  options?: { userId?: number | null; excludeUserId?: number | null }
): Promise<void> => {
  if (!AUTH_MULTI_DEVICE_SESSIONS_ENABLED) return;

  const deviceUuid = normalizeDeviceUuid(deviceUuidRaw);
  if (!deviceUuid) return;

  const userId = Number(options?.userId ?? 0);
  const excludeUserId = Number(options?.excludeUserId ?? 0);

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
      SET revoked_at = ${nowSql}
      WHERE ${whereParts.join(" AND ")}
    `,
    {
      replacements,
      type: QueryTypes.UPDATE,
    }
  );
};
