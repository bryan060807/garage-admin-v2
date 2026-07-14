const express = require("express");

const config = require("../config");

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function normalizeLimit(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), MAX_LIMIT) : DEFAULT_LIMIT;
}

function normalizeMessage(entry) {
  const item = entry && typeof entry === "object" ? entry : {};

  return {
    id: String(item.id || item.message_id || ""),
    name: String(item.name || item.sender_name || ""),
    email: String(item.email || item.sender_email || ""),
    message: String(item.message || item.body || ""),
    createdAt: item.createdAt || item.created_at || item.submittedAt || item.submitted_at || null,
  };
}

function extractItems(payload) {
  const candidates = [payload?.items, payload?.messages, payload?.data, payload];
  const items = candidates.find(Array.isArray) || [];
  return items.map(normalizeMessage).filter((item) => item.id || item.email || item.message);
}

function createRouter({
  fetchImpl = fetch,
  settings = {
    baseUrl: config.websiteApiBaseUrl,
    internalToken: config.websiteApiInternalToken,
    timeoutMs: config.websiteApiTimeoutMs,
  },
} = {}) {
  const router = express.Router();

  router.get("/", async (req, res, next) => {
    if (!settings.internalToken) {
      return res.status(503).json({
        error: {
          code: "contact_inbox_not_configured",
          message: "Contact Inbox is not configured on this Garage Admin runtime.",
        },
      });
    }

    const limit = normalizeLimit(req.query.limit);
    const url = new URL("/api/contact-messages/admin", `${settings.baseUrl}/`);
    url.searchParams.set("limit", String(limit));

    try {
      const response = await fetchImpl(url, {
        headers: {
          accept: "application/json",
          "x-aibry-internal-token": settings.internalToken,
        },
        signal: AbortSignal.timeout(settings.timeoutMs),
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        return res.status(response.status === 401 || response.status === 403 ? 502 : response.status).json({
          error: {
            code: "contact_inbox_upstream_failed",
            message: "The Website contact inbox could not be loaded.",
          },
        });
      }

      const items = extractItems(payload);
      return res.json({
        ok: true,
        readOnly: true,
        items,
        count: items.length,
        fetchedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        return res.status(504).json({
          error: {
            code: "contact_inbox_timeout",
            message: "The Website contact inbox did not respond before the timeout.",
          },
        });
      }

      return next(error);
    }
  });

  return router;
}

const router = createRouter();
router.createRouter = createRouter;
router.extractItems = extractItems;
router.normalizeLimit = normalizeLimit;

module.exports = router;
