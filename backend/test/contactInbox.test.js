const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const http = require("node:http");

const contactInboxRoutes = require("../src/routes/contactInbox");

async function withServer(router, callback) {
  const app = express();
  app.use("/api/contact-inbox", router);
  app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    return await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("contact inbox keeps the token server-side and normalizes messages", async () => {
  let upstreamRequest;
  const router = contactInboxRoutes.createRouter({
    settings: {
      baseUrl: "https://website.example.test",
      internalToken: "server-secret",
      timeoutMs: 1000,
    },
    async fetchImpl(url, options) {
      upstreamRequest = { url: String(url), options };
      return new Response(JSON.stringify({
        messages: [{
          id: 7,
          sender_name: "Pat",
          sender_email: "pat@example.test",
          body: "Need help",
          created_at: "2026-06-28T12:00:00.000Z",
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  await withServer(router, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/contact-inbox?limit=500`);
    const payload = await response.json();
    const serialized = JSON.stringify(payload);

    assert.equal(response.status, 200);
    assert.equal(payload.readOnly, true);
    assert.equal(payload.items[0].name, "Pat");
    assert.equal(payload.items[0].message, "Need help");
    assert.equal(upstreamRequest.url, "https://website.example.test/api/contact-messages/admin?limit=100");
    assert.equal(upstreamRequest.options.headers["x-aibry-internal-token"], "server-secret");
    assert.equal(serialized.includes("server-secret"), false);
  });
});

test("contact inbox reports missing server configuration without calling upstream", async () => {
  const router = contactInboxRoutes.createRouter({
    settings: { baseUrl: "https://website.example.test", internalToken: "", timeoutMs: 1000 },
    async fetchImpl() {
      throw new Error("should not run");
    },
  });

  await withServer(router, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/contact-inbox`);
    const payload = await response.json();
    assert.equal(response.status, 503);
    assert.equal(payload.error.code, "contact_inbox_not_configured");
  });
});
