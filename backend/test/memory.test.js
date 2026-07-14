const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const memoryRoutes = require("../src/routes/memory");

const SCHEMA_MISSING_MESSAGE =
  "Garage Admin memory database is reachable/configured, but required schema tables are missing. Apply the schema with `npm run db:schema` from the Garage Admin V2 repo.";

async function withServer(router, callback) {
  const app = express();
  app.use(express.json());
  app.use("/api/memory", router);
  app.use((error, _req, res, _next) => {
    res.status(error.statusCode || 500).json({
      error: error.message || "Internal server error",
    });
  });

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

test("memory GET routes return degraded 200 on read failure", async () => {
  const router = memoryRoutes.createRouter({
    repository: {
      async listIncidents() {
        const error = new Error("synthetic read failure with token=secret");
        error.code = "synthetic_read_failed";
        throw error;
      },
    },
    database: {
      async getMemoryHealth() {
        return { ok: true, degraded: false };
      },
    },
  });

  await withServer(router, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/memory/incidents`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.degraded, true);
    assert.deepEqual(payload.items, []);
    assert.equal(payload.error.code, "synthetic_read_failed");
    assert.equal(payload.error.message.includes("secret"), false);
  });
});

test("memory health endpoint exposes only scrubbed diagnostic fields", async () => {
  const router = memoryRoutes.createRouter({
    repository: {},
    database: {
      async getMemoryHealth() {
        return {
          ok: false,
          degraded: true,
          databaseConfigured: true,
          poolAvailable: true,
          latencyMs: 12,
          connectionString: "postgresql://user:password@example.test/db",
          password: "secret",
          checks: {
            canSelectNow: false,
            tablePresence: {
              incidents: true,
              action_audit: false,
              service_facts: true,
            },
          },
          error: {
            code: "database_timeout",
            message: "Garage Admin memory database did not respond before the configured timeout.",
            detail: "password=secret",
          },
        };
      },
    },
  });

  await withServer(router, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/memory/health`);
    const payload = await response.json();
    const serialized = JSON.stringify(payload);

    assert.equal(response.status, 200);
    assert.equal(payload.ok, false);
    assert.equal(payload.degraded, true);
    assert.equal(payload.databaseConfigured, true);
    assert.equal(payload.poolAvailable, true);
    assert.equal(payload.latencyMs, 12);
    assert.equal(payload.checks.tablePresence.incidents, true);
    assert.equal(payload.error.code, "database_timeout");
    assert.equal(serialized.includes("postgresql://"), false);
    assert.equal(serialized.includes("password"), false);
    assert.equal(serialized.includes("secret"), false);
  });
});

test("public memory health explains missing schema without exposing database config", () => {
  const payload = memoryRoutes.publicMemoryHealth({
    ok: false,
    degraded: true,
    databaseConfigured: true,
    poolAvailable: true,
    latencyMs: 8,
    connectionString: "postgresql://user:password@example.test/db",
    checks: {
      canSelectNow: true,
      tablePresence: {
        incidents: false,
        action_audit: false,
        service_facts: false,
      },
    },
    error: {
      code: "database_schema_missing",
      message: SCHEMA_MISSING_MESSAGE,
      detail: "password=secret",
    },
  });
  const serialized = JSON.stringify(payload);

  assert.equal(payload.ok, false);
  assert.equal(payload.degraded, true);
  assert.equal(payload.databaseConfigured, true);
  assert.equal(payload.poolAvailable, true);
  assert.equal(payload.checks.canSelectNow, true);
  assert.equal(payload.checks.tablePresence.incidents, false);
  assert.equal(payload.error.code, "database_schema_missing");
  assert.equal(payload.error.message, SCHEMA_MISSING_MESSAGE);
  assert.equal(serialized.includes("postgresql://"), false);
  assert.equal(serialized.includes("password"), false);
  assert.equal(serialized.includes("secret"), false);
});

