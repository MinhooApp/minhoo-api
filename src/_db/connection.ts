import { Dialect, Sequelize } from "sequelize";
import { database } from "./config";

const sequelizeView = new Sequelize(
    database.database!,
    database.username!,
    database.password!,
    {
        host: database.host,
        dialect: database.dialect as Dialect,
        logging: true //False not display queries in console
    }
);

export default sequelizeView;