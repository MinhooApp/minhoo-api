require('dotenv').config();

const shared = {
  username: process.env.USER_DB || 'root',
  password: process.env.DB_PASSWORD || null,
  database: process.env.DB || 'mnh_db',
  host: process.env.DB_HOST || '127.0.0.1',
  dialect: process.env.DIALECT_DB || 'mysql',
};

module.exports = {
  development: shared,
  test: shared,
  production: shared,
};
