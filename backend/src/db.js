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

const DATABASE_SCHEMA_MISSING_MESSAGE =
  "Garage Admin memory database is reachable/configured, but required schema tables are missing. Apply the schema with `npm run db:schema` from the Garage Admin V2 repo.";

const pool = connectionString
  ? new Pool({
      connectionString,
      connectionTimeoutMillis: config.databaseConnectTimeoutMs,
      idleTimeoutMillis: config.databaseIdleTimeoutMs,
      max: config.databasePoolMax,
      query_timeout: config.databaseQueryTimeoutMs,
      statement_timeout: config.databaseStatementTimeoutMs,
    })
  : null;

function classifyDatabaseError(error) {
  const code = error?.code || error?.name || "database_error";
  const message = String(error?.message || "");

  if (code === "pool_missing") {
    return {
      code: "database_not_configured",
      message: "Garage Admin memory database is not configured.",
    };
  }

  if (code === "ETIMEDOUT" || code === "ETIMEOUT" || code === "query_timeout" || /timeout/i.test(message)) {
    return {
      code: "database_timeout",
      message: "Garage Admin memory database did not respond before the configured timeout.",
    };
  }

  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EHOSTUNREACH" || code === "ENETUNREACH") {
    return {
      code: "database_unreachable",
      message: "Garage Admin memory database is unreachable from this host.",
    };
  }

  if (code === "42P01") {
    return {
      code: "database_schema_missing",
      message: DATABASE_SCHEMA_MISSING_MESSAGE,
    };
  }

  if (code === "28P01" || code === "28000") {
    return {
      code: "database_auth_failed",
      message: "Garage Admin memory database authentication failed.",
    };
  }

  return {
    code: "database_error",
    message: "Garage Admin memory database check failed.",
  };
}

async function query(text, params) {
  if (!pool) {
    const error = new Error("GARAGE_ADMIN_DATABASE_URL or DATABASE_URL is not configured");
    error.statusCode = 500;
    error.code = "pool_missing";
    throw error;
  }

  return pool.query(text, params);
}

async function getMemoryHealth() {
  const started = Date.now();
  const base = {
    ok: false,
    degraded: true,
    databaseConfigured: Boolean(connectionString),
    poolAvailable: Boolean(pool),
    latencyMs: null,
    checks: {
      canSelectNow: false,
      tablePresence: {
        incidents: false,
        action_audit: false,
        service_facts: false,
      },
    },
    error: null,
  };

  if (!pool) {
    return {
      ...base,
      latencyMs: Date.now() - started,
      error: classifyDatabaseError({ code: "pool_missing" }),
    };
  }

  try {
    const result = await query(
      `SELECT
        NOW() IS NOT NULL AS can_select_now,
        to_regclass('public.incidents') IS NOT NULL AS incidents_present,
        to_regclass('public.action_audit') IS NOT NULL AS action_audit_present,
        to_regclass('public.service_facts') IS NOT NULL AS service_facts_present`,
    );
    const row = result.rows[0] || {};
    const tablePresence = {
      incidents: row.incidents_present === true,
      action_audit: row.action_audit_present === true,
      service_facts: row.service_facts_present === true,
    };
    const tablesReady = Object.values(tablePresence).every(Boolean);

    return {
      ok: row.can_select_now === true && tablesReady,
      degraded: !(row.can_select_now === true && tablesReady),
      databaseConfigured: true,
      poolAvailable: true,
      latencyMs: Date.now() - started,
      checks: {
        canSelectNow: row.can_select_now === true,
        tablePresence,
      },
      error: tablesReady
        ? null
        : {
            code: "database_schema_missing",
            message: DATABASE_SCHEMA_MISSING_MESSAGE,
          },
    };
  } catch (error) {
    return {
      ...base,
      latencyMs: Date.now() - started,
      error: classifyDatabaseError(error),
    };
  }
}

module.exports = {
  DATABASE_SCHEMA_MISSING_MESSAGE,
  classifyDatabaseError,
  getMemoryHealth,
  pool,
  query,
};
