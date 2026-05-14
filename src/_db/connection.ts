import { Dialect, Sequelize } from "sequelize";
import { database } from "./config";

const sqlLoggingEnabled = ["1", "true", "yes", "on"].includes(
  String(process.env.DB_LOG_SQL ?? "").trim().toLowerCase()
);

const sequelizeLogging: false | ((sql: string) => void) = sqlLoggingEnabled
  ? (sql: string) => console.log(sql)
  : false;

const parsePositiveInt = (value: any, fallback: number, min = 1) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.floor(parsed));
};

const dbPoolMax = parsePositiveInt(process.env.DB_POOL_MAX, 25, 2);
const dbPoolMin = Math.min(parsePositiveInt(process.env.DB_POOL_MIN, 5, 0), dbPoolMax);
const dbPoolAcquireMs = parsePositiveInt(process.env.DB_POOL_ACQUIRE_MS, 20_000, 1000);
const dbPoolIdleMs = parsePositiveInt(process.env.DB_POOL_IDLE_MS, 10_000, 1000);
const dbPoolEvictMs = parsePositiveInt(process.env.DB_POOL_EVICT_MS, 1_000, 100);
const dbPoolMaxUses = parsePositiveInt(process.env.DB_POOL_MAX_USES, 7_500, 100);
const dbConnectTimeoutMs = parsePositiveInt(process.env.DB_CONNECT_TIMEOUT_MS, 10_000, 1000);

const dbQueryTimeoutMs = parsePositiveInt(process.env.DB_QUERY_TIMEOUT_MS, 8_000, 1000);

const dialect = String(database.dialect ?? "").trim().toLowerCase();
const dialectOptions: Record<string, any> = {};
if (dialect === "mysql") {
  dialectOptions.connectTimeout = dbConnectTimeoutMs;
  // Note: MySQL2 does not support a per-query timeout via dialectOptions.
  // Query timeout is enforced at the application level (DB_QUERY_TIMEOUT_MS
  // is used by individual repository calls that wrap queries in Promise.race).
}
if (dialect === "mariadb") {
  dialectOptions.connectTimeout = dbConnectTimeoutMs;
  dialectOptions.queryTimeout = dbQueryTimeoutMs;
}
if (dialect === "postgres") {
  dialectOptions.statement_timeout = dbQueryTimeoutMs;
}

const sequelizeView = new Sequelize(
    database.database!,
    database.username!,
    database.password!,
    {
        host: database.host,
        dialect: database.dialect as Dialect,
        logging: sequelizeLogging,
        pool: {
            max: dbPoolMax,
            min: dbPoolMin,
            acquire: dbPoolAcquireMs,
            idle: dbPoolIdleMs,
            evict: dbPoolEvictMs,
            maxUses: dbPoolMaxUses,
            // Validates connection before handing it to a query.
            // Stale/broken connections are discarded instead of causing query errors.
            validate: (connection: any) => {
                try {
                    return connection && !connection._fatalError && !connection._protocolError;
                } catch {
                    return false;
                }
            },
        },
        dialectOptions,
    }
);

export default sequelizeView;
