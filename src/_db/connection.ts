import { Dialect, Sequelize } from "sequelize";
import { database } from "./config";

const sqlLoggingEnabled = ["1", "true", "yes", "on"].includes(
  String(process.env.DB_LOG_SQL ?? "").trim().toLowerCase()
);

const sequelizeLogging: false | ((sql: string) => void) = sqlLoggingEnabled
  ? (sql: string) => console.log(sql)
  : false;

const sequelizeView = new Sequelize(
    database.database!,
    database.username!,
    database.password!,
    {
        host: database.host,
        dialect: database.dialect as Dialect,
        logging: sequelizeLogging
    }
);

export default sequelizeView;