test("memory GET routes return schema-missing guidance on missing table errors", async () => {
  const router = memoryRoutes.createRouter({
    repository: {
      async listIncidents() {
        const error = new Error('relation "incidents" does not exist');
        error.code = "42P01";
        throw error;
      },
    },
    database: {
      async getMemoryHealth() {
        return { ok: false, degraded: true };
      },
    },
  });

  await withServer(router, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/memory/incidents`);
    const payload = await response.json();
    const serialized = JSON.stringify(payload);

    assert.equal(response.status, 200);
    assert.equal(payload.degraded, true);
    assert.deepEqual(payload.items, []);
    assert.equal(payload.error.code, "database_schema_missing");
    assert.equal(payload.error.message, SCHEMA_MISSING_MESSAGE);
    assert.equal(serialized.includes("postgresql://"), false);
    assert.equal(serialized.includes("password"), false);
    assert.equal(serialized.includes("secret"), false);
  });
});

test("patch proposal endpoints list and read proposed patches without applying them", async () => {
  const memoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "garage-memory-proposals-"));
  const proposalsDir = path.join(memoryRoot, "proposed_patches");
  await fs.mkdir(proposalsDir, { recursive: true });
  await fs.writeFile(
    path.join(proposalsDir, "2026-07-03-demo.patch.md"),
    `---\ngenerated_at: '2026-07-03'\ntopic: demo\nsource_session: demo.md\ntarget_project: projects/active/project-demo.md\n---\n\n# PATCH PROPOSAL\n\n## PROJECT_UPDATE\n- Demo update\n`,
    "utf8",
  );

  const router = memoryRoutes.createRouter({
    repository: {},
    database: {
      async getMemoryHealth() {
        return { ok: true, degraded: false };
      },
    },
    memoryRoot,
  });

  await withServer(router, async (baseUrl) => {
    const listResponse = await fetch(`${baseUrl}/api/memory/patch-proposals`);
    const listPayload = await listResponse.json();

    assert.equal(listResponse.status, 200);
    assert.equal(listPayload.degraded, false);
    assert.equal(listPayload.items.length, 1);
    assert.equal(listPayload.items[0].name, "2026-07-03-demo.patch.md");
    assert.equal(listPayload.items[0].topic, "demo");
    assert.equal(listPayload.items[0].targetProject, "projects/active/project-demo.md");

    const detailResponse = await fetch(`${baseUrl}/api/memory/patch-proposals/2026-07-03-demo.patch.md`);
    const detailPayload = await detailResponse.json();

    assert.equal(detailResponse.status, 200);
    assert.equal(detailPayload.item.name, "2026-07-03-demo.patch.md");
    assert.equal(detailPayload.item.raw.includes("# PATCH PROPOSAL"), true);
    assert.equal(detailPayload.item.body.includes("target_project:"), false);
    assert.equal(detailPayload.item.body.includes("Demo update"), true);
  });
});

test("patch proposal detail rejects traversal and non-proposal names", async () => {
  const memoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "garage-memory-proposals-"));
  const router = memoryRoutes.createRouter({
    repository: {},
    database: {
      async getMemoryHealth() {
        return { ok: true, degraded: false };
      },
    },
    memoryRoot,
  });

  await withServer(router, async (baseUrl) => {
    for (const name of ["../secret.patch.md", "notes.md"]) {
      const response = await fetch(`${baseUrl}/api/memory/patch-proposals/${encodeURIComponent(name)}`);
      const payload = await response.json();

      assert.equal(response.status, 400);
      assert.equal(payload.error, "Invalid proposal filename.");
    }
  });
});

