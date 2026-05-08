const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const http = require("node:http");

const config = require("../src/config");
const windowsBridgeClient = require("../src/lib/windowsBridgeClient");
const windowsBridgeRoutes = require("../src/routes/windowsBridge");

function createJsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    async text() {
      return JSON.stringify(body);
    },
  };
}

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

async function withMockFetch(handler, callback) {
  const previousFetch = global.fetch;
  global.fetch = handler;

  try {
    return await callback();
  } finally {
    global.fetch = previousFetch;
  }
}

async function withServer(router, callback) {
  const app = express();
  app.use("/api/windows-bridge", router);

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

test("windows garage health uses WINDOWS_GARAGE_BASE_URL instead of WINDOWS_ADMIN_BASE_URL", async () => {
  await withConfig(
    {
      windowsAdminBaseUrl: "http://127.0.0.1:3105",
      windowsAdminAuthToken: "admin-token",
      windowsGarageBaseUrl: "http://127.0.0.1:5100",
      windowsGarageApiKey: "garage-token",
      windowsBridgeTimeoutMs: 50,
    },
    async () => {
      const calls = [];

      await withMockFetch(
        async (url, options = {}) => {
          calls.push({
            url,
            headers: options.headers || {},
          });
          return createJsonResponse({ ok: true, service: "windows-garage-api" });
        },
        async () => {
          const result = await windowsBridgeClient.getWindowsGarageHealth();
          assert.equal(result.ok, true);
        },
      );

      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "http://127.0.0.1:5100/admin/health");
      assert.equal(calls[0].headers["X-API-KEY"], "garage-token");
      assert.equal(calls[0].headers["x-aibry-auth"], undefined);
    },
  );
});

test("windows admin health uses WINDOWS_ADMIN_BASE_URL", async () => {
  await withConfig(
    {
      windowsAdminBaseUrl: "http://127.0.0.1:3105",
      windowsAdminAuthToken: "admin-token",
      windowsGarageBaseUrl: "http://127.0.0.1:5100",
      windowsGarageApiKey: "garage-token",
      windowsBridgeTimeoutMs: 50,
    },
    async () => {
      const calls = [];

      await withMockFetch(
        async (url, options = {}) => {
          calls.push({
            url,
            headers: options.headers || {},
          });
          return createJsonResponse({ ok: true, service: "windows-aibry-admin" });
        },
        async () => {
          const result = await windowsBridgeClient.getWindowsAdminHealth();
          assert.equal(result.ok, true);
        },
      );

      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "http://127.0.0.1:3105/admin/health");
      assert.equal(calls[0].headers["x-aibry-auth"], "admin-token");
      assert.equal(calls[0].headers["X-API-KEY"], undefined);
    },
  );
});

test("windows garage memory self-check uses WINDOWS_GARAGE_BASE_URL and X-API-KEY", async () => {
  await withConfig(
    {
      windowsAdminBaseUrl: "http://127.0.0.1:3105",
      windowsAdminAuthToken: "admin-token",
      windowsGarageBaseUrl: "http://127.0.0.1:5100",
      windowsGarageApiKey: "garage-token",
      windowsBridgeTimeoutMs: 50,
    },
    async () => {
      const calls = [];

      await withMockFetch(
        async (url, options = {}) => {
          calls.push({
            url,
            headers: options.headers || {},
          });
          return createJsonResponse({
            ok: true,
            service: "windows-garage-api",
            activeMemory: { status: "ok", fileCount: 4 },
            safety: { exposedSecrets: false },
          });
        },
        async () => {
          const result = await windowsBridgeClient.getWindowsGarageMemorySelfCheck();
          assert.equal(result.ok, true);
        },
      );

      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "http://127.0.0.1:5100/memory/self-check");
      assert.equal(calls[0].headers["X-API-KEY"], "garage-token");
      assert.equal(calls[0].headers["x-aibry-auth"], undefined);
    },
  );
});

