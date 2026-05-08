const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const http = require("node:http");

const commandLine = require("../src/lib/commandLine");
const commandLineRoutes = require("../src/routes/commandLine");

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

test("command-line implementation succeeds for local garage admin health", async () => {
  const result = await commandLine.runCommandAction("windows.garage-admin.health");

  assert.equal(result.ok, true);
  assert.equal(result.action.id, "windows.garage-admin.health");
  assert.equal(typeof result.startedAt, "string");
  assert.equal(typeof result.completedAt, "string");
});
