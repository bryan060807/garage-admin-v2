const fs = require("fs");
const path = require("path");

const config = require("../config");
const windowsBridgeClient = require("./windowsBridgeClient");
const { getWorkerById, publicWorker } = require("../workerRegistry");
const { redactText, redactValue } = require("./outputRedaction");

const WINDOWS_SERVICE_OPTIONS = Object.freeze([
  "garage-admin-v2",
  "windows-aibry-admin",
  "windows-node-agent",
  "windows-admin-proxy",
  "windows-garage-api",
  "taskmaster-api",
  "taskmaster-app",
  "trackmaster-api",
  "trackmaster-ui",
  "aibry-masterclass-landing",
  "chordmaster-api",
  "chordmaster-ui",
]);

function commandError(statusCode, code, message, details = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.details = details;
  return error;
}

function toPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function readText(...values) {
  for (const value of values) {
    if (value == null) {
      continue;
    }

    const text = String(value).trim();
    if (text) {
      return text;
    }
  }

  return "";
}

function getHealthPayload() {
  const frontendIndexPath = path.resolve(__dirname, "../../../frontend/dist/index.html");

  return {
    ok: true,
    service: "garage-admin-v2-backend",
    host: "windows",
    port: config.port,
    bind: `${config.host}:${config.port}`,
    databaseConfigured: Boolean(config.databaseUrl || config.databaseHost),
    frontendDistReady: fs.existsSync(frontendIndexPath),
  };
}

function createWorkerRequestPath(worker, kind) {
  if (worker.transport === "fedora-garage-helper") {
    return `/admin/fedora-workers/${worker.id}/${kind}`;
  }

  if (kind === "health") {
    return "/health";
  }

  if (kind === "capabilities") {
    return "/v1/capabilities";
  }

  if (kind === "jobs") {
    return "/v1/jobs";
  }

  throw commandError(500, "invalid_worker_request", "Unsupported worker request.");
}

function ensureLocalOrPrivateWorker(worker) {
  let parsed;
  try {
    parsed = new URL(worker.baseUrl);
  } catch {
    throw commandError(500, "invalid_worker_url", "Worker URL is invalid.");
  }

  const host = parsed.hostname.toLowerCase();
  const allowed =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.endsWith(".local") ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);

  if (!allowed) {
    throw commandError(403, "worker_url_not_private", "Worker URL must be localhost or private network.");
  }
}