test("health route includes provenance metadata and preserves compatibility fields", async () => {
  const stubClient = {
    WINDOWS_ADMIN_SOURCE: "windows-admin",
    WINDOWS_GARAGE_SOURCE: "windows-garage",
    async getWindowsAdminHealth() {
      return {
        ok: true,
        source: "windows-admin",
        checkedAt: "2026-05-07T16:00:00.000Z",
        latencyMs: 12,
        httpStatus: 200,
        request: {
          pathname: "/admin/health",
          configuredTarget: {
            protocol: "http",
            host: "127.0.0.1",
            port: "3105",
            basePath: "/",
            requestPath: "/admin/health",
            display: "127.0.0.1:3105/admin/health",
          },
        },
        data: {
          ok: true,
          service: "windows-aibry-admin",
          bind: "127.0.0.1:3105",
          host: "windows",
        },
        error: null,
      };
    },
    async getWindowsGaragePulse() {
      return {
        ok: true,
        source: "windows-garage",
        checkedAt: "2026-05-07T16:00:01.000Z",
        latencyMs: 15,
        httpStatus: 200,
        request: {
          pathname: "/pulse",
          configuredTarget: {
            protocol: "http",
            host: "127.0.0.1",
            port: "5100",
            basePath: "/",
            requestPath: "/pulse",
            display: "127.0.0.1:5100/pulse",
          },
        },
        data: {
          ok: true,
          service: "windows-garage-api",
          bind: "127.0.0.1:5100",
          host: "windows",
        },
        error: null,
      };
    },
    async getWindowsGarageHealth() {
      return {
        ok: true,
        source: "windows-garage",
        checkedAt: "2026-05-07T16:00:02.000Z",
        latencyMs: 18,
        httpStatus: 200,
        request: {
          pathname: "/admin/health",
          configuredTarget: {
            protocol: "http",
            host: "127.0.0.1",
            port: "5100",
            basePath: "/",
            requestPath: "/admin/health",
            display: "127.0.0.1:5100/admin/health",
          },
        },
        data: {
          ok: true,
          service: "windows-garage-api",
          bind: "127.0.0.1:5100",
          host: "windows",
        },
        error: null,
      };
    },
    async getWindowsServiceStatus() {
      throw new Error("not used");
    },
    async getWindowsRepos() {
      throw new Error("not used");
    },
  };

  await withServer(windowsBridgeRoutes.createRouter(stubClient), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/windows-bridge/health`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.partial, false);
    assert.ok(payload.sources.windowsGarageHealth);
    assert.equal(payload.sources.windowsGarageHealth.kind, "admin-health");
    assert.equal(payload.sources.windowsGarageHealth.source, "windows-garage");
    assert.equal(payload.sources.windowsGarageHealth.status, "ok");
    assert.deepEqual(payload.sources.windowsGarageHealth.data.service, "windows-garage-api");
    assert.equal(payload.sources.windowsGarageHealth.logicalCheck, "windowsGarageHealth");
    assert.equal(payload.sources.windowsGarageHealth.configuredTarget.host, "127.0.0.1");
    assert.equal(payload.sources.windowsGarageHealth.configuredTarget.port, "5100");
    assert.equal(payload.sources.windowsGarageHealth.expectedIdentity.service, "windows-garage-api");
    assert.equal(payload.sources.windowsGarageHealth.observedIdentity.service, "windows-garage-api");
    assert.equal(payload.sources.windowsGarageHealth.identityMatchesExpected, true);
    assert.equal(payload.sources.windowsGarageHealth.drift.detected, false);
  });
});

test("memory self-check route forwards only the safe summary payload", async () => {
  const stubClient = {
    WINDOWS_ADMIN_SOURCE: "windows-admin",
    WINDOWS_GARAGE_SOURCE: "windows-garage",
    async getWindowsAdminHealth() {
      throw new Error("not used");
    },
    async getWindowsGaragePulse() {
      throw new Error("not used");
    },
    async getWindowsGarageHealth() {
      throw new Error("not used");
    },
    async getWindowsGarageMemorySelfCheck() {
      return {
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
            fileCount: 3,
            rootPath: "C:\\Users\\bryan\\secret-memory",
            items: [{ label: "active" }],
          },
          safety: {
            exposedSecrets: false,
            path: "C:\\Users\\bryan\\secret-memory",
            warnings: [],
          },
          summary: "Healthy at C:\\Users\\bryan\\secret-memory",
          contents: ["do not expose"],
        },
        error: null,
      };
    },
    async getWindowsServiceStatus() {
      throw new Error("not used");
    },
    async getWindowsRepos() {
      throw new Error("not used");
    },
  };

  await withServer(windowsBridgeRoutes.createRouter(stubClient), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/windows-bridge/memory/self-check`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.service, "windows-garage-api");
    assert.deepEqual(payload.activeMemory, {
      status: "ok",
      fileCount: 3,
      items: [{ label: "active" }],
    });
    assert.deepEqual(payload.safety, {
      exposedSecrets: false,
      warnings: [],
    });
    assert.equal(payload.checkedAt, "2026-05-07T16:00:04.000Z");
    assert.match(payload.summary, /Healthy at <redacted-path>/);
    assert.equal(JSON.stringify(payload).includes("garage-token"), false);
    assert.equal(JSON.stringify(payload).includes("secret-memory"), false);
    assert.equal("contents" in payload, false);
  });
});

