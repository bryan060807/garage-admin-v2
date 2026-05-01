const { Pool } = require("pg");
const config = require("./config");

function buildConnectionString() {
  if (!config.databaseUrl) {
    return "";
  }

  const url = new URL(config.databaseUrl);

  if (config.databaseHost) {
    url.hostname = config.databaseHost;
  }

  if (config.databasePort) {
    url.port = String(config.databasePort);
  }

  return url.toString();
}

const connectionString = buildConnectionString();

const pool = connectionString
  ? new Pool({
      connectionString,
    })
  : null;

async function query(text, params) {
  if (!pool) {
    const error = new Error("GARAGE_ADMIN_DATABASE_URL or DATABASE_URL is not configured");
    error.statusCode = 500;
    throw error;
  }

  return pool.query(text, params);
}

module.exports = {
  pool,
  query,
};
