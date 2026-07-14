const fs = require("fs/promises");
const path = require("path");

const dotenv = require("dotenv");
const express = require("express");

const config = require("../config");
const chatkitRoutes = require("./chatkit");
const { redactText, redactValue } = require("../lib/outputRedaction");

const router = express.Router();
const PROJECT_ENV_PATH = path.resolve(__dirname, "../../../.env");
const RESPONSES_API_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-5.5";
const MAX_MESSAGE_CHARS = 6000;
const MAX_TOOL_LOOPS = 4;
const MAX_MEMORY_CHARS = 9000;
const MAX_LOG_LINES = 80;

const ROOT_MEMORY_ENTRIES = new Set([
  "00_START_HERE.md",
  "01_ACTIVE_CONTEXT.md",
  "02_PROJECT_INDEX.md",
  "03_TASK_BOARD.md",
  "04_DECISION_LOG.md",
  "05_RUNTIME_STATE.md",
]);

function asyncRoute(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (error) {
      next(error);
    }
  };
}

function cleanText(value) {
  return String(value || "").trim();
}

function readProjectEnvValue(name) {
  try {
    const parsed = dotenv.parse(require("fs").readFileSync(PROJECT_ENV_PATH));
    return cleanText(parsed[name]);
  } catch (_error) {
    return "";
  }
}

function getRuntimeValue(name) {
  return readProjectEnvValue(name) || cleanText(process.env[name]);
}

function cleanOpenAiApiKey() {
  return getRuntimeValue("OPENAI_API_KEY")
    .replace(/^Bearer\s+/i, "")
    .replace(/^[\"']+|[\"']+$/g, "")
    .trim();
}

function isCustomAgentEnabled() {
  const explicit = getRuntimeValue("CHATKIT_CUSTOM_AGENT_ENABLED");
  if (explicit) {
    return /^(1|true|yes|enabled|on)$/i.test(explicit);
  }

  // The route exposes only read-only tools and still requires a backend-only
  // OPENAI_API_KEY. Keep it available by default so the ChatKit migration can
  // be tested without editing the sensitive .env file through the operator UI.
  return true;
}

function getModelName() {
  return getRuntimeValue("OPENAI_CUSTOM_AGENT_MODEL") || getRuntimeValue("OPENAI_CHATKIT_CUSTOM_AGENT_MODEL") || DEFAULT_MODEL;
}

function makeSafeError(error, fallback = "Custom ChatKit agent request failed.") {
  return {
    code: error?.code || error?.name || "custom_agent_error",
    message: redactText(error?.message || fallback),
  };
}

async function localJson(pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${config.port}${pathname}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));

  return {
    ok: response.ok,
    status: response.status,
    data: redactValue(data),
  };
}

function normalizeServiceName(value) {
  return cleanText(value).replace(/[^a-zA-Z0-9._:-]+/g, "-").slice(0, 160);
}

function getTextLines(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => redactText(line))
    .filter(Boolean);
}

function extractLogText(payload) {
  if (typeof payload?.logs === "string") {
    return payload.logs;
  }

  if (typeof payload?.logText === "string") {
    return payload.logText;
  }

  if (typeof payload?.stdout === "string") {
    return payload.stdout;
  }

  if (Array.isArray(payload?.lines)) {
    return payload.lines.join("\n");
  }

  return JSON.stringify(payload || {}, null, 2);
}

