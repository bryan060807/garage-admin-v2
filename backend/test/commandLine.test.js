const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const http = require("node:http");

const config = require("../src/config");
const commandLine = require("../src/lib/commandLine");
const windowsBridgeClient = require("../src/lib/windowsBridgeClient");
const commandLineRoutes = require("../src/routes/commandLine");
const { getWorkerById, publicWorker } = require("../src/workerRegistry");

async function withConfig(overrides, callback) {
  const previous = new Map();

  Object.entries(overrides).forEach(([key, value]) => {
    previous.set(key, config[key]);
    config[key] = value;
  });

  try {
    return await callback();
  } finally {
    previous.forEach((value, key) => {
      config[key] = value;
    });
  }
}

async function withServer(router, callback) {
  const app = express();
  app.use(express.json());
  app.use("/api/command-line", router);

  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
}

test("command-line actions route returns available actions", async () => {
  const router = commandLineRoutes.createRouter({
    listCommandActions() {
      return [{ id: "windows.garage-admin.health", label: "Garage Admin V2 Health", available: true }];
    },
    getTerminalCapabilities() {
      return {
        ok: true,
        modes: {
          ssh: {
            available: false,
            reason: "SSH terminal is not configured on this host.",
          },
        },
      };
    },
    async runCommandAction() {
      throw new Error("not used");
    },
  });

  await withServer(router, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/command-line/actions`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(Array.isArray(payload.items), true);
    assert.equal(payload.items[0].id, "windows.garage-admin.health");
    assert.equal(Object.prototype.hasOwnProperty.call(payload.items[0], "handler"), false);
  });
});

test("command-line capabilities keep SSH disabled unless backend config enables a named profile", async () => {
  await withServer(commandLineRoutes.createRouter(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/command-line/capabilities`);
    const payload = await response.json();
    const serialized = JSON.stringify(payload);

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.modes.ssh.available, false);
    assert.equal(payload.modes.ssh.profiles[0].id, "fedora");
    assert.equal(serialized.includes("password"), false);
    assert.equal(serialized.includes("token"), false);
    assert.equal(serialized.includes("private"), false);
  });
});

test("command-line run succeeds for a safe read-only action", async () => {
  const router = commandLineRoutes.createRouter({
    listCommandActions() {
      return [];
    },
    async runCommandAction(actionId, params) {
      assert.equal(actionId, "windows.garage-admin.health");
      assert.deepEqual(params, {});
      return {
        ok: true,
        status: "completed",
        action: { id: actionId, label: "Garage Admin V2 Health" },
        startedAt: "2026-05-07T18:00:00.000Z",
        completedAt: "2026-05-07T18:00:01.000Z",
        durationMs: 1000,
        summary: "Garage Admin V2 backend is reporting healthy.",
        output: { ok: true },
        error: null,
      };
    },
  });

  await withServer(router, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/command-line/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        actionId: "windows.garage-admin.health",
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.status, "completed");
    assert.equal(payload.action.id, "windows.garage-admin.health");
  });
});

test("command-line route rejects unsupported command id", async () => {
  const router = commandLineRoutes.createRouter({
    listCommandActions() {
      return [];
    },
    async runCommandAction() {
      const error = new Error("Command action was not found.");
      error.statusCode = 404;
      error.code = "command_action_not_found";
      throw error;
    },
  });

  await withServer(router, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/command-line/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        actionId: "not-real",
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 404);
    assert.equal(payload.code, "command_action_not_found");
  });
});

test("command-line route rejects disabled action", async () => {
  const router = commandLineRoutes.createRouter({
    listCommandActions() {
      return [];
    },
    async runCommandAction() {
      const error = new Error("Command action is not supported in MVP.");
      error.statusCode = 409;
      error.code = "command_action_not_supported";
      throw error;
    },
  });

  await withServer(router, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/command-line/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        actionId: "fedora.control-plane.service-status",
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 409);
    assert.equal(payload.code, "command_action_not_supported");
  });
});

