import dotenv from 'dotenv'
dotenv.config()

export const database = {
    dialect: process.env.DIALECT_DB,
    username: process.env.USER_DB,
    password: process.env.DB_PASSWORD,
    database: process.env.DB,
    host: process.env.DB_HOST,
}

export default database