function resolveMemoryPath(entryId) {
  const normalized = cleanText(entryId).replace(/\\/g, "/").replace(/^\/+/, "");

  if (!normalized || normalized.includes("..") || path.isAbsolute(normalized)) {
    const error = new Error("Memory entry is not allowlisted.");
    error.statusCode = 400;
    error.code = "memory_entry_not_allowlisted";
    throw error;
  }

  if (!ROOT_MEMORY_ENTRIES.has(normalized) && !(normalized.startsWith("projects/active/") && normalized.endsWith(".md"))) {
    const error = new Error("Memory entry is not allowlisted.");
    error.statusCode = 400;
    error.code = "memory_entry_not_allowlisted";
    throw error;
  }

  if (!ROOT_MEMORY_ENTRIES.has(normalized) && !normalized.startsWith("projects/active/")) {
    const error = new Error("Only active memory files and projects/active markdown files are available.");
    error.statusCode = 400;
    error.code = "memory_entry_not_allowlisted";
    throw error;
  }

  const memoryRoot = path.resolve(config.garageMemoryRoot || "");
  const fullPath = path.resolve(memoryRoot, normalized);

  if (!fullPath.startsWith(`${memoryRoot}${path.sep}`) && fullPath !== memoryRoot) {
    const error = new Error("Memory entry path escaped the memory root.");
    error.statusCode = 400;
    error.code = "memory_entry_path_escape";
    throw error;
  }

  return { normalized, fullPath };
}

async function toolGetChatKitStatus() {
  const status = chatkitRoutes.__testables?.buildChatKitStatus
    ? chatkitRoutes.__testables.buildChatKitStatus()
    : { ok: false, error: { code: "chatkit_status_unavailable" } };

  return redactValue({
    ok: true,
    source: "garage-admin-v2-backend",
    status,
  });
}

async function toolGetMemoryEntry(args = {}) {
  const { normalized, fullPath } = resolveMemoryPath(args.entry_id || args.entryId || "");
  const text = await fs.readFile(fullPath, "utf8");
  const redacted = redactText(text);

  return {
    ok: true,
    entry_id: normalized,
    chars: redacted.length,
    truncated: redacted.length > MAX_MEMORY_CHARS,
    text: redacted.slice(0, MAX_MEMORY_CHARS),
  };
}

async function toolGetServiceStatus(args = {}) {
  const service = normalizeServiceName(args.service || "garage-admin-v2");
  const services = await localJson("/api/services");
  const items = Array.isArray(services.data?.items) ? services.data.items : [];
  const selected = items.find((item) => {
    const candidates = [item.name, item.service, item.serviceName, item.id, item.displayName].map((entry) => cleanText(entry).toLowerCase());
    return candidates.includes(service.toLowerCase());
  });
  const health = await localJson(`/api/services/${encodeURIComponent(service)}/health`);

  return redactValue({
    ok: true,
    service,
    inventory: {
      ok: services.ok,
      status: services.status,
      found: Boolean(selected),
      item: selected || null,
      sources: services.data?.sources || null,
    },
    health,
  });
}

async function toolQueryServiceLogs(args = {}) {
  const service = normalizeServiceName(args.service || "garage-admin-v2");
  const filter = cleanText(args.filter || args.grep || "").toLowerCase();
  const requestedLines = Number(args.lines);
  const maxLines = Number.isFinite(requestedLines) ? Math.max(1, Math.min(requestedLines, MAX_LOG_LINES)) : 40;
  const response = await localJson(`/api/services/${encodeURIComponent(service)}/logs`);
  const allLines = getTextLines(extractLogText(response.data));
  const filtered = filter ? allLines.filter((line) => line.toLowerCase().includes(filter)) : allLines;
  const lines = filtered.slice(-maxLines);

  return {
    ok: response.ok,
    service,
    filter: filter || null,
    sourceStatus: response.status,
    totalLinesSeen: allLines.length,
    matchedLines: filtered.length,
    returnedLines: lines.length,
    lines,
  };
}