test("command-line route blocks state-changing action", async () => {
  const router = commandLineRoutes.createRouter({
    listCommandActions() {
      return [];
    },
    async runCommandAction() {
      const error = new Error("State-changing actions remain approval-gated and are not executable from this MVP.");
      error.statusCode = 403;
      error.code = "command_action_requires_approval";
      throw error;
    },
  });

  await withServer(router, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/command-line/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        actionId: "windows.runtime.restart-service",
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 403);
    assert.equal(payload.code, "command_action_requires_approval");
  });
});

test("command-line route requires action id", async () => {
  await withServer(commandLineRoutes.createRouter(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/command-line/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.equal(payload.code, "missing_action_id");
  });
});

test("command-line implementation rejects unknown action ids", async () => {
  await assert.rejects(() => commandLine.runCommandAction("not-real"), {
    code: "command_action_not_found",
    statusCode: 404,
  });
});

test("command-line implementation rejects disabled actions", async () => {
  await assert.rejects(() => commandLine.runCommandAction("fedora.control-plane.service-status"), {
    code: "command_action_not_supported",
    statusCode: 409,
  });
});

test("command-line implementation blocks restart actions as approval-gated", async () => {
  await assert.rejects(() => commandLine.runCommandAction("windows.runtime.restart-service"), {
    code: "command_action_requires_approval",
    statusCode: 403,
  });
});

test("command-line implementation validates allowlisted select params", async () => {
  const action = commandLine.getActionById("windows.runtime.service-status");

  assert.ok(action);
  assert.throws(() => commandLine.validateParams(action, { serviceName: "not-allowlisted" }), {
    code: "invalid_param_option",
    statusCode: 400,
  });
});

test("command-line implementation exposes Fedora observability actions as backend-only read-only actions", async () => {
  const previousUrl = process.env.FEDORA_GARAGE_API_URL;
  const previousKey = process.env.FEDORA_GARAGE_API_KEY;

  try {
    process.env.FEDORA_GARAGE_API_URL = "http://127.0.0.1:5100";
    process.env.FEDORA_GARAGE_API_KEY = "test-token";

    const actionIds = commandLine.listCommandActions().map((action) => action.id);
    assert.ok(actionIds.includes("fedora.observability.listeners"));
    assert.ok(actionIds.includes("fedora.observability.systemd-units"));
    assert.ok(actionIds.includes("fedora.observability.systemd-timers"));
    assert.ok(actionIds.includes("fedora.observability.podman-inspect"));
    assert.ok(actionIds.includes("fedora.observability.backup-artifacts"));

    const podmanAction = commandLine.getActionById("fedora.observability.podman-inspect");
    assert.ok(podmanAction);
    assert.notEqual(podmanAction.approvalRequired, true);
    assert.equal(podmanAction.riskLabel, "Read-only");
    assert.deepEqual(
      podmanAction.params[0].options.map((option) => option.value),
      ["taskmaster-db", "pgadmin"],
    );
  } finally {
    if (previousUrl == null) {
      delete process.env.FEDORA_GARAGE_API_URL;
    } else {
      process.env.FEDORA_GARAGE_API_URL = previousUrl;
    }

    if (previousKey == null) {
      delete process.env.FEDORA_GARAGE_API_KEY;
    } else {
      process.env.FEDORA_GARAGE_API_KEY = previousKey;
    }
  }
});

test("command-line implementation rejects non-allowlisted Fedora Podman container names", async () => {
  const action = commandLine.getActionById("fedora.observability.podman-inspect");

  assert.ok(action);
  assert.throws(() => commandLine.validateParams(action, { containerName: "not-allowlisted" }), {
    code: "invalid_param_option",
    statusCode: 400,
  });
});

