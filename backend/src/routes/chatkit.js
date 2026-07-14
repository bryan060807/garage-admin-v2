const fs = require("fs");
const path = require("path");

const dotenv = require("dotenv");
const express = require("express");

const config = require("../config");

const router = express.Router();
const CHATKIT_API_URL = "https://api.openai.com/v1/chatkit/sessions";
const CHATKIT_ENV_PATH = path.resolve(__dirname, "../../../.env");

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
const CHATKIT_OPTIONAL_CONFIG = Object.freeze(["OPENAI_CHATKIT_WORKFLOW_VERSION"]);

function isEnabled(value) {
  return /^(1|true|yes|enabled)$/i.test(String(value || "").trim());
}

function cleanText(value) {
  return String(value || "").trim();
}

function readChatKitEnvValue(name) {
  try {
    const parsed = dotenv.parse(fs.readFileSync(CHATKIT_ENV_PATH));
    return cleanText(parsed[name]);
  } catch (_error) {
    return "";
  }
}

function getChatKitEnvValue(name) {
  if (Object.prototype.hasOwnProperty.call(process.env, name)) {
    return cleanText(process.env[name]);
  }

  return readChatKitEnvValue(name);
}

function cleanOpenAiApiKey() {
  return getChatKitEnvValue("OPENAI_API_KEY")
    .replace(/^Bearer\s+/i, "")
    .replace(/^[\"']+|[\"']+$/g, "")
    .trim();
}

function buildOpenAiAuthHeader() {
  return `Bearer ${cleanOpenAiApiKey()}`;
}

function buildSafeUpstreamError(data) {
  const error = data?.error || {};

  return {
    type: cleanText(error.type) || null,
    code: cleanText(error.code) || null,
    param: cleanText(error.param) || null,
  };
}

function buildSafeTransportError(error) {
  return {
    name: cleanText(error?.name) || "UnknownError",
    message: cleanText(error?.message).slice(0, 240) || null,
    causeName: cleanText(error?.cause?.name) || null,
    causeCode: cleanText(error?.cause?.code) || null,
    causeMessage: cleanText(error?.cause?.message).slice(0, 240) || null,
  };
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
  const apiKeyConfigured = Boolean(cleanOpenAiApiKey());
  const workflowConfigured = Boolean(getChatKitEnvValue("OPENAI_CHATKIT_WORKFLOW_ID"));
  const workflowVersion = getChatKitEnvValue("OPENAI_CHATKIT_WORKFLOW_VERSION");
  const experimentEnabled = isEnabled(getChatKitEnvValue("CHATKIT_EXPERIMENTAL_ENABLED") || getChatKitEnvValue("CHATKIT_EXPERIMENT_ENABLED"));
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
    workflowVersionConfigured: Boolean(workflowVersion),
    workflowVersionLabel: workflowVersion || "production",
    requirements: CHATKIT_REQUIRED_CONFIG.map((name) => ({
      name,
      configured: !missingConfig.includes(name),
    })),
    optionalConfig: CHATKIT_OPTIONAL_CONFIG.map((name) => ({
      name,
      configured: name === "OPENAI_CHATKIT_WORKFLOW_VERSION" ? Boolean(workflowVersion) : false,
    })),
    configured: {
      experimentEnabled,
      openaiApiKeyConfigured: apiKeyConfigured,
      workflowConfigured,
      workflowVersionConfigured: Boolean(workflowVersion),
    },
    session: {
      endpoint: "/api/chatkit/session",
      enabled: mode === "configured",
      userMode: "temporary_local_operator_identifier",
      transport: "backend_only_client_secret",
      timeoutMs: config.chatkitSessionTimeoutMs,
      workflowVersionLabel: workflowVersion || "production",
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

function buildChatKitWorkflow() {
  const workflow = {
    id: getChatKitEnvValue("OPENAI_CHATKIT_WORKFLOW_ID"),
  };
  const workflowVersion = getChatKitEnvValue("OPENAI_CHATKIT_WORKFLOW_VERSION");

  if (workflowVersion) {
    workflow.version = workflowVersion;
  }

  return workflow;
}

function buildChatKitFailure(status, { code, message, statusCode = 502, upstreamStatus = null, upstreamError = null, transportError = null }) {
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
      upstream: upstreamStatus
        ? {
            status: upstreamStatus,
            error: upstreamError,
          }
        : null,
      transport: transportError
        ? {
            error: transportError,
          }
        : null,
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
        Authorization: buildOpenAiAuthHeader(),
        "OpenAI-Beta": "chatkit_beta=v1",
      },
      signal: controller.signal,
      body: JSON.stringify({
        workflow: buildChatKitWorkflow(),
        user: operatorUser,
      }),
    });
    const data = await response.json().catch(() => ({}));
    clearTimeout(timeoutId);

    if (!response.ok || !cleanText(data?.client_secret)) {
      const upstreamError = buildSafeUpstreamError(data);
      console.warn("[chatkit] hosted session request failed", {
        responseStatus: response.status,
        upstreamError,
      });
      const failure = buildChatKitFailure(status, {
        code: "chatkit_session_failed",
        message: "ChatKit session creation is currently unavailable from the backend session route.",
        upstreamStatus: response.status,
        upstreamError,
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
    const transportError = buildSafeTransportError(error);
    console.warn("[chatkit] hosted session request threw", {
      timedOut: isTimeout,
      transportError,
    });
    const failure = buildChatKitFailure(status, {
      code: isTimeout ? "chatkit_session_timeout" : "chatkit_session_failed",
      message: isTimeout
        ? "ChatKit session creation timed out from the backend session route."
        : "ChatKit session creation is currently unavailable from the backend session route.",
      statusCode: isTimeout ? 504 : 502,
      transportError,
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
  buildChatKitWorkflow,
  buildOpenAiAuthHeader,
  buildSafeUpstreamError,
  buildSafeTransportError,
  buildTemporaryChatKitUserId,
  buildChatKitFailure,
};

module.exports = router;