test("patch proposal apply requires confirmation, calls injected worker, and archives applied proposal", async () => {
  const memoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "garage-memory-proposals-"));
  const proposalsDir = path.join(memoryRoot, "proposed_patches");
  await fs.mkdir(proposalsDir, { recursive: true });
  await fs.writeFile(
    path.join(proposalsDir, "2026-07-03-apply.patch.md"),
    `---\ngenerated_at: '2026-07-03'\ntopic: apply\nupdates:\n  - action: append_to_section\n    file: 01_ACTIVE_CONTEXT.md\n    section: Current State\n    content: Applied update\n---\n\n# PATCH PROPOSAL\n`,
    "utf8",
  );

  const calls = [];
  const router = memoryRoutes.createRouter({
    repository: {},
    database: {
      async getMemoryHealth() {
        return { ok: true, degraded: false };
      },
    },
    memoryRoot,
    async applyPatchProposal(name, root) {
      calls.push({ name, root });
      return { touchedFiles: ["01_ACTIVE_CONTEXT.md"] };
    },
  });

  await withServer(router, async (baseUrl) => {
    const deniedResponse = await fetch(`${baseUrl}/api/memory/patch-proposals/2026-07-03-apply.patch.md/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: false }),
    });
    const deniedPayload = await deniedResponse.json();

    assert.equal(deniedResponse.status, 400);
    assert.equal(deniedPayload.error, "Applying a memory patch proposal requires explicit confirmation.");

    const applyResponse = await fetch(`${baseUrl}/api/memory/patch-proposals/2026-07-03-apply.patch.md/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    const applyPayload = await applyResponse.json();

    assert.equal(applyResponse.status, 200);
    assert.equal(applyPayload.ok, true);
    assert.equal(applyPayload.status, "applied");
    assert.deepEqual(applyPayload.touchedFiles, ["01_ACTIVE_CONTEXT.md"]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "2026-07-03-apply.patch.md");
    assert.equal(calls[0].root, memoryRoot);

    await assert.rejects(fs.stat(path.join(proposalsDir, "2026-07-03-apply.patch.md")), { code: "ENOENT" });
    const archived = await fs.readdir(path.join(memoryRoot, "reviewed_patches", "applied"));
    assert.equal(archived.length, 1);
    assert.equal(archived[0].endsWith("__2026-07-03-apply.patch.md"), true);
  });
});

test("patch proposal neutralize requires confirmation and moves proposal without applying", async () => {
  const memoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "garage-memory-proposals-"));
  const proposalsDir = path.join(memoryRoot, "proposed_patches");
  await fs.mkdir(proposalsDir, { recursive: true });
  await fs.writeFile(
    path.join(proposalsDir, "2026-07-03-neutralize.patch.md"),
    `---\ngenerated_at: '2026-07-03'\ntopic: neutralize\n---\n\n# PATCH PROPOSAL\n`,
    "utf8",
  );

  const router = memoryRoutes.createRouter({
    repository: {},
    database: {
      async getMemoryHealth() {
        return { ok: true, degraded: false };
      },
    },
    memoryRoot,
    async applyPatchProposal() {
      throw new Error("apply should not be called");
    },
  });

  await withServer(router, async (baseUrl) => {
    const deniedResponse = await fetch(`${baseUrl}/api/memory/patch-proposals/2026-07-03-neutralize.patch.md/neutralize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: false }),
    });
    const deniedPayload = await deniedResponse.json();

    assert.equal(deniedResponse.status, 400);
    assert.equal(deniedPayload.error, "Neutralizing a memory patch proposal requires explicit confirmation.");

    const neutralizeResponse = await fetch(`${baseUrl}/api/memory/patch-proposals/2026-07-03-neutralize.patch.md/neutralize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    const neutralizePayload = await neutralizeResponse.json();

    assert.equal(neutralizeResponse.status, 200);
    assert.equal(neutralizePayload.ok, true);
    assert.equal(neutralizePayload.status, "neutralized");
    await assert.rejects(fs.stat(path.join(proposalsDir, "2026-07-03-neutralize.patch.md")), { code: "ENOENT" });
    const archived = await fs.readdir(path.join(memoryRoot, "reviewed_patches", "neutralized"));
    assert.equal(archived.length, 1);
    assert.equal(archived[0].endsWith("__2026-07-03-neutralize.patch.md"), true);
  });
});

test("memory POST routes do not swallow write failures as degraded reads", async () => {
  const router = memoryRoutes.createRouter({
    repository: {
      async createIncident() {
        throw new Error("synthetic write failure");
      },
    },
    database: {
      async getMemoryHealth() {
        return { ok: true, degraded: false };
      },
    },
  });

  await withServer(router, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/memory/incidents`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Synthetic incident",
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.equal(Object.prototype.hasOwnProperty.call(payload, "degraded"), false);
    assert.equal(payload.error, "synthetic write failure");
  });
});