test("worker registry routes Fedora observability worker through the same helper transport as successful Fedora workers", async () => {
  const previousGarageUrl = process.env.FEDORA_GARAGE_API_URL;
  const previousGarageKey = process.env.FEDORA_GARAGE_API_KEY;
  const previousAdminUrl = process.env.FEDORA_ADMIN_PROXY_URL;
  const previousAdminToken = process.env.ADMIN_BRIDGE_TOKEN;

  try {
    process.env.FEDORA_GARAGE_API_URL = "http://192.168.1.187:5000";
    process.env.FEDORA_GARAGE_API_KEY = "helper-token";
    process.env.FEDORA_ADMIN_PROXY_URL = "http://127.0.0.1:4000";
    process.env.ADMIN_BRIDGE_TOKEN = "admin-token";

    const worker = getWorkerById(commandLine.FEDORA_OBSERVABILITY_WORKER_ID);
    const repoWorker = getWorkerById("fedora-repo");
    const infraWorker = getWorkerById("fedora-infra");

    assert.equal(worker.transport, "fedora-garage-helper");
    assert.equal(worker.baseUrl, "http://192.168.1.187:5000");
    assert.equal(worker.authHeader, "X-API-KEY");
    assert.equal(worker.authTokenEnv, "FEDORA_GARAGE_API_KEY");

    assert.equal(repoWorker.transport, "fedora-garage-helper");
    assert.equal(repoWorker.baseUrl, "http://192.168.1.187:5000");
    assert.equal(infraWorker.transport, "fedora-garage-helper");
    assert.equal(infraWorker.baseUrl, "http://192.168.1.187:5000");
    assert.equal(worker.transport, repoWorker.transport);
    assert.equal(worker.baseUrl, repoWorker.baseUrl);
    assert.equal(worker.authHeader, repoWorker.authHeader);
    assert.equal(worker.authTokenEnv, repoWorker.authTokenEnv);
  } finally {
    if (previousGarageUrl == null) {
      delete process.env.FEDORA_GARAGE_API_URL;
    } else {
      process.env.FEDORA_GARAGE_API_URL = previousGarageUrl;
    }

    if (previousGarageKey == null) {
      delete process.env.FEDORA_GARAGE_API_KEY;
    } else {
      process.env.FEDORA_GARAGE_API_KEY = previousGarageKey;
    }

    if (previousAdminUrl == null) {
      delete process.env.FEDORA_ADMIN_PROXY_URL;
    } else {
      process.env.FEDORA_ADMIN_PROXY_URL = previousAdminUrl;
    }

    if (previousAdminToken == null) {
      delete process.env.ADMIN_BRIDGE_TOKEN;
    } else {
      process.env.ADMIN_BRIDGE_TOKEN = previousAdminToken;
    }
  }
});