async function callWorkerJob(workerId, taskType, input = {}) {
  const worker = getWorkerById(workerId);
  if (!worker) {
    throw commandError(404, "worker_not_found", `Worker ${workerId} is not registered.`);
  }

  const token = process.env[worker.authTokenEnv];
  if (!token) {
    throw commandError(503, "worker_auth_not_configured", `Worker auth is not configured for ${workerId}.`);
  }

  ensureLocalOrPrivateWorker(worker);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(`${worker.baseUrl.replace(/\/$/, "")}${createWorkerRequestPath(worker, "jobs")}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [worker.authHeader || "x-worker-auth"]: token,
      },
      body: JSON.stringify({
        jobId: `garage_command_${Date.now()}`,
        taskType,
        targetHost: worker.host,
        input,
      }),
      signal: controller.signal,
    });

    const payload = await response.json().catch(() => ({
      ok: false,
      errorCode: "invalid_worker_response",
      error: "Worker did not return JSON.",
    }));

    return {
      worker: publicWorker(worker),
      result: {
        httpStatus: response.status,
        ...payload,
      },
    };
  } catch (error) {
    return {
      worker: publicWorker(worker),
      result: {
        ok: false,
        errorCode: error?.name === "AbortError" ? "worker_timeout" : "worker_request_failed",
        error:
          error?.name === "AbortError"
            ? "Worker request timed out."
            : redactText(error?.message || "Worker request failed."),
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

function summarizeRepoStatus(payload) {
  const data = toPlainObject(payload);
  const items = toArray(data.items || data.repos || data.repositories || data.data);
  const cleanCount = items.filter((item) => item?.clean === true).length;
  const dirtyCount = items.filter((item) => item?.clean === false || item?.dirty === true).length;
  return `${items.length} repos checked, ${cleanCount} clean, ${dirtyCount} dirty.`;
}

function summarizeWorkerPayload(result, fallbackSummary) {
  return readText(
    result.summary,
    result.message,
    result.statusText,
    result.error,
    fallbackSummary,
  );
}

function getBridgeAvailability(kind) {
  if (kind === "windows-admin") {
    if (!config.windowsAdminBaseUrl || !config.windowsAdminAuthToken) {
      return {
        available: false,
        code: "windows_admin_bridge_not_configured",
        message: "Windows admin bridge base URL or auth is not configured.",
      };
    }
  }

  if (kind === "windows-garage") {
    if (!config.windowsGarageBaseUrl || !config.windowsGarageApiKey) {
      return {
        available: false,
        code: "windows_garage_bridge_not_configured",
        message: "Windows garage helper base URL or auth is not configured.",
      };
    }
  }

  return {
    available: true,
    code: "available",
    message: "",
  };
}

function getWorkerAvailability(workerId) {
  const worker = getWorkerById(workerId);
  if (!worker) {
    return {
      available: false,
      code: "worker_missing",
      message: `Worker ${workerId} is not registered.`,
    };
  }

  if (!process.env[worker.authTokenEnv]) {
    return {
      available: false,
      code: "worker_auth_missing",
      message: `${worker.name} auth is not configured server-side.`,
    };
  }

  return {
    available: true,
    code: "available",
    message: "",
  };
}

function publicAction(action) {
  return {
    id: action.id,
    label: action.label,
    description: action.description,
    host: action.host,
    scope: action.scope,
    riskLevel: action.riskLevel,
    riskLabel: action.riskLabel,
    supported: action.supported !== false,
    availability: action.availability.code,
    available: action.availability.available && action.supported !== false,
    availabilityMessage: action.supported === false ? action.disabledReason : action.availability.message,
    approvalRequired: action.approvalRequired === true,
    params: action.params || [],
    routeFamily: action.routeFamily || "",
  };
}

function buildActions() {
  return [
    {
      id: "windows.garage-admin.health",
      label: "Garage Admin V2 Health",
      description: "Inspect the current Windows operator backend health payload without leaving the console.",
      host: "windows",
      scope: "runtime/operator",
      riskLevel: "safe",
      riskLabel: "Read-only",
      availability: { available: true, code: "available", message: "" },
      routeFamily: "local backend",
      async handler() {
        const payload = getHealthPayload();
        return {
          ok: payload.ok !== false,
          summary: payload.ok ? "Garage Admin V2 backend is reporting healthy." : "Garage Admin V2 backend reported attention.",
          output: payload,
        };
      },
    },
    {
      id: "windows.bridge.health",
      label: "Windows Bridge Health",
      description: "Run the backend-mediated Windows admin bridge and Windows garage helper health checks.",
      host: "windows",
      scope: "runtime/operator",
      riskLevel: "safe",
      riskLabel: "Read-only",
      availability: (() => {
        const admin = getBridgeAvailability("windows-admin");
        const garage = getBridgeAvailability("windows-garage");
        if (!admin.available || !garage.available) {
          return {
            available: false,
            code: !admin.available ? admin.code : garage.code,
            message: !admin.available ? admin.message : garage.message,
          };
        }

        return { available: true, code: "available", message: "" };
      })(),
      routeFamily: "/api/windows-bridge/health",
      async handler() {
        const [windowsAdmin, windowsGaragePulse, windowsGarageHealth] = await Promise.all([
          windowsBridgeClient.getWindowsAdminHealth(),
          windowsBridgeClient.getWindowsGaragePulse(),
          windowsBridgeClient.getWindowsGarageHealth(),
        ]);
        const ok = windowsAdmin.ok || windowsGaragePulse.ok || windowsGarageHealth.ok;

        return {
          ok,
          summary: ok
            ? "Windows bridge health returned at least one healthy source."
            : "Windows bridge health checks all failed.",
          output: {
            sources: {
              windowsAdmin,
              windowsGaragePulse,
              windowsGarageHealth,
            },
          },
          error: ok
            ? null
            : {
                code: readText(
                  windowsAdmin.error?.code,
                  windowsGaragePulse.error?.code,
                  windowsGarageHealth.error?.code,
                  "windows_bridge_health_failed",
                ),
                message: readText(
                  windowsAdmin.error?.message,
                  windowsGaragePulse.error?.message,
                  windowsGarageHealth.error?.message,
                  "Windows bridge health checks failed.",
                ),
              },
        };
      },
    },
    {
      id: "windows.runtime.pm2.list",
      label: "Windows PM2 Process List",
      description: "Collect read-only PM2 inventory through the registered Windows runtime worker.",
      host: "windows",
      scope: "runtime",
      riskLevel: "safe",
      riskLabel: "Read-only",
      availability: getWorkerAvailability("windows-runtime"),
      routeFamily: "/api/workers/windows-runtime/jobs",
      async handler() {
        const response = await callWorkerJob("windows-runtime", "pm2_jlist");
        const ok = response.result.ok !== false;
        return {
          ok,
          summary: summarizeWorkerPayload(response.result, "PM2 list executed."),
          output: response,
          error: ok
            ? null
            : {
                code: readText(response.result.errorCode, "worker_job_failed"),
                message: readText(response.result.error, "Worker job failed."),
              },
        };
      },
    },
    {
      id: "windows.runtime.repo-status",
      label: "Windows Repo Status Summary",
      description: "Load the allowlisted Windows repository summary through the backend-mediated helper route.",
      host: "windows",
      scope: "runtime",
      riskLevel: "safe",
      riskLabel: "Read-only",
      availability: getBridgeAvailability("windows-garage"),
      routeFamily: "/api/windows-bridge/repos/status",
      async handler() {
        const result = await windowsBridgeClient.getWindowsRepos(true);
        return {
          ok: result.ok,
          summary: result.ok ? summarizeRepoStatus(result.data) : readText(result.error?.message, "Windows repo status failed."),
          output: result,
          error: result.ok
            ? null
            : {
                code: readText(result.error?.code, "windows_repo_status_failed"),
                message: readText(result.error?.message, "Windows repo status failed."),
              },
        };
      },
    },
    {
      id: "windows.runtime.memory-self-check",
      label: "Memory Self-Check",
      description: "Run the backend-mediated Windows memory self-check and return only the safe summary payload.",
      host: "windows",
      scope: "runtime",
      riskLevel: "safe",
      riskLabel: "Read-only",
      availability: getBridgeAvailability("windows-garage"),
      routeFamily: "/api/windows-bridge/memory/self-check",
      async handler() {
        const result = await windowsBridgeClient.getWindowsGarageMemorySelfCheck();
        const data = toPlainObject(result.data);

        return {
          ok: result.ok,
          summary: result.ok
            ? readText(data.summary, data.message, "Memory self-check completed.")
            : readText(result.error?.message, "Memory self-check failed."),
          output: result,
          error: result.ok
            ? null
            : {
                code: readText(result.error?.code, "memory_self_check_failed"),
                message: readText(result.error?.message, "Memory self-check failed."),
              },
        };
      },
    },
    {
      id: "windows.runtime.service-status",
      label: "Windows Service Status",
      description: "Inspect one allowlisted Windows service through the backend-mediated bridge status route.",
      host: "windows",
      scope: "runtime",
      riskLevel: "safe",
      riskLabel: "Read-only",
      availability: getBridgeAvailability("windows-admin"),
      routeFamily: "/api/windows-bridge/services/:service/status",
      params: [
        {
          id: "serviceName",
          label: "Allowlisted service",
          type: "select",
          required: true,
          description: "Windows runtime services exposed by the guarded backend route.",
          options: WINDOWS_SERVICE_OPTIONS.map((serviceName) => ({
            value: serviceName,
            label: serviceName,
          })),
        },
      ],
      async handler(params) {
        const serviceName = readText(params.serviceName);
        if (!WINDOWS_SERVICE_OPTIONS.includes(serviceName)) {
          throw commandError(400, "service_not_allowlisted", "Requested service is not allowlisted.", {
            serviceName,
          });
        }

        const result = await windowsBridgeClient.getWindowsServiceStatus(serviceName);
        return {
          ok: result.ok,
          summary: result.ok
            ? `Service status loaded for ${serviceName}.`
            : readText(result.error?.message, `Service status failed for ${serviceName}.`),
          output: result,
          error: result.ok
            ? null
            : {
                code: readText(result.error?.code, "windows_service_status_failed"),
                message: readText(result.error?.message, `Service status failed for ${serviceName}.`),
              },
        };
      },
    },
    {
      id: "fedora.control-plane.system-pulse",
      label: "Fedora System Pulse",
      description: "Collect the Fedora control-plane pulse through the registered infra worker.",
      host: "fedora",
      scope: "control-plane",
      riskLevel: "safe",
      riskLabel: "Read-only",
      availability: getWorkerAvailability("fedora-infra"),
      routeFamily: "/api/workers/fedora-infra/jobs",
      async handler() {
        const response = await callWorkerJob("fedora-infra", "system_pulse");
        const ok = response.result.ok !== false;
        return {
          ok,
          summary: summarizeWorkerPayload(response.result, "Fedora system pulse executed."),
          output: response,
          error: ok
            ? null
            : {
                code: readText(response.result.errorCode, "worker_job_failed"),
                message: readText(response.result.error, "Worker job failed."),
              },
        };
      },
    },
    {
      id: "fedora.control-plane.container-inventory",
      label: "Fedora Container Inventory",
      description: "List container runtime inventory through the registered infra worker.",
      host: "fedora",
      scope: "control-plane",
      riskLevel: "safe",
      riskLabel: "Read-only",
      availability: getWorkerAvailability("fedora-infra"),
      routeFamily: "/api/workers/fedora-infra/jobs",
      async handler() {
        const response = await callWorkerJob("fedora-infra", "podman_ps");
        const ok = response.result.ok !== false;
        return {
          ok,
          summary: summarizeWorkerPayload(response.result, "Fedora container inventory executed."),
          output: response,
          error: ok
            ? null
            : {
                code: readText(response.result.errorCode, "worker_job_failed"),
                message: readText(response.result.error, "Worker job failed."),
              },
        };
      },
    },
    {
      id: "fedora.control-plane.service-status",
      label: "Fedora Allowlisted Service Status",
      description: "Reserved for a future allowlisted Fedora service-status adapter.",
      host: "fedora",
      scope: "control-plane",
      riskLevel: "safe",
      riskLabel: "Read-only",
      supported: false,
      disabledReason: "Not wired in MVP. No narrow Fedora service-status adapter exists in this repo yet.",
      availability: { available: false, code: "unsupported", message: "Not wired in MVP." },
      routeFamily: "TODO",
    },
    {
      id: "fedora.control-plane.disk-ports-summary",
      label: "Fedora Disk / Ports Summary",
      description: "Reserved for a future read-only Fedora summary adapter.",
      host: "fedora",
      scope: "control-plane",
      riskLevel: "safe",
      riskLabel: "Read-only",
      supported: false,
      disabledReason: "Not wired in MVP. No existing narrow disk/ports summary route was found in this repo.",
      availability: { available: false, code: "unsupported", message: "Not wired in MVP." },
      routeFamily: "TODO",
    },
    {
      id: "windows.runtime.restart-service",
      label: "Restart Service",
      description: "Explicitly blocked here. Restarts remain in Service Actions and approval-gated workflows.",
      host: "windows",
      scope: "runtime",
      riskLevel: "caution",
      riskLabel: "Approval-gated",
      approvalRequired: true,
      supported: false,
      disabledReason: "Blocked in MVP. Use Service Actions for any restart workflow.",
      availability: { available: false, code: "approval_required", message: "Use Service Actions for restarts." },
      routeFamily: "Service Actions",
    },
  ];
}

function listCommandActions() {
  return buildActions().map(publicAction);
}

function getActionById(actionId) {
  return buildActions().find((action) => action.id === actionId) || null;
}

function validateParams(action, params = {}) {
  const input = toPlainObject(params);
  const validated = {};

  (action.params || []).forEach((param) => {
    const value = input[param.id];
    const text = typeof value === "string" ? value.trim() : value;

    if (param.required && (text == null || text === "")) {
      throw commandError(400, "missing_required_param", `${param.label || param.id} is required.`, {
        paramId: param.id,
      });
    }

    if (param.type === "select" && Array.isArray(param.options) && text) {
      const allowed = new Set(param.options.map((option) => option.value));
      if (!allowed.has(text)) {
        throw commandError(400, "invalid_param_option", `${param.label || param.id} is not allowlisted.`, {
          paramId: param.id,
        });
      }
    }

    validated[param.id] = text;
  });

  return validated;
}

async function runCommandAction(actionId, params = {}) {
  const action = getActionById(actionId);
  if (!action) {
    throw commandError(404, "command_action_not_found", "Command action was not found.", {
      actionId,
    });
  }

  if (action.approvalRequired) {
    throw commandError(403, "command_action_requires_approval", "State-changing actions remain approval-gated and are not executable from this MVP.", {
      actionId,
    });
  }

  if (action.supported === false) {
    throw commandError(409, "command_action_not_supported", action.disabledReason || "Command action is not supported in MVP.", {
      actionId,
    });
  }

  if (!action.availability.available) {
    throw commandError(409, "command_action_not_available", action.availability.message || "Command action is not currently available.", {
      actionId,
      availability: action.availability.code,
    });
  }

  const validatedParams = validateParams(action, params);
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const execution = await action.handler(validatedParams);
  const completedAt = new Date().toISOString();

  return redactValue({
    ok: execution.ok !== false,
    status: execution.ok === false ? "failed" : "completed",
    exitStatus: execution.ok === false ? "failed" : "ok",
    action: publicAction(action),
    params: validatedParams,
    startedAt,
    completedAt,
    durationMs: Date.now() - startedMs,
    summary: readText(execution.summary, action.description),
    output: execution.output ?? null,
    stdout: execution.stdout ? redactText(execution.stdout) : null,
    stderr: execution.stderr ? redactText(execution.stderr) : null,
    error: execution.ok === false
      ? {
          code: readText(execution.error?.code, "command_action_failed"),
          message: readText(execution.error?.message, "Command action failed."),
        }
      : null,
  });
}

module.exports = {
  WINDOWS_SERVICE_OPTIONS,
  commandError,
  getActionById,
  listCommandActions,
  runCommandAction,
  validateParams,
};