const TOOL_DEFINITIONS = [
  {
    type: "function",
    name: "get_chatkit_status",
    description: "Read Garage Admin V2 ChatKit readiness/status. Returns only safe config presence and never secret values.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "get_memory_entry",
    description:
      "Read an allowlisted Garage Admin active memory markdown entry. Only root active files and projects/active markdown files are allowed.",
    parameters: {
      type: "object",
      properties: {
        entry_id: {
          type: "string",
          description: "Allowlisted entry id, e.g. 01_ACTIVE_CONTEXT.md, 03_TASK_BOARD.md, or projects/active/example.md.",
        },
      },
      required: ["entry_id"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "get_service_status",
    description: "Read service inventory and health for one Garage Admin service. Read-only.",
    parameters: {
      type: "object",
      properties: {
        service: {
          type: "string",
          description: "Service name, for example garage-admin-v2.",
        },
      },
      required: ["service"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "query_service_logs",
    description: "Read a capped, redacted service log preview. Read-only and limited to at most 80 returned lines.",
    parameters: {
      type: "object",
      properties: {
        service: {
          type: "string",
          description: "Service name, for example garage-admin-v2.",
        },
        filter: {
          type: "string",
          description: "Optional case-insensitive substring filter such as chatkit.",
        },
        lines: {
          type: "number",
          description: "Maximum lines to return, capped at 80.",
        },
      },
      required: ["service"],
      additionalProperties: false,
    },
  },
];

const TOOL_HANDLERS = Object.freeze({
  get_chatkit_status: toolGetChatKitStatus,
  get_memory_entry: toolGetMemoryEntry,
  get_service_status: toolGetServiceStatus,
  query_service_logs: toolQueryServiceLogs,
});

const CUSTOM_AGENT_INSTRUCTIONS = `You are Garage Admin V2 Custom ChatKit Agent, a server-side read-only operator assistant embedded in Garage Admin V2.

Identity:
- Identify this route as the Garage Admin V2 custom server-side agent path, not the legacy local assistant and not the Agent Builder-hosted workflow.
- The UI may still be a temporary proof surface. Do not overclaim a full ChatKit apiURL protocol migration unless explicitly told it is enabled.

Safety boundaries:
- You cannot restart services, approve actions, write files, run shell commands, deploy code, mutate memory, expose secrets, read env values, or bypass Service Actions.
- Never ask the user to paste secrets. Never reveal API keys, tokens, credentials, headers, or raw secret-bearing files.
- Use only the read-only tools provided. If a tool is unavailable or returns degraded data, say so.

Operational behavior:
- For “where did we leave off,” read 01_ACTIVE_CONTEXT.md and 03_TASK_BOARD.md first, then check garage-admin-v2 status, then query a capped chatkit log preview if useful.
- Keep answers concise and evidence-based.
- Clearly separate verified tool evidence from inference.`;

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function getFunctionCalls(response) {
  return Array.isArray(response?.output) ? response.output.filter((item) => item?.type === "function_call") : [];
}

function getOutputText(response) {
  const explicit = cleanText(response?.output_text);
  if (explicit) {
    return explicit;
  }

  const parts = [];
  for (const item of response?.output || []) {
    if (item?.type === "message") {
      for (const content of item.content || []) {
        const text = cleanText(content?.text || content?.value);
        if (text) {
          parts.push(text);
        }
      }
    }
  }
  return parts.join("\n\n");
}

async function callResponsesApi({ input, tools = TOOL_DEFINITIONS, instructions = CUSTOM_AGENT_INSTRUCTIONS } = {}) {
  const apiKey = cleanOpenAiApiKey();
  if (!apiKey) {
    const error = new Error("OPENAI_API_KEY is not configured for the custom agent route.");
    error.statusCode = 503;
    error.code = "openai_api_key_missing";
    throw error;
  }

  const requestBody = {
    model: getModelName(),
    instructions,
    input,
    parallel_tool_calls: false,
  };

  if (Array.isArray(tools) && tools.length) {
    requestBody.tools = tools;
    requestBody.tool_choice = "auto";
  }

  const response = await fetch(RESPONSES_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(data?.error?.message || "OpenAI Responses API request failed.");
    error.statusCode = response.status;
    error.code = data?.error?.code || data?.error?.type || "openai_responses_failed";
    throw error;
  }

  return data;
}

async function runToolCall(call) {
  const name = cleanText(call?.name);
  const handler = TOOL_HANDLERS[name];

  if (!handler) {
    return {
      ok: false,
      error: {
        code: "tool_not_allowed",
        message: `Tool ${name || "unknown"} is not available on this custom agent route.`,
      },
    };
  }

  try {
    const args = parseJsonObject(call.arguments);
    return redactValue(await handler(args));
  } catch (error) {
    return {
      ok: false,
      error: makeSafeError(error, "Read-only tool call failed."),
    };
  }
}

async function runAgentTurn(message) {
  const input = [
    {
      role: "user",
      content: cleanText(message).slice(0, MAX_MESSAGE_CHARS),
    },
  ];
  const toolCalls = [];
  let response = null;

  for (let loop = 0; loop < MAX_TOOL_LOOPS; loop += 1) {
    response = await callResponsesApi({ input });
    const calls = getFunctionCalls(response);

    if (!calls.length) {
      break;
    }

    input.push(...(response.output || []));

    for (const call of calls) {
      const result = await runToolCall(call);
      toolCalls.push({ name: call.name, callId: call.call_id, result });
      input.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: JSON.stringify(result),
      });
    }
  }

  let answer = getOutputText(response);
  let finalResponse = response;

  if (!answer && toolCalls.length) {
    finalResponse = await callResponsesApi({
      input: [
        ...input,
        {
          role: "user",
          content:
            "Using only the read-only tool results already provided above, produce the final concise Garage Admin V2 operator answer now. Do not call tools. Clearly state any degraded or unverified evidence.",
        },
      ],
      tools: [],
      instructions: CUSTOM_AGENT_INSTRUCTIONS,
    });
    answer = getOutputText(finalResponse);
  }

  return {
    answer: answer || "The custom Garage Admin agent completed without returning text.",
    toolCalls,
    responseId: finalResponse?.id || response?.id || null,
  };
}

router.get("/status", (_req, res) => {
  const enabled = isCustomAgentEnabled();
  const apiKeyConfigured = Boolean(cleanOpenAiApiKey());

  res.json({
    ok: true,
    surface: "garage-admin-v2-custom-chatkit-agent",
    enabled,
    mode: enabled && apiKeyConfigured ? "configured" : "prep",
    model: getModelName(),
    apiKeyConfigured,
    intentionallyDisabled: [
      "service restarts",
      "action approvals",
      "file writes",
      "shell execution",
      "deployments",
      "memory mutation",
      "secret reads",
    ],
    tools: TOOL_DEFINITIONS.map((tool) => ({ name: tool.name, readOnly: true })),
  });
});

router.post(
  "/message",
  asyncRoute(async (req, res) => {
    if (!isCustomAgentEnabled()) {
      return res.status(503).json({
        ok: false,
        error: {
          code: "custom_agent_disabled",
          message: "Custom ChatKit agent route is disabled until CHATKIT_CUSTOM_AGENT_ENABLED=true or ChatKit experimental mode is enabled.",
        },
      });
    }

    const message = cleanText(req.body?.message);
    if (!message) {
      return res.status(400).json({
        ok: false,
        error: {
          code: "message_required",
          message: "message is required.",
        },
      });
    }

    try {
      const result = await runAgentTurn(message);
      return res.json({
        ok: true,
        surface: "garage-admin-v2-custom-chatkit-agent",
        answer: redactText(result.answer),
        toolCalls: result.toolCalls.map((call) => ({
          name: call.name,
          ok: call.result?.ok !== false,
          result: call.result,
        })),
        responseId: result.responseId,
      });
    } catch (error) {
      const safeError = makeSafeError(error);
      return res.status(error?.statusCode || 502).json({
        ok: false,
        surface: "garage-admin-v2-custom-chatkit-agent",
        error: safeError,
      });
    }
  }),
);

router.__testables = {
  cleanOpenAiApiKey,
  isCustomAgentEnabled,
  resolveMemoryPath,
  getFunctionCalls,
  getOutputText,
};

module.exports = router;