test("worker public metadata keeps Fedora worker credentials backend-only", async () => {
  const previousGarageUrl = process.env.FEDORA_GARAGE_API_URL;
  const previousGarageKey = process.env.FEDORA_GARAGE_API_KEY;

  try {
    process.env.FEDORA_GARAGE_API_URL = "http://192.168.1.187:5000";
    process.env.FEDORA_GARAGE_API_KEY = "helper-token";

    const worker = getWorkerById(commandLine.FEDORA_OBSERVABILITY_WORKER_ID);
    const metadata = publicWorker(worker);
    const serialized = JSON.stringify(metadata);

    assert.equal(metadata.authConfigured, true);
    assert.equal(Object.prototype.hasOwnProperty.call(metadata, "authHeader"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(metadata, "authTokenEnv"), false);
    assert.equal(serialized.includes("helper-token"), false);
    assert.equal(serialized.includes("FEDORA_GARAGE_API_KEY"), false);
    assert.equal(serialized.includes("X-API-KEY"), false);
  } finally {
    if (previousGarageUrl == null) {
      delete process.env.FEDORA_GARAGE_API_URL;
    } else {
      process.env.FEDORA_GARAGE_API_URL = previousGarageUrl;
    }

    if (previousGarageKey == null) {
      delete process.env.FEDORA_GARAGE_API_KEY;
    } else {
      process.env.FEDORA_GARAGE_API_KEY = previousGarageKey;
    }
  }
});

test("command-line implementation runs Fedora observability through fixed worker task names", async () => {
  const previousFetch = global.fetch;
  const previousGarageUrl = process.env.FEDORA_GARAGE_API_URL;
  const previousGarageKey = process.env.FEDORA_GARAGE_API_KEY;
  const previousAdminUrl = process.env.FEDORA_ADMIN_PROXY_URL;
  const previousAdminToken = process.env.ADMIN_BRIDGE_TOKEN;
  const calls = [];
  const scenarios = [
    ["fedora.observability.listeners", "ss_listeners", {}],
    ["fedora.observability.systemd-units", "systemd_list_units", {}],
    ["fedora.observability.systemd-timers", "systemd_timers_safe", {}],
    ["fedora.observability.podman-inspect", "podman_inspect_safe", { containerName: "taskmaster-db" }],
    ["fedora.observability.podman-inspect", "podman_inspect_safe", { containerName: "pgadmin" }],
    ["fedora.observability.backup-artifacts", "backup_artifacts_safe", {}],
  ];

  try {
    process.env.FEDORA_GARAGE_API_URL = "http://192.168.1.187:5000";
    process.env.FEDORA_GARAGE_API_KEY = "helper-token";
    process.env.FEDORA_ADMIN_PROXY_URL = "http://127.0.0.1:4000";
    process.env.ADMIN_BRIDGE_TOKEN = "admin-token";

    global.fetch = async (url, options = {}) => {
      const body = JSON.parse(options.body);
      calls.push({ url: String(url), headers: options.headers, body });

      return {
        status: 200,
        async json() {
          return {
            ok: true,
            result: {
              items: [
                {
                  localAddress: "127.0.0.1",
                  localPort: 3010,
                  process: "garage-admin-v2",
                },
              ],
            },
          };
        },
      };
    };

    for (const [actionId, taskType, params] of scenarios) {
      const result = await commandLine.runCommandAction(actionId, params);
      assert.equal(result.ok, true);
      assert.equal(result.action.id, actionId);
      assert.equal(result.output.result.workerId, commandLine.FEDORA_OBSERVABILITY_WORKER_ID);
      assert.equal(result.output.result.taskType, taskType);
    }

    assert.equal(calls.length, scenarios.length);
    scenarios.forEach(([, taskType, params], index) => {
      assert.match(calls[index].url, /^http:\/\/192\.168\.1\.187:5000\/admin\/fedora-workers\/aibry-fedora-worker-agent\/jobs$/);
      assert.equal(calls[index].headers["X-API-KEY"], "helper-token");
      assert.equal(calls[index].headers["x-aibry-auth"], undefined);
      assert.equal(calls[index].body.taskType, taskType);
      assert.equal(calls[index].body.targetHost, "fedora");
      assert.deepEqual(calls[index].body.input, params);
    });
  } finally {
    global.fetch = previousFetch;

    if (previousGarageUrl == null) {
      delete process.env.FEDORA_GARAGE_API_URL;
    } else {
      process.env.FEDORA_GARAGE_API_URL = previousGarageUrl;
    }

    if (previousGarageKey == null) {
      delete process.env.FEDORA_GARAGE_API_KEY;
    } else {
      process.env.FEDORA_GARAGE_API_KEY = previousGarageKey;
    }

    if (previousAdminUrl == null) {
      delete process.env.FEDORA_ADMIN_PROXY_URL;
    } else {
      process.env.FEDORA_ADMIN_PROXY_URL = previousAdminUrl;
    }

    if (previousAdminToken == null) {
      delete process.env.ADMIN_BRIDGE_TOKEN;
    } else {
      process.env.ADMIN_BRIDGE_TOKEN = previousAdminToken;
    }
  }
});

test("command-line implementation rejects direct Fedora-local admin-proxy worker URL from Windows", async () => {
  const previousFetch = global.fetch;
  const previousGarageUrl = process.env.FEDORA_GARAGE_API_URL;
  const previousGarageKey = process.env.FEDORA_GARAGE_API_KEY;
  const previousAdminUrl = process.env.FEDORA_ADMIN_PROXY_URL;
  const previousAdminToken = process.env.ADMIN_BRIDGE_TOKEN;
  const calls = [];

  try {
    delete process.env.FEDORA_GARAGE_API_URL;
    delete process.env.FEDORA_GARAGE_API_KEY;
    process.env.FEDORA_ADMIN_PROXY_URL = "http://127.0.0.1:4000";
    process.env.ADMIN_BRIDGE_TOKEN = "admin-token";

    global.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), headers: options.headers, body: JSON.parse(options.body) });
      return { status: 200, async json() { return { ok: true, items: [] }; } };
    };

    await assert.rejects(() => commandLine.runCommandAction("fedora.observability.listeners"), {
      code: "fedora_admin_proxy_local_only",
      statusCode: 503,
    });

    assert.equal(calls.length, 0);
  } finally {
    global.fetch = previousFetch;

    if (previousGarageUrl == null) {
      delete process.env.FEDORA_GARAGE_API_URL;
    } else {
      process.env.FEDORA_GARAGE_API_URL = previousGarageUrl;
    }

    if (previousGarageKey == null) {
      delete process.env.FEDORA_GARAGE_API_KEY;
    } else {
      process.env.FEDORA_GARAGE_API_KEY = previousGarageKey;
    }

    if (previousAdminUrl == null) {
      delete process.env.FEDORA_ADMIN_PROXY_URL;
    } else {
      process.env.FEDORA_ADMIN_PROXY_URL = previousAdminUrl;
    }

    if (previousAdminToken == null) {
      delete process.env.ADMIN_BRIDGE_TOKEN;
    } else {
      process.env.ADMIN_BRIDGE_TOKEN = previousAdminToken;
    }
  }
});

