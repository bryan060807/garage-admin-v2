const assert = require("node:assert/strict");
const test = require("node:test");

const actionsRouter = require("../src/routes/actions");
const bridgeClient = require("../src/lib/bridgeClient");
const serviceDiscovery = require("../src/lib/serviceDiscovery");
const windowsExecutor = require("../src/lib/windowsExecutor");

async function withRestartMocks(services, callback) {
  const previousListUnifiedServices = serviceDiscovery.listUnifiedServices;
  const previousBridgeRestartService = bridgeClient.restartService;
  const previousWindowsRestartService = windowsExecutor.restartService;
  const calls = {
    bridge: [],
    windows: [],
  };

  serviceDiscovery.listUnifiedServices = async () => ({
    ok: true,
    items: services,
    sources: {},
  });
  bridgeClient.restartService = async (serviceName) => {
    calls.bridge.push(serviceName);
    return {
      ok: true,
      status: 200,
      data: {
        ok: true,
        serviceName,
      },
      executor: "fedora-bridge",
    };
  };
  windowsExecutor.restartService = async (serviceName) => {
    calls.windows.push(serviceName);
    return {
      ok: true,
      status: 200,
      data: {
        ok: true,
        serviceName,
      },
      executor: "windows-local",
    };
  };

  try {
    return await callback(calls);
  } finally {
    serviceDiscovery.listUnifiedServices = previousListUnifiedServices;
    bridgeClient.restartService = previousBridgeRestartService;
    windowsExecutor.restartService = previousWindowsRestartService;
  }
}

test("restart action blocks when current service capability is unsupported", async () => {
  await withRestartMocks(
    [
      {
        name: "admin-proxy",
        displayName: "Admin Proxy",
        host: "fedora",
        capabilities: {
          restart: {
            supported: false,
            reason: "Bridge did not advertise restart support.",
          },
        },
      },
    ],
    async (calls) => {
      const result = await actionsRouter.__testables.restartServiceForHost("admin-proxy", "fedora");

      assert.equal(result.ok, false);
      assert.equal(result.status, 409);
      assert.equal(result.data.code, "restart_unsupported");
      assert.match(result.error, /did not advertise/i);
      assert.deepEqual(calls.bridge, []);
      assert.deepEqual(calls.windows, []);
    },
  );
});

test("restart action uses Fedora bridge when current capability is supported", async () => {
  await withRestartMocks(
    [
      {
        name: "admin-proxy",
        displayName: "Admin Proxy",
        host: "fedora",
        capabilities: {
          restart: {
            supported: true,
            executor: "fedora-bridge",
            mode: "service-restart",
          },
        },
      },
    ],
    async (calls) => {
      const result = await actionsRouter.__testables.restartServiceForHost("admin-proxy", "fedora");

      assert.equal(result.ok, true);
      assert.equal(result.executor, "fedora-bridge");
      assert.deepEqual(calls.bridge, ["admin-proxy"]);
      assert.deepEqual(calls.windows, []);
    },
  );
});
