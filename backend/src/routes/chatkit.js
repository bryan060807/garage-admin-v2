const express = require("express");

const config = require("../config");

const router = express.Router();
const CHATKIT_API_URL = "https://api.openai.com/v1/chatkit/sessions";

const CHATKIT_SURFACE = "experimental-chatkit";
const CHATKIT_POLICY = Object.freeze([
  "cannot restart services",
  "cannot approve actions",
  "cannot write files",
  "cannot run shell commands",
  "cannot call workers",
  "cannot bypass Service Actions",
]);
const CHATKIT_REQUIRED_CONFIG = Object.freeze([
  "CHATKIT_EXPERIMENTAL_ENABLED",
  "OPENAI_API_KEY",
  "OPENAI_CHATKIT_WORKFLOW_ID",
]);

function isEnabled(value) {
  return /^(1|true|yes|enabled)$/i.test(String(value || "").trim());
}

function cleanText(value) {
  return String(value || "").trim();
}

function buildTemporaryChatKitUserId(req) {
  const candidate = cleanText(req.get("x-chatkit-user"));
  const sanitized = candidate
    .replace(/[^a-zA-Z0-9._:-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (sanitized) {
    return sanitized.slice(0, 120);
  }

  return "garage-admin-local-operator";
}

function buildChatKitStatus() {
  const apiKeyConfigured = Boolean(process.env.OPENAI_API_KEY);
  const workflowConfigured = Boolean(process.env.OPENAI_CHATKIT_WORKFLOW_ID);
  const experimentEnabled = isEnabled(process.env.CHATKIT_EXPERIMENTAL_ENABLED || process.env.CHATKIT_EXPERIMENT_ENABLED);
  const missingConfig = [];
  const checkedAt = new Date().toISOString();

  if (!experimentEnabled) {
    missingConfig.push("CHATKIT_EXPERIMENTAL_ENABLED");
  }

  if (!apiKeyConfigured) {
    missingConfig.push("OPENAI_API_KEY");
  }

  if (!workflowConfigured) {
    missingConfig.push("OPENAI_CHATKIT_WORKFLOW_ID");
  }

  let mode = "configured";
  let availability = "session_ready";
  let status = "configured";
  let reason = "Hosted ChatKit session creation is enabled on the backend. ChatKit remains assistant-only and read-only.";
  let error = null;
  let nextStep = "Validate /api/chatkit/status, /api/chatkit/proof-of-life, and a hosted session request after the Windows PM2 runtime has the required backend env vars.";

  if (!experimentEnabled) {
    mode = "disabled";
    availability = "disabled";
    status = "disabled";
    reason =
      "ChatKit is disabled on this runtime until CHATKIT_EXPERIMENTAL_ENABLED is turned on. Backend-only credentials and assistant-only boundaries remain enforced.";
    nextStep =
      "Set CHATKIT_EXPERIMENTAL_ENABLED=true on the Windows runtime, add the required backend-only ChatKit env vars, then refresh the PM2 runtime.";
    error = {
      code: "chatkit_disabled",
      message: reason,
    };
  } else if (missingConfig.length) {
    mode = "prep";
    availability = "unavailable";
    status = "unavailable";
    reason =
      "ChatKit is in prep mode because required backend-only ChatKit configuration is still missing. This surface stays diagnostic-only until those names are configured.";
    nextStep = `Add the missing backend-only config names (${missingConfig.join(", ")}) on the Windows runtime, then refresh the PM2 process environment.`;
    error = {
      code: "chatkit_prep_incomplete",
      message: reason,
    };
  } else if (typeof fetch !== "function") {
    mode = "error";
    availability = "unavailable";
    status = "error";
    reason =
      "ChatKit configuration is present, but this backend runtime cannot issue hosted session requests because fetch is unavailable.";
    nextStep = "Run Garage Admin V2 on a Node runtime with fetch support, then retry the hosted ChatKit status and proof-of-life checks.";
    error = {
      code: "chatkit_runtime_unavailable",
      message: reason,
    };
  }

  return {
    ok: true,
    surface: CHATKIT_SURFACE,
    status,
    mode,
    availability,
    checkedAt,
    reason,
    missingConfig,
    missingConfigCount: missingConfig.length,
    requirements: CHATKIT_REQUIRED_CONFIG.map((name) => ({
      name,
      configured: !missingConfig.includes(name),
    })),
    configured: {
      experimentEnabled,
      openaiApiKeyConfigured: apiKeyConfigured,
      workflowConfigured,
    },
    session: {
      endpoint: "/api/chatkit/session",
      enabled: mode === "configured",
      userMode: "temporary_local_operator_identifier",
      transport: "backend_only_client_secret",
      timeoutMs: config.chatkitSessionTimeoutMs,
    },
    nextStep,
    intentionallyDisabled: [
      "service actions",
      "action approval",
      "worker job execution",
      "file writes",
      "shell execution",
      "restarts",
      "browser-side secrets",
    ],
    error,
    policy: CHATKIT_POLICY,
  };
}

function buildChatKitFailure(status, { code, message, statusCode = 502 }) {
  return {
    statusCode,
    body: {
      ...status,
      ok: false,
      mode: "error",
      status: "error",
      availability: "unavailable",
      checkedAt: new Date().toISOString(),
      reason: message,
      error: {
        code,
        message,
      },
    },
  };
}

router.get("/status", (_req, res) => {
  res.json(buildChatKitStatus());
});

router.post("/session", async (req, res, next) => {
  const status = buildChatKitStatus();

  if (status.mode !== "configured") {
    return res.status(503).json(status);
  }

  const operatorUser = buildTemporaryChatKitUserId(req);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.chatkitSessionTimeoutMs);

  try {
    const response = await fetch(CHATKIT_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "chatkit_beta=v1",
      },
      signal: controller.signal,
      body: JSON.stringify({
        workflow: {
          id: process.env.OPENAI_CHATKIT_WORKFLOW_ID,
        },
        user: operatorUser,
      }),
    });
    const data = await response.json().catch(() => ({}));
    clearTimeout(timeoutId);

    if (!response.ok || !cleanText(data?.client_secret)) {
      console.warn("[chatkit] hosted session request failed", {
        responseStatus: response.status,
      });
      const failure = buildChatKitFailure(status, {
        code: "chatkit_session_failed",
        message: "ChatKit session creation is currently unavailable from the backend session route.",
      });
      return res.status(failure.statusCode).json(failure.body);
    }

    return res.json({
      ...status,
      checkedAt: new Date().toISOString(),
      client_secret: data.client_secret,
    });
  } catch (error) {
    clearTimeout(timeoutId);
    const isTimeout = error?.name === "AbortError";
    console.warn("[chatkit] hosted session request threw", {
      errorName: error?.name || "UnknownError",
      timedOut: isTimeout,
    });
    const failure = buildChatKitFailure(status, {
      code: isTimeout ? "chatkit_session_timeout" : "chatkit_session_failed",
      message: isTimeout
        ? "ChatKit session creation timed out from the backend session route."
        : "ChatKit session creation is currently unavailable from the backend session route.",
      statusCode: isTimeout ? 504 : 502,
    });
    return res.status(failure.statusCode).json(failure.body);
  }
});

router.post("/proof-of-life", (_req, res) => {
  const status = buildChatKitStatus();
  const proofMessage =
    status.mode === "configured"
      ? "Garage Admin ChatKit proof of life is connected. Hosted backend sessions are enabled, but ChatKit remains assistant-only and cannot restart services, approve actions, write files, run shell commands, call workers, persist files, or bypass Service Actions."
      : "Garage Admin ChatKit proof of life is connected in readiness mode. It can describe service context, logs, freshness, and worker evidence in future passes, but hosted sessions stay unavailable until backend-only configuration is complete.";

  res.json({
    ...status,
    proofOfLife: {
      connected: true,
      message: proofMessage,
    },
  });
});

router.__testables = {
  buildChatKitStatus,
  buildTemporaryChatKitUserId,
  buildChatKitFailure,
};

module.exports = router;