test("command-line implementation rejects LAN Fedora admin-proxy port 4000 from Windows", async () => {
  const previousGarageUrl = process.env.FEDORA_GARAGE_API_URL;
  const previousGarageKey = process.env.FEDORA_GARAGE_API_KEY;
  const previousAdminUrl = process.env.FEDORA_ADMIN_PROXY_URL;
  const previousAdminToken = process.env.ADMIN_BRIDGE_TOKEN;

  try {
    delete process.env.FEDORA_GARAGE_API_URL;
    delete process.env.FEDORA_GARAGE_API_KEY;
    process.env.FEDORA_ADMIN_PROXY_URL = "http://192.168.1.187:4000";
    process.env.ADMIN_BRIDGE_TOKEN = "admin-token";

    await assert.rejects(() => commandLine.runCommandAction("fedora.observability.listeners"), {
      code: "fedora_admin_proxy_local_only",
      statusCode: 503,
    });
  } finally {
    if (previousGarageUrl == null) {
      delete process.env.FEDORA_GARAGE_API_URL;
    } else {
      process.env.FEDORA_GARAGE_API_URL = previousGarageUrl;
    }

    if (previousGarageKey == null) {
      delete process.env.FEDORA_GARAGE_API_KEY;
    } else {
      process.env.FEDORA_GARAGE_API_KEY = previousGarageKey;
    }

    if (previousAdminUrl == null) {
      delete process.env.FEDORA_ADMIN_PROXY_URL;
    } else {
      process.env.FEDORA_ADMIN_PROXY_URL = previousAdminUrl;
    }

    if (previousAdminToken == null) {
      delete process.env.ADMIN_BRIDGE_TOKEN;
    } else {
      process.env.ADMIN_BRIDGE_TOKEN = previousAdminToken;
    }
  }
});

