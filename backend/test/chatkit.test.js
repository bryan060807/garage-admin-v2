const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const http = require("node:http");

const chatkitRoutes = require("../src/routes/chatkit");

function setEnvValue(name, value) {
  if (value == null) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

async function withTemporaryEnv(overrides, callback) {
  const previous = new Map();

  Object.keys(overrides).forEach((name) => {
    previous.set(name, process.env[name]);
    setEnvValue(name, overrides[name]);
  });

  try {
    return await callback();
  } finally {
    previous.forEach((value, name) => {
      setEnvValue(name, value);
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
  app.use(express.json());
  app.use("/api/chatkit", router);

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

test("chatkit status exposes safe workflow version metadata only", async () => {
  await withTemporaryEnv(
    {
      CHATKIT_EXPERIMENTAL_ENABLED: "true",
      OPENAI_API_KEY: "sk-test-secret",
      OPENAI_CHATKIT_WORKFLOW_ID: "wf_secret_123",
      OPENAI_CHATKIT_WORKFLOW_VERSION: "  draft-test  ",
    },
    async () => {
      const status = chatkitRoutes.__testables.buildChatKitStatus();
      const serialized = JSON.stringify(status);

      assert.equal(status.mode, "configured");
      assert.equal(status.workflowVersionConfigured, true);
      assert.equal(status.workflowVersionLabel, "draft-test");
      assert.equal(status.configured.workflowVersionConfigured, true);
      assert.equal(status.session.workflowVersionLabel, "draft-test");
      assert.equal(serialized.includes("sk-test-secret"), false);
      assert.equal(serialized.includes("wf_secret_123"), false);
    },
  );
});

test("chatkit status labels production when workflow version is absent", async () => {
  await withTemporaryEnv(
    {
      CHATKIT_EXPERIMENTAL_ENABLED: "true",
      OPENAI_API_KEY: "sk-test-secret",
      OPENAI_CHATKIT_WORKFLOW_ID: "wf_secret_123",
      OPENAI_CHATKIT_WORKFLOW_VERSION: "   ",
    },
    async () => {
      const status = chatkitRoutes.__testables.buildChatKitStatus();

      assert.equal(status.workflowVersionConfigured, false);
      assert.equal(status.workflowVersionLabel, "production");
      assert.equal(status.configured.workflowVersionConfigured, false);
      assert.equal(status.session.workflowVersionLabel, "production");
    },
  );
});

test("chatkit session body includes trimmed workflow version when configured", async () => {
  await withTemporaryEnv(
    {
      CHATKIT_EXPERIMENTAL_ENABLED: "true",
      OPENAI_API_KEY: "sk-test-secret",
      OPENAI_CHATKIT_WORKFLOW_ID: "wf_test_123",
      OPENAI_CHATKIT_WORKFLOW_VERSION: "  draft-test  ",
    },
    async () => {
      const calls = [];
      const realFetch = global.fetch;

      await withMockFetch(
        async (url, options = {}) => {
          calls.push({
            url: String(url),
            headers: options.headers,
            body: JSON.parse(options.body),
          });

          return {
            ok: true,
            status: 200,
            async json() {
              return { client_secret: "client-secret-test" };
            },
          };
        },
        async () => {
          await withServer(chatkitRoutes, async (baseUrl) => {
            const response = await realFetch(`${baseUrl}/api/chatkit/session`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-chatkit-user": "operator one",
              },
              body: "{}",
            });
            const payload = await response.json();

            assert.equal(response.status, 200);
            assert.equal(payload.client_secret, "client-secret-test");
          });
        },
      );

      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "https://api.openai.com/v1/chatkit/sessions");
      assert.deepEqual(calls[0].body, {
        workflow: {
          id: "wf_test_123",
          version: "draft-test",
        },
        user: "operator-one",
      });
      assert.equal(calls[0].headers.Authorization, "Bearer sk-test-secret");
    },
  );
});

test("chatkit session body omits workflow version when not configured", async () => {
  await withTemporaryEnv(
    {
      CHATKIT_EXPERIMENTAL_ENABLED: "true",
      OPENAI_API_KEY: "sk-test-secret",
      OPENAI_CHATKIT_WORKFLOW_ID: "wf_test_123",
      OPENAI_CHATKIT_WORKFLOW_VERSION: "   ",
    },
    async () => {
      const calls = [];
      const realFetch = global.fetch;

      await withMockFetch(
        async (_url, options = {}) => {
          calls.push(JSON.parse(options.body));

          return {
            ok: true,
            status: 200,
            async json() {
              return { client_secret: "client-secret-test" };
            },
          };
        },
        async () => {
          await withServer(chatkitRoutes, async (baseUrl) => {
            const response = await realFetch(`${baseUrl}/api/chatkit/session`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
              },
              body: "{}",
            });

            assert.equal(response.status, 200);
          });
        },
      );

      assert.deepEqual(calls, [
        {
          workflow: {
            id: "wf_test_123",
          },
          user: "garage-admin-local-operator",
        },
      ]);
    },
  );
});