test("memory self-check route returns safe structured error when config is missing", async () => {
  await withConfig(
    {
      windowsGarageBaseUrl: "",
      windowsGarageApiKey: "",
    },
    async () => {
      await withServer(windowsBridgeRoutes, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/windows-bridge/memory/self-check`);
        const payload = await response.json();

        assert.equal(response.status, 503);
        assert.deepEqual(payload, {
          ok: false,
          service: "windows-garage-api",
          code: "bridge_base_url_missing",
          message: "windows-garage base URL is not configured.",
          source: "windows-garage",
          status: 503,
        });
      });
    },
  );
});

test("memory self-check route returns safe structured upstream errors", async () => {
  const stubClient = {
    WINDOWS_ADMIN_SOURCE: "windows-admin",
    WINDOWS_GARAGE_SOURCE: "windows-garage",
    async getWindowsAdminHealth() {
      throw new Error("not used");
    },
    async getWindowsGaragePulse() {
      throw new Error("not used");
    },
    async getWindowsGarageHealth() {
      throw new Error("not used");
    },
    async getWindowsGarageMemorySelfCheck() {
      return {
        ok: false,
        source: "windows-garage",
        checkedAt: "2026-05-07T16:00:05.000Z",
        latencyMs: 9,
        httpStatus: 401,
        data: {
          error: "token: garage-token path=C:\\Users\\bryan\\secret-memory",
        },
        error: {
          code: "bridge_http_401",
          message: "token: garage-token path=C:\\Users\\bryan\\secret-memory",
        },
      };
    },
    async getWindowsServiceStatus() {
      throw new Error("not used");
    },
    async getWindowsRepos() {
      throw new Error("not used");
    },
  };

  await withServer(windowsBridgeRoutes.createRouter(stubClient), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/windows-bridge/memory/self-check`);
    const payload = await response.json();

    assert.equal(response.status, 401);
    assert.deepEqual(payload, {
      ok: false,
      service: "windows-garage-api",
      source: "windows-garage",
      status: 401,
      code: "bridge_http_401",
      message: "token: <redacted> path=<redacted-path>",
    });
    assert.equal(JSON.stringify(payload).includes("garage-token"), false);
    assert.equal(JSON.stringify(payload).includes("secret-memory"), false);
  });
});

test("health route surfaces service identity drift as warning instead of hiding it", async () => {
  const stubClient = {
    WINDOWS_ADMIN_SOURCE: "windows-admin",
    WINDOWS_GARAGE_SOURCE: "windows-garage",
    async getWindowsAdminHealth() {
      return {
        ok: true,
        source: "windows-admin",
        checkedAt: "2026-05-07T16:00:00.000Z",
        latencyMs: 12,
        httpStatus: 200,
        request: {
          pathname: "/admin/health",
          configuredTarget: {
            protocol: "http",
            host: "127.0.0.1",
            port: "3105",
            basePath: "/",
            requestPath: "/admin/health",
            display: "127.0.0.1:3105/admin/health",
          },
        },
        data: {
          ok: true,
          service: "windows-aibry-admin",
          bind: "127.0.0.1:3105",
          host: "windows",
        },
        error: null,
      };
    },
    async getWindowsGaragePulse() {
      return {
        ok: true,
        source: "windows-garage",
        checkedAt: "2026-05-07T16:00:01.000Z",
        latencyMs: 15,
        httpStatus: 200,
        request: {
          pathname: "/pulse",
          configuredTarget: {
            protocol: "http",
            host: "127.0.0.1",
            port: "5100",
            basePath: "/",
            requestPath: "/pulse",
            display: "127.0.0.1:5100/pulse",
          },
        },
        data: {
          ok: true,
          service: "windows-aibry-admin",
          bind: "127.0.0.1:3105",
          host: "windows",
        },
        error: null,
      };
    },
    async getWindowsGarageHealth() {
      return {
        ok: true,
        source: "windows-garage",
        checkedAt: "2026-05-07T16:00:02.000Z",
        latencyMs: 18,
        httpStatus: 200,
        request: {
          pathname: "/admin/health",
          configuredTarget: {
            protocol: "http",
            host: "127.0.0.1",
            port: "5100",
            basePath: "/",
            requestPath: "/admin/health",
            display: "127.0.0.1:5100/admin/health",
          },
        },
        data: {
          ok: true,
          service: "windows-aibry-admin",
          bind: "127.0.0.1:3105",
          host: "windows",
        },
        error: null,
      };
    },
    async getWindowsServiceStatus() {
      throw new Error("not used");
    },
    async getWindowsRepos() {
      throw new Error("not used");
    },
  };

  await withServer(windowsBridgeRoutes.createRouter(stubClient), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/windows-bridge/health`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.partial, false);
    assert.ok(Array.isArray(payload.warnings));
    assert.ok(payload.warnings.length >= 1);
    assert.equal(payload.sources.windowsGaragePulse.identityMatchesExpected, false);
    assert.equal(payload.sources.windowsGaragePulse.drift.detected, true);
    assert.equal(payload.sources.windowsGaragePulse.drift.code, "service_identity_drift");
    assert.match(payload.sources.windowsGaragePulse.drift.message, /windows-garage-api/i);
    assert.match(payload.sources.windowsGaragePulse.drift.message, /windows-aibry-admin/i);
    assert.equal(payload.sources.windowsGaragePulse.observedIdentity.bind, "127.0.0.1:3105");
    assert.ok(payload.sources.windowsGaragePulse.warnings.length >= 1);
  });
});
