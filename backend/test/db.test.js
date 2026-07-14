const assert = require("node:assert/strict");
const test = require("node:test");

const DB_MODULE_PATH = require.resolve("../src/db");
const CONFIG_MODULE_PATH = require.resolve("../src/config");
const PG_MODULE_PATH = require.resolve("pg");

function loadDbWithMockedRows(rows) {
  const previousDatabaseUrl = process.env.GARAGE_ADMIN_DATABASE_URL;
  const previousPgCache = require.cache[PG_MODULE_PATH];

  delete require.cache[DB_MODULE_PATH];
  delete require.cache[CONFIG_MODULE_PATH];

  process.env.GARAGE_ADMIN_DATABASE_URL = "postgresql://garage-admin-user:garage-admin-password@127.0.0.1:5432/garage_admin_test";

  class MockPool {
    query(text) {
      assert.match(text, /to_regclass\('public\.incidents'\)/);
      assert.match(text, /to_regclass\('public\.action_audit'\)/);
      assert.match(text, /to_regclass\('public\.service_facts'\)/);
      return Promise.resolve({ rows });
    }
  }

  require.cache[PG_MODULE_PATH] = {
    id: PG_MODULE_PATH,
    filename: PG_MODULE_PATH,
    loaded: true,
    exports: { Pool: MockPool },
  };

  const db = require("../src/db");

  return {
    db,
    restore() {
      delete require.cache[DB_MODULE_PATH];
      delete require.cache[CONFIG_MODULE_PATH];

      if (previousPgCache) {
        require.cache[PG_MODULE_PATH] = previousPgCache;
      } else {
        delete require.cache[PG_MODULE_PATH];
      }

      if (previousDatabaseUrl === undefined) {
        delete process.env.GARAGE_ADMIN_DATABASE_URL;
      } else {
        process.env.GARAGE_ADMIN_DATABASE_URL = previousDatabaseUrl;
      }
    },
  };
}

test("getMemoryHealth reports healthy table presence when all memory tables exist", async () => {
  const harness = loadDbWithMockedRows([
    {
      can_select_now: true,
      incidents_present: true,
      action_audit_present: true,
      service_facts_present: true,
    },
  ]);

  try {
    const health = await harness.db.getMemoryHealth();

    assert.equal(health.ok, true);
    assert.equal(health.degraded, false);
    assert.equal(health.databaseConfigured, true);
    assert.equal(health.poolAvailable, true);
    assert.equal(health.checks.canSelectNow, true);
    assert.deepEqual(health.checks.tablePresence, {
      incidents: true,
      action_audit: true,
      service_facts: true,
    });
    assert.equal(health.error, null);
  } finally {
    harness.restore();
  }
});

test("getMemoryHealth reports schema-missing when required memory tables are absent", async () => {
  const harness = loadDbWithMockedRows([
    {
      can_select_now: true,
      incidents_present: false,
      action_audit_present: true,
      service_facts_present: false,
    },
  ]);

  try {
    const health = await harness.db.getMemoryHealth();

    assert.equal(health.ok, false);
    assert.equal(health.degraded, true);
    assert.equal(health.databaseConfigured, true);
    assert.equal(health.poolAvailable, true);
    assert.equal(health.checks.canSelectNow, true);
    assert.deepEqual(health.checks.tablePresence, {
      incidents: false,
      action_audit: true,
      service_facts: false,
    });
    assert.equal(health.error.code, "database_schema_missing");
    assert.equal(health.error.message, harness.db.DATABASE_SCHEMA_MISSING_MESSAGE);
  } finally {
    harness.restore();
  }
});
