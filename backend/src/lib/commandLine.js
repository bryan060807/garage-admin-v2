const fs = require("fs");
const path = require("path");

const config = require("../config");
const windowsBridgeClient = require("./windowsBridgeClient");
const { getWorkerById, isFedoraLocalAdminProxyUrl, publicWorker } = require("../workerRegistry");
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

const FEDORA_OBSERVABILITY_WORKER_ID = "aibry-fedora-worker-agent";
const FEDORA_OBSERVABILITY_CONTAINER_OPTIONS = Object.freeze(["taskmaster-db", "pgadmin"]);
const WORKER_JOB_TIMEOUT_MS = 30000;
const FEDORA_LOCAL_ADMIN_PROXY_MESSAGE =
  "Configured Fedora worker base URL points at the Fedora-local admin-proxy port 4000. From Windows, route through the existing reachable Garage helper/admin bridge base instead of direct port 4000 URLs such as 127.0.0.1:4000 or 192.168.1.187:4000.";

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

function textFromValue(value) {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }

  if (value instanceof Error) {
    return value.message || value.name || "";
  }

  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }

  return String(value);
}

function readText(...values) {
  for (const value of values) {
    if (value == null) {
      continue;
    }

    const text = textFromValue(value).trim();
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
  if (worker.transport === "fedora-garage-helper" || worker.transport === "fedora-admin-proxy") {
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

  if (worker.host === "fedora" && worker.transport === "fedora-admin-proxy" && isFedoraLocalAdminProxyUrl(worker.baseUrl)) {
    throw commandError(503, "fedora_admin_proxy_local_only", FEDORA_LOCAL_ADMIN_PROXY_MESSAGE);
  }
}

function logWorkerDispatch(event, payload) {
  console.info(`[command-line] ${event}`, payload);
}

async function callWorkerJob(workerId, taskType, input = {}, context = {}) {
  const worker = getWorkerById(workerId);
  if (!worker) {
    throw commandError(404, "worker_not_found", `Worker ${workerId} is not registered.`);
  }

  const token = process.env[worker.authTokenEnv];
  if (!token) {
    throw commandError(503, "worker_auth_not_configured", `Worker auth is not configured for ${workerId}.`);
  }

  ensureLocalOrPrivateWorker(worker);

  const actionId = readText(context.actionId, "unknown");
  const route = createWorkerRequestPath(worker, "jobs");
  const startedMs = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), context.timeoutMs || WORKER_JOB_TIMEOUT_MS);

  logWorkerDispatch("dispatching worker job", {
    actionId,
    workerId,
    taskType,
    route,
  });

  try {
    const response = await fetch(`${worker.baseUrl.replace(/\/$/, "")}${route}`, {
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
      status: "failed",
      errorCode: "invalid_worker_response",
      error: "Worker did not return JSON.",
    }));
    const ok = response.ok !== false && response.status < 400 && payload.ok !== false;
    const durationMs = Date.now() - startedMs;
    const result = {
      httpStatus: response.status,
      workerId,
      taskType,
      durationMs,
      ...payload,
      ok,
      status: ok ? readText(payload.status, "completed") : "failed",
    };

    if (!ok) {
      result.ok = false;
      result.status = "failed";
      result.errorCode = readText(result.errorCode, `worker_http_${response.status}`);
      result.error = readText(result.error, result.message, "Worker job failed.");
      result.summary = readText(result.summary, result.error, "Worker job failed.");
    }

    logWorkerDispatch("worker job completed", {
      actionId,
      workerId,
      taskType,
      ok: result.ok !== false,
      status: result.status,
      durationMs,
      errorCode: result.errorCode || null,
    });

    return {
      worker: publicWorker(worker),
      result,
    };
  } catch (error) {
    const durationMs = Date.now() - startedMs;
    const isTimeout = error?.name === "AbortError";
    const result = {
      ok: false,
      status: "failed",
      summary: isTimeout ? "Worker request timed out." : "Worker request failed.",
      errorCode: isTimeout ? "worker_timeout" : "worker_request_failed",
      error: isTimeout ? "Worker request timed out." : redactText(error?.message || "Worker request failed."),
      workerId,
      taskType,
      durationMs,
    };

    logWorkerDispatch("worker job completed", {
      actionId,
      workerId,
      taskType,
      ok: false,
      status: result.status,
      durationMs,
      errorCode: result.errorCode,
    });

    return {
      worker: publicWorker(worker),
      result,
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

function summarizeFedoraObservabilityPayload(result, fallbackSummary) {
  if (!result || result.ok === false) {
    return summarizeWorkerPayload(result, fallbackSummary);
  }

  const data = toPlainObject(result.result || result.output || result.data || result);
  const items = toArray(data.items || data.listeners || data.units || data.timers || data.containers || data.artifacts || data.backups);
  if (items.length) {
    return `${items.length} records returned.`;
  }

  return summarizeWorkerPayload(result, fallbackSummary);
}

async function runFedoraObservabilityTask(actionId, taskType, input = {}, fallbackSummary = "Fedora observability task executed.") {
  const response = await callWorkerJob(FEDORA_OBSERVABILITY_WORKER_ID, taskType, input, { actionId });
  const ok = response.result.ok !== false;

  return {
    ok,
    status: ok ? "completed" : "failed",
    summary: summarizeFedoraObservabilityPayload(response.result, fallbackSummary),
    output: response,
    error: ok
      ? null
      : {
          code: readText(response.result.errorCode, "worker_job_failed"),
          message: readText(response.result.error, "Worker job failed."),
        },
  };
}

function sanitizeSummaryString(value) {
  return redactText(readText(value))
    .replace(/[A-Za-z]:\\[^\s"'`]+/g, "<redacted-path>")
    .replace(/(?:\/[A-Za-z0-9._-]+){2,}/g, "<redacted-path>");
}

function sanitizeSummaryValue(value, depth = 0) {
  if (depth > 6 || value == null) {
    return value == null ? value : undefined;
  }

  if (typeof value === "string") {
    return sanitizeSummaryString(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => sanitizeSummaryValue(entry, depth + 1))
      .filter((entry) => entry !== undefined);
  }

  if (typeof value !== "object") {
    return undefined;
  }

  const blockedKeys = new Set([
    "apikey",
    "body",
    "content",
    "contents",
    "credential",
    "credentials",
    "filepath",
    "filepaths",
    "password",
    "path",
    "paths",
    "raw",
    "root",
    "rootpath",
    "rootpaths",
    "roots",
    "secret",
    "secrets",
    "text",
    "token",
    "tokens",
  ]);

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entryValue]) => {
      const normalizedKey = String(key || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      if (!key || blockedKeys.has(normalizedKey)) {
        return [];
      }

      const sanitized = sanitizeSummaryValue(entryValue, depth + 1);
      return sanitized === undefined ? [] : [[key, sanitized]];
    }),
  );
}

function normalizeMemorySelfCheckOutput(result) {
  const data = toPlainObject(result.data);

  if (result.ok) {
    return {
      ok: true,
      service: readText(data.service, "windows-garage-api"),
      checkedAt: readText(data.checkedAt, result.checkedAt),
      activeMemory: sanitizeSummaryValue(toPlainObject(data.activeMemory)),
      safety: sanitizeSummaryValue(toPlainObject(data.safety)),
      summary: sanitizeSummaryString(data.summary || data.message),
    };
  }

  return {
    ok: false,
    service: "windows-garage-api",
    source: result.source,
    status: result.httpStatus,
    code: readText(result.error?.code, "bridge_request_failed"),
    message: sanitizeSummaryString(result.error?.message || "Memory self-check failed."),
  };
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

function getTerminalCapabilities() {
  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    modes: {
      actions: {
        available: true,
        routeFamily: "/api/command-line/run",
      },
      ssh: {
        available: false,
        configured: config.terminalSshEnabled === true,
        profiles: [
          {
            id: "fedora",
            label: "Fedora control-plane",
            host: "fedora",
            scope: "control-plane",
            available: false,
            reason:
              "SSH terminal is not configured on this host. Configure a server-side SSH profile; do not paste keys into the browser.",
          },
        ],
        reason:
          "SSH terminal is not configured on this host. Configure a server-side SSH profile; do not paste keys into the browser.",
      },
    },
    builtIns: ["help", "clear", "actions"],
    shortcuts: ["health", "status [serviceName]", "bridge", "pm2", "repos", "memory", "fedora", "containers", "ssh fedora"],
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
        const output = normalizeMemorySelfCheckOutput(result);

        return {
          ok: result.ok,
          summary: result.ok
            ? readText(output.summary, "Memory self-check completed.")
            : readText(output.message, "Memory self-check failed."),
          output,
          error: result.ok
            ? null
            : {
                code: readText(output.code, "memory_self_check_failed"),
                message: readText(output.message, "Memory self-check failed."),
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
      id: "fedora.observability.listeners",
      label: "Listener Inventory",
      description: "Collect Fedora socket/listener inventory through the managed read-only worker agent.",
      host: "fedora",
      scope: "control-plane",
      riskLevel: "safe",
      riskLabel: "Read-only",
      availability: getWorkerAvailability(FEDORA_OBSERVABILITY_WORKER_ID),
      routeFamily: `/api/workers/${FEDORA_OBSERVABILITY_WORKER_ID}/jobs`,
      async handler() {
        return runFedoraObservabilityTask("fedora.observability.listeners", "ss_listeners", {}, "Fedora listener inventory executed.");
      },
    },
    {
      id: "fedora.observability.systemd-units",
      label: "Systemd Service Inventory",
      description: "List Fedora systemd units through the managed read-only worker agent.",
      host: "fedora",
      scope: "control-plane",
      riskLevel: "safe",
      riskLabel: "Read-only",
      availability: getWorkerAvailability(FEDORA_OBSERVABILITY_WORKER_ID),
      routeFamily: `/api/workers/${FEDORA_OBSERVABILITY_WORKER_ID}/jobs`,
      async handler() {
        return runFedoraObservabilityTask("fedora.observability.systemd-units", "systemd_list_units", {}, "Fedora systemd unit inventory executed.");
      },
    },
    {
      id: "fedora.observability.systemd-timers",
      label: "Systemd Timers",
      description: "List Fedora systemd timers through the managed read-only worker agent.",
      host: "fedora",
      scope: "control-plane",
      riskLevel: "safe",
      riskLabel: "Read-only",
      availability: getWorkerAvailability(FEDORA_OBSERVABILITY_WORKER_ID),
      routeFamily: `/api/workers/${FEDORA_OBSERVABILITY_WORKER_ID}/jobs`,
      async handler() {
        return runFedoraObservabilityTask("fedora.observability.systemd-timers", "systemd_timers_safe", {}, "Fedora systemd timer inventory executed.");
      },
    },
    {
      id: "fedora.observability.podman-inspect",
      label: "Podman Container Inspect",
      description: "Inspect one allowlisted Fedora Podman container through the managed read-only worker agent.",
      host: "fedora",
      scope: "control-plane",
      riskLevel: "safe",
      riskLabel: "Read-only",
      availability: getWorkerAvailability(FEDORA_OBSERVABILITY_WORKER_ID),
      routeFamily: `/api/workers/${FEDORA_OBSERVABILITY_WORKER_ID}/jobs`,
      params: [
        {
          id: "containerName",
          label: "Allowlisted container",
          type: "select",
          required: true,
          description: "Fixed Fedora containers only. No arbitrary container names are accepted.",
          options: FEDORA_OBSERVABILITY_CONTAINER_OPTIONS.map((containerName) => ({
            value: containerName,
            label: containerName,
          })),
        },
      ],
      async handler(params) {
        const containerName = readText(params.containerName);
        if (!FEDORA_OBSERVABILITY_CONTAINER_OPTIONS.includes(containerName)) {
          throw commandError(400, "container_not_allowlisted", "Requested container is not allowlisted.", {
            containerName,
          });
        }

        return runFedoraObservabilityTask(
          "fedora.observability.podman-inspect",
          "podman_inspect_safe",
          { containerName },
          `Fedora Podman inspect executed for ${containerName}.`,
        );
      },
    },
    {
      id: "fedora.observability.backup-artifacts",
      label: "Backup Artifact Inventory",
      description: "List Fedora backup artifacts through the managed read-only worker agent.",
      host: "fedora",
      scope: "control-plane",
      riskLevel: "safe",
      riskLabel: "Read-only",
      availability: getWorkerAvailability(FEDORA_OBSERVABILITY_WORKER_ID),
      routeFamily: `/api/workers/${FEDORA_OBSERVABILITY_WORKER_ID}/jobs`,
      async handler() {
        return runFedoraObservabilityTask("fedora.observability.backup-artifacts", "backup_artifacts_safe", {}, "Fedora backup artifact inventory executed.");
      },
    },
    {
      id: "fedora.control-plane.ssh-terminal",
      label: "Fedora SSH Terminal",
      description: "Reserved for a future named-profile SSH terminal. No browser-supplied host/user/key input is accepted.",
      host: "fedora",
      scope: "control-plane",
      riskLevel: "caution",
      riskLabel: "Operator session",
      supported: false,
      disabledReason:
        "SSH terminal is not configured on this host. Configure a server-side SSH profile; do not paste keys into the browser.",
      availability: { available: false, code: "ssh_terminal_not_configured", message: "SSH terminal is not configured." },
      routeFamily: "future terminal session",
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
  FEDORA_OBSERVABILITY_CONTAINER_OPTIONS,
  FEDORA_OBSERVABILITY_WORKER_ID,
  getActionById,
  getTerminalCapabilities,
  listCommandActions,
  normalizeMemorySelfCheckOutput,
  runCommandAction,
  validateParams,
};
