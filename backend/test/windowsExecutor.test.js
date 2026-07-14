const assert = require("node:assert/strict");
const test = require("node:test");

const windowsExecutor = require("../src/lib/windowsExecutor");

function pm2Snapshot(statuses = {}) {
  const checkedAt = "2026-06-02T12:00:00.000Z";
  const normalized = {};

  Object.entries(statuses).forEach(([processName, status]) => {
    normalized[processName] = {
      processName,
      status,
      pm2Status: status,
      uptimeSeconds: 120,
      restarts: 1,
      pid: 1000,
      checkedAt,
    };
  });

  return {
    ok: true,
    checkedAt,
    statuses: normalized,
    processes: {},
    error: null,
  };
}

test("verifyHttpUrl reports timeout probes without leaking AbortError text", async () => {
  const previousFetch = global.fetch;

  try {
    global.fetch = async (_url, options = {}) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const error = new Error("This operation was aborted");
          error.name = "AbortError";
          reject(error);
        });
      });

    const result = await windowsExecutor.verifyHttpUrl("http://127.0.0.1:65530/health", 1, "health-url");

    assert.equal(result.ok, false);
    assert.equal(result.code, "probe_timeout");
    assert.equal(result.errorCode, "probe_timeout");
    assert.equal(result.error, "Health probe timed out");
  } finally {
    global.fetch = previousFetch;
  }
});

test("one rejected batch probe does not mark unrelated services as aborted", async () => {
  const definitions = [
    {
      serviceName: "slow-service",
      processName: "slow-service",
      localPort: 3101,
      healthUrl: "http://127.0.0.1:3101/health",
    },
    {
      serviceName: "healthy-service",
      processName: "healthy-service",
      localPort: 3102,
      healthUrl: "http://127.0.0.1:3102/health",
    },
  ];

  const snapshot = await windowsExecutor.getWindowsRuntimeSnapshot(definitions, {
    dependencies: {
      async getPm2ProcessStatuses() {
        return pm2Snapshot({
          "slow-service": "online",
          "healthy-service": "online",
        });
      },
      async getListeningPortsSnapshot() {
        return {
          ok: true,
          checkedAt: "2026-06-02T12:00:00.000Z",
          ports: {
            3101: { port: 3101, pid: 1000 },
            3102: { port: 3102, pid: 1000 },
          },
          error: null,
        };
      },
      async getRecentPm2ErrorHints() {
        return [];
      },
      async verifyHttpUrl(url) {
        if (url.includes("3101")) {
          const error = new Error("This operation was aborted");
          error.name = "AbortError";
          throw error;
        }

        return {
          method: "http",
          kind: "health-url",
          ok: true,
          status: 200,
          url,
          checkedAt: "2026-06-02T12:00:00.000Z",
        };
      },
      async checkLocalPort(port) {
        return {
          method: "tcp",
          ok: true,
          host: "127.0.0.1",
          port,
          checkedAt: "2026-06-02T12:00:00.000Z",
        };
      },
    },
  });

  assert.equal(snapshot.services["slow-service"].localHttp.errorCode, "probe_aborted");
  assert.equal(snapshot.services["slow-service"].localPort.ok, true);
  assert.equal(snapshot.services["slow-service"].pm2.pm2Status, "online");
  assert.equal(snapshot.services["healthy-service"].localHttp.ok, true);
  assert.equal(snapshot.services["healthy-service"].localHttp.errorCode, undefined);
});