test("command-line implementation normalizes object-shaped worker 404 summaries", async () => {
  const previousFetch = global.fetch;
  const previousGarageUrl = process.env.FEDORA_GARAGE_API_URL;
  const previousGarageKey = process.env.FEDORA_GARAGE_API_KEY;
  const previousAdminUrl = process.env.FEDORA_ADMIN_PROXY_URL;
  const previousAdminToken = process.env.ADMIN_BRIDGE_TOKEN;

  try {
    process.env.FEDORA_GARAGE_API_URL = "http://192.168.1.187:5000";
    process.env.FEDORA_GARAGE_API_KEY = "helper-token";
    process.env.FEDORA_ADMIN_PROXY_URL = "http://127.0.0.1:4000";
    process.env.ADMIN_BRIDGE_TOKEN = "admin-token";

    global.fetch = async () => ({
      status: 404,
      async json() {
        return {
          ok: false,
          errorCode: "worker_http_404",
          summary: {
            route: "/admin/fedora-workers/aibry-fedora-worker-agent/jobs",
            status: 404,
          },
          error: {
            message: "Route not found.",
            status: 404,
          },
        };
      },
    });

    const result = await commandLine.runCommandAction("fedora.observability.listeners");
    const serialized = JSON.stringify(result);

    assert.equal(result.ok, false);
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "worker_http_404");
    assert.match(result.summary, /aibry-fedora-worker-agent/);
    assert.match(result.error.message, /Route not found/);
    assert.equal(result.summary.includes("[object Object]"), false);
    assert.equal(result.error.message.includes("[object Object]"), false);
    assert.equal(serialized.includes("[object Object]"), false);
  } finally {
    global.fetch = previousFetch;

    if (previousGarageUrl == null) {
      delete process.env.FEDORA_GARAGE_API_URL;
    } else {
      process.env.FEDORA_GARAGE_API_URL = previousGarageUrl;
    }

    if (previousGarageKey == null) {
      delete process.env.FEDORA_GARAGE_API_KEY;
    } else {
      process.env.FEDORA_GARAGE_API_KEY = previousGarageKey;
    }

    if (previousAdminUrl == null) {
      delete process.env.FEDORA_ADMIN_PROXY_URL;
    } else {
      process.env.FEDORA_ADMIN_PROXY_URL = previousAdminUrl;
    }

    if (previousAdminToken == null) {
      delete process.env.ADMIN_BRIDGE_TOKEN;
    } else {
      process.env.ADMIN_BRIDGE_TOKEN = previousAdminToken;
    }
  }
});

test("command-line implementation returns structured failed result on worker timeout", async () => {
  const previousFetch = global.fetch;
  const previousGarageUrl = process.env.FEDORA_GARAGE_API_URL;
  const previousGarageKey = process.env.FEDORA_GARAGE_API_KEY;
  const previousAdminUrl = process.env.FEDORA_ADMIN_PROXY_URL;
  const previousAdminToken = process.env.ADMIN_BRIDGE_TOKEN;

  try {
    process.env.FEDORA_GARAGE_API_URL = "http://192.168.1.187:5000";
    process.env.FEDORA_GARAGE_API_KEY = "helper-token";
    process.env.FEDORA_ADMIN_PROXY_URL = "http://127.0.0.1:4000";
    process.env.ADMIN_BRIDGE_TOKEN = "admin-token";

    global.fetch = async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    };

    const result = await commandLine.runCommandAction("fedora.observability.listeners");

    assert.equal(result.ok, false);
    assert.equal(result.status, "failed");
    assert.equal(result.exitStatus, "failed");
    assert.equal(result.error.code, "worker_timeout");
    assert.equal(result.output.result.ok, false);
    assert.equal(result.output.result.status, "failed");
    assert.equal(result.output.result.errorCode, "worker_timeout");
    assert.equal(result.output.result.workerId, commandLine.FEDORA_OBSERVABILITY_WORKER_ID);
    assert.equal(result.output.result.taskType, "ss_listeners");
    assert.equal(typeof result.output.result.durationMs, "number");
  } finally {
    global.fetch = previousFetch;

    if (previousGarageUrl == null) {
      delete process.env.FEDORA_GARAGE_API_URL;
    } else {
      process.env.FEDORA_GARAGE_API_URL = previousGarageUrl;
    }

    if (previousGarageKey == null) {
      delete process.env.FEDORA_GARAGE_API_KEY;
    } else {
      process.env.FEDORA_GARAGE_API_KEY = previousGarageKey;
    }

    if (previousAdminUrl == null) {
      delete process.env.FEDORA_ADMIN_PROXY_URL;
    } else {
      process.env.FEDORA_ADMIN_PROXY_URL = previousAdminUrl;
    }

    if (previousAdminToken == null) {
      delete process.env.ADMIN_BRIDGE_TOKEN;
    } else {
      process.env.ADMIN_BRIDGE_TOKEN = previousAdminToken;
    }
  }
});

