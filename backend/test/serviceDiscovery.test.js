const assert = require("node:assert/strict");
const test = require("node:test");

const bridgeClient = require("../src/lib/bridgeClient");
const repository = require("../src/lib/repository");
const serviceDiscovery = require("../src/lib/serviceDiscovery");
const windowsExecutor = require("../src/lib/windowsExecutor");

async function withServiceDiscoveryMocks(windowsSnapshot, callback, options = {}) {
  const previousDiscoverServices = bridgeClient.discoverServices;
  const previousListServiceFacts = repository.listServiceFacts;
  const previousListIncidents = repository.listIncidents;
  const previousUpsertServiceFact = repository.upsertServiceFact;
  const previousGetWindowsRuntimeSnapshot = windowsExecutor.getWindowsRuntimeSnapshot;

  bridgeClient.discoverServices = async () =>
    options.bridgeResult || {
      ok: false,
      items: [],
      discoveryPath: "/admin/services",
      error: "Bridge discovery unavailable in test.",
    };
  repository.listServiceFacts = async () => [];
  repository.listIncidents = async () => [];
  repository.upsertServiceFact = async () => ({});
  windowsExecutor.getWindowsRuntimeSnapshot = async () => windowsSnapshot;

  try {
    return await callback();
  } finally {
    bridgeClient.discoverServices = previousDiscoverServices;
    repository.listServiceFacts = previousListServiceFacts;
    repository.listIncidents = previousListIncidents;
    repository.upsertServiceFact = previousUpsertServiceFact;
    windowsExecutor.getWindowsRuntimeSnapshot = previousGetWindowsRuntimeSnapshot;
  }
}

function healthyPm2(processName, pid = 1000) {
  return {
    processName,
    status: "online",
    pm2Status: "online",
    uptimeSeconds: 120,
    restarts: 1,
    pid,
    checkedAt: "2026-06-02T12:00:00.000Z",
  };
}

test("PM2 online plus listening port plus HTTP timeout is degraded, not failed", async () => {
  await withServiceDiscoveryMocks(
    {
      ok: true,
      checkedAt: "2026-06-02T12:00:00.000Z",
      pm2: {
        ok: true,
        checkedAt: "2026-06-02T12:00:00.000Z",
        statuses: {
          "garage-admin-v2": healthyPm2("garage-admin-v2", 3010),
        },
      },
      services: {
        "garage-admin-v2": {
          localHttp: {
            method: "http",
            kind: "health-url",
            ok: false,
            url: "http://127.0.0.1:3010/health",
            checkedAt: "2026-06-02T12:00:00.000Z",
            code: "probe_timeout",
            errorCode: "probe_timeout",
            error: "Health probe timed out",
          },
          localPort: {
            method: "tcp",
            ok: true,
            host: "127.0.0.1",
            port: 3010,
            checkedAt: "2026-06-02T12:00:00.000Z",
            ownerPid: 3010,
            ownerMatchesPm2Pid: true,
          },
          pm2: {
            status: "healthy",
            pm2Status: "online",
            warnings: [],
            pid: 3010,
          },
        },
      },
      error: null,
    },
    async () => {
      const result = await serviceDiscovery.listUnifiedServices();
      const service = result.items.find((item) => item.name === "garage-admin-v2");

      assert.ok(service);
      assert.equal(service.status, "degraded");
      assert.equal(service.classification.severity, "warning");
      assert.equal(service.health.checks.localHttp.errorCode, "probe_timeout");
      assert.match(service.warnings.join(" "), /timed out/i);
    },
  );
});

test("healthy direct service checks remain healthy in service discovery", async () => {
  await withServiceDiscoveryMocks(
    {
      ok: true,
      checkedAt: "2026-06-02T12:00:00.000Z",
      pm2: {
        ok: true,
        checkedAt: "2026-06-02T12:00:00.000Z",
        statuses: {
          "garage-admin-v2": healthyPm2("garage-admin-v2", 3010),
        },
      },
      services: {
        "garage-admin-v2": {
          localHttp: {
            method: "http",
            kind: "health-url",
            ok: true,
            status: 200,
            url: "http://127.0.0.1:3010/health",
            checkedAt: "2026-06-02T12:00:00.000Z",
          },
          localPort: {
            method: "tcp",
            ok: true,
            host: "127.0.0.1",
            port: 3010,
            checkedAt: "2026-06-02T12:00:00.000Z",
            ownerPid: 3010,
            ownerMatchesPm2Pid: true,
          },
          pm2: {
            status: "healthy",
            pm2Status: "online",
            warnings: [],
            pid: 3010,
          },
        },
      },
      error: null,
    },
    async () => {
      const result = await serviceDiscovery.listUnifiedServices();
      const service = result.items.find((item) => item.name === "garage-admin-v2");

      assert.ok(service);
      assert.equal(service.health.status, "healthy");
      assert.equal(service.health.checks.localHttp.ok, true);
      assert.equal(service.classification.severity, "running");
    },
  );
});

test("bridge restart.supported=true enables infrastructure restart capability", async () => {
  await withServiceDiscoveryMocks(
    {
      ok: true,
      checkedAt: "2026-06-02T12:00:00.000Z",
      pm2: {
        ok: true,
        checkedAt: "2026-06-02T12:00:00.000Z",
        statuses: {},
      },
      services: {},
      error: null,
    },
    async () => {
      const result = await serviceDiscovery.listUnifiedServices();
      const service = result.items.find((item) => item.name === "admin-proxy");

      assert.ok(service);
      assert.equal(service.host, "fedora");
      assert.equal(service.supports.restart, true);
      assert.equal(service.capabilities.restart.supported, true);
      assert.equal(service.capabilities.restart.executor, "fedora-bridge");
    },
    {
      bridgeResult: {
        ok: true,
        discoveryPath: "/admin/services",
        data: {
          services: [
            {
              name: "admin-proxy",
              displayName: "Admin Proxy",
              host: "fedora",
              status: "running",
              restart: {
                supported: true,
              },
            },
          ],
        },
      },
    },
  );
});

test("bridge restart.supported=false keeps infrastructure restart blocked", async () => {
  await withServiceDiscoveryMocks(
    {
      ok: true,
      checkedAt: "2026-06-02T12:00:00.000Z",
      pm2: {
        ok: true,
        checkedAt: "2026-06-02T12:00:00.000Z",
        statuses: {},
      },
      services: {},
      error: null,
    },
    async () => {
      const result = await serviceDiscovery.listUnifiedServices();
      const service = result.items.find((item) => item.name === "node-agent");

      assert.ok(service);
      assert.equal(service.host, "fedora");
      assert.equal(service.supports.restart, false);
      assert.equal(service.capabilities.restart.supported, false);
      assert.match(service.capabilities.restart.reason, /maintenance window/i);
    },
    {
      bridgeResult: {
        ok: true,
        discoveryPath: "/admin/services",
        data: {
          services: [
            {
              name: "node-agent",
              displayName: "Node Agent",
              host: "fedora",
              status: "running",
              restart: {
                supported: false,
                reason: "Restart requires a maintenance window.",
              },
            },
          ],
        },
      },
    },
  );
});
