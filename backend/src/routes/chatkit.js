const express = require("express");

const router = express.Router();
const CHATKIT_API_URL = "https://api.openai.com/v1/chatkit/sessions";

const CHATKIT_SURFACE = "experimental-chatkit";
const CHATKIT_DISABLED_REASON =
  "ChatKit proof-of-life is in prep mode only. No ChatKit packages, sessions, tools, files, actions, workers, or persistence are active.";
const CHATKIT_POLICY = Object.freeze([
  "cannot restart services",
  "cannot approve actions",
  "cannot write files",
  "cannot run shell commands",
  "cannot call workers",
  "cannot bypass Service Actions",
]);

function isEnabled(value) {
  return /^(1|true|yes|enabled)$/i.test(String(value || "").trim());
}

function cleanText(value) {
  return String(value || "").trim();
}

function buildTemporaryChatKitUserId(req) {
  const candidate = cleanText(req.get("x-chatkit-user"));

  if (candidate) {
    return candidate.slice(0, 120);
  }

  return "garage-admin-local-operator";
}

function buildChatKitStatus() {
  const apiKeyConfigured = Boolean(process.env.OPENAI_API_KEY);
  const workflowConfigured = Boolean(process.env.OPENAI_CHATKIT_WORKFLOW_ID);
  const experimentEnabled = isEnabled(process.env.CHATKIT_EXPERIMENTAL_ENABLED || process.env.CHATKIT_EXPERIMENT_ENABLED);
  const ready = experimentEnabled && apiKeyConfigured && workflowConfigured;

  return {
    ok: true,
    surface: CHATKIT_SURFACE,
    status: ready ? "configured" : "unavailable",
    mode: "prep",
    configured: {
      experimentEnabled,
      openaiApiKeyConfigured: apiKeyConfigured,
      workflowConfigured,
    },
    session: {
      endpoint: "/api/chatkit/session",
      userMode: "temporary_local_operator_identifier",
    },
    error: ready
      ? null
      : {
          code: "chatkit_unavailable",
          message:
            "ChatKit is in prep mode until CHATKIT_EXPERIMENTAL_ENABLED, OPENAI_API_KEY, and OPENAI_CHATKIT_WORKFLOW_ID are configured on the backend. Secrets and workflow internals are never returned by this route.",
        },
    policy: CHATKIT_POLICY,
  };
}

router.get("/status", (_req, res) => {
  res.json(buildChatKitStatus());
});

router.post("/session", async (req, res, next) => {
  const status = buildChatKitStatus();

  if (status.status !== "configured") {
    return res.status(503).json(status);
  }

  const operatorUser = buildTemporaryChatKitUserId(req);

  try {
    const response = await fetch(CHATKIT_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "chatkit_beta=v1",
      },
      body: JSON.stringify({
        workflow: {
          id: process.env.OPENAI_CHATKIT_WORKFLOW_ID,
        },
        user: operatorUser,
      }),
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok || !cleanText(data?.client_secret)) {
      return res.status(502).json({
        ...status,
        ok: false,
        error: {
          code: "chatkit_session_failed",
          message: "ChatKit session is currently unavailable from the backend session route.",
        },
      });
    }

    return res.json({
      ...status,
      client_secret: data.client_secret,
    });
  } catch (_error) {
    return res.status(502).json({
      ...status,
      ok: false,
      error: {
        code: "chatkit_session_failed",
        message: "ChatKit session is currently unavailable from the backend session route.",
      },
    });
  }
});

router.post("/proof-of-life", (_req, res) => {
  const status = buildChatKitStatus();

  res.json({
    ...status,
    proofOfLife: {
      connected: true,
      message:
        "Garage Admin ChatKit proof of life is connected. I can help reason about service context, logs, freshness, and worker evidence in future passes. I cannot restart services, approve actions, write files, run shell commands, call workers, persist sessions, upload files, or bypass Service Actions.",
      disabledReason: CHATKIT_DISABLED_REASON,
    },
  });
});

router.__testables = {
  buildChatKitStatus,
  buildTemporaryChatKitUserId,
};

module.exports = router;