test("command-line implementation succeeds for local garage admin health", async () => {
  const result = await commandLine.runCommandAction("windows.garage-admin.health");

  assert.equal(result.ok, true);
  assert.equal(result.action.id, "windows.garage-admin.health");
  assert.equal(typeof result.startedAt, "string");
  assert.equal(typeof result.completedAt, "string");
});

test("command-line memory self-check returns only sanitized summary output", async () => {
  const previous = windowsBridgeClient.getWindowsGarageMemorySelfCheck;

  try {
    windowsBridgeClient.getWindowsGarageMemorySelfCheck = async () => ({
      ok: true,
      source: "windows-garage",
      checkedAt: "2026-05-07T16:00:03.000Z",
      latencyMs: 11,
      httpStatus: 200,
      request: {
        pathname: "/memory/self-check",
      },
      data: {
        ok: true,
        service: "windows-garage-api",
        checkedAt: "2026-05-07T16:00:04.000Z",
        activeMemory: {
          status: "ok",
          rootPath: "C:\\Users\\bryan\\secret-memory",
          items: [{ path: "C:\\Users\\bryan\\secret-memory\\00_START_HERE.md", label: "startup" }],
        },
        safety: {
          exposedSecrets: false,
          path: "C:\\Users\\bryan\\secret-memory",
        },
        summary: "Healthy at C:\\Users\\bryan\\secret-memory",
        contents: ["do not expose"],
        token: "garage-token",
      },
      error: null,
    });

    await withConfig(
      {
        windowsGarageBaseUrl: "http://127.0.0.1:5100",
        windowsGarageApiKey: "garage-token",
      },
      async () => {
        const result = await commandLine.runCommandAction("windows.runtime.memory-self-check");
        const serialized = JSON.stringify(result);

        assert.equal(result.ok, true);
        assert.equal(result.action.id, "windows.runtime.memory-self-check");
        assert.equal(result.output.ok, true);
        assert.equal(result.output.service, "windows-garage-api");
        assert.equal(result.output.activeMemory.status, "ok");
        assert.deepEqual(result.output.activeMemory.items, [{ label: "startup" }]);
        assert.equal(result.output.safety.exposedSecrets, false);
        assert.match(result.output.summary, /Healthy at <redacted-path>/);
        assert.equal(serialized.includes("secret-memory"), false);
        assert.equal(serialized.includes("garage-token"), false);
        assert.equal(serialized.includes("do not expose"), false);
        assert.equal(serialized.includes("contents"), false);
        assert.equal(serialized.includes("rootPath"), false);
      },
    );
  } finally {
    windowsBridgeClient.getWindowsGarageMemorySelfCheck = previous;
  }
});
