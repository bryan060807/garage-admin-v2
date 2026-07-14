const express = require("express");
const { getWorkers, getWorkerById, isFedoraLocalAdminProxyUrl, publicWorker } = require("../workerRegistry");

const router = express.Router();

const ALLOWED_TASKS = new Set([
  "ping_url",
  "git_status",
  "git_diff_stat",
  "node_check",
  "package_scripts",
  "pm2_jlist",
  "tail_file",
  "system_pulse",
  "templates",
  "systemd_status",
  "journal_tail",
  "podman_ps",
  "docker_ps",
  "ss_listeners",
  "systemd_list_units",
  "systemd_timers_safe",
  "podman_inspect_safe",
  "backup_artifacts_safe",
]);

const FEDORA_HELPER_UNREACHABLE_MESSAGE =
  "Fedora control-plane helper is unreachable from Windows. Check FEDORA_GARAGE_API_URL, FEDORA_GARAGE_API_KEY, and host reachability.";
const FEDORA_LOCAL_ADMIN_PROXY_MESSAGE =
  "Configured Fedora worker base URL points at the Fedora-local admin-proxy port 4000. From Windows, route through the existing reachable Garage helper/admin bridge base instead of direct port 4000 URLs such as 127.0.0.1:4000 or 192.168.1.187:4000.";

function redactError(value) {
  if (value == null) return value;

  return String(value)
    .replace(/(token|secret|password|credential|api[-_]?key)\s*[:=]\s*[^\s"'`]+/gi, "$1: <redacted>")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer <redacted>")
    .replace(/postgres(?:ql)?:\/\/[^:\s]+:[^@\s]+@/gi, "postgresql://<redacted>:<redacted>@");
}

function workerError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function requireWorker(id) {
  const worker = getWorkerById(id);
  if (!worker) {
    throw workerError(404, "worker_not_found", "Worker not found.");
  }

  const token = process.env[worker.authTokenEnv];
  if (!token) {
    throw workerError(503, "worker_auth_not_configured", `Auth token is not configured for worker ${id}.`);
  }

  return { worker, token };
}

function ensureLocalOrPrivateUrl(worker) {
  let parsed;
  try {
    parsed = new URL(worker.baseUrl);
  } catch {
    throw workerError(500, "invalid_worker_url", "Worker URL is invalid.");
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
    throw workerError(403, "worker_url_not_private", "Worker URL must be localhost or private network.");
  }

  if (worker.host === "fedora" && worker.transport === "fedora-admin-proxy" && isFedoraLocalAdminProxyUrl(worker.baseUrl)) {
    throw workerError(503, "fedora_admin_proxy_local_only", FEDORA_LOCAL_ADMIN_PROXY_MESSAGE);
  }
}

function getWorkerRequestPath(worker, kind) {
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

  throw workerError(500, "invalid_worker_request", "Unsupported worker request.");
}

async function callWorker(worker, token, kind, options = {}) {
  ensureLocalOrPrivateUrl(worker);

  const url = `${worker.baseUrl.replace(/\/$/, "")}${getWorkerRequestPath(worker, kind)}`;
  const headers = {
    [worker.authHeader || "x-worker-auth"]: token,
    ...(options.headers || {}),
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 12000);

  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers,
      body: options.body,
      signal: controller.signal,
    });

    const payload = await response.json().catch(() => ({
      ok: false,
      errorCode: "invalid_worker_response",
      error: "Worker did not return JSON.",
    }));

    return {
      httpStatus: response.status,
      ...payload,
    };
  } catch (error) {
    const isTimeout = error?.name === "AbortError";
    const isFedoraHelper = worker.transport === "fedora-garage-helper" || worker.transport === "fedora-admin-proxy";

    return {
      ok: false,
      errorCode: isTimeout ? "worker_timeout" : "worker_request_failed",
      error: isFedoraHelper && !isTimeout ? FEDORA_HELPER_UNREACHABLE_MESSAGE : redactError(error.message),
    };
  } finally {
    clearTimeout(timeout);
  }
}

router.get("/", (_req, res) => {
  res.json({
    ok: true,
    items: getWorkers().map(publicWorker),
  });
});

router.get("/:id/health", async (req, res, next) => {
  try {
    const { worker, token } = requireWorker(req.params.id);
    const result = await callWorker(worker, token, "health", { timeoutMs: 8000 });

    res.status(result.ok === false ? 502 : 200).json({
      ok: result.ok !== false,
      worker: publicWorker(worker),
      result,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/:id/capabilities", async (req, res, next) => {
  try {
    const { worker, token } = requireWorker(req.params.id);
    const result = await callWorker(worker, token, "capabilities", { timeoutMs: 8000 });

    res.status(result.ok === false ? 502 : 200).json({
      ok: result.ok !== false,
      worker: publicWorker(worker),
      result,
    });
  } catch (error) {
    next(error);
  }
});

router.post("/:id/jobs", async (req, res, next) => {
  try {
    const { worker, token } = requireWorker(req.params.id);
    const body = req.body || {};
    const taskType = String(body.taskType || "");

    if (!ALLOWED_TASKS.has(taskType)) {
      throw workerError(400, "unsupported_worker_task", "Unsupported worker task.");
    }

    const job = {
      jobId: body.jobId || `garage_worker_${Date.now()}`,
      taskType,
      targetHost: body.targetHost || worker.host,
      targetService: body.targetService || null,
      input: body.input || {},
    };

    const result = await callWorker(worker, token, "jobs", {
      method: "POST",
      timeoutMs: 30000,
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(job),
    });

    res.status(result.ok === false ? 422 : 200).json({
      ok: result.ok !== false,
      worker: publicWorker(worker),
      result,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
