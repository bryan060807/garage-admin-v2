const { execFile } = require("child_process");
const net = require("net");
const { promisify } = require("util");
const config = require("../config");
const windowsInventory = require("./windowsInventory");

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 120000;
const DEFAULT_VERIFICATION_TIMEOUT_MS = 5000;
const MAX_VERIFICATION_TIMEOUT_MS = 10000;
const DEFAULT_LOG_LINES = 200;
const MAX_LOG_LINES = 500;
const OUTPUT_LIMIT = 12000;
const RESTART_COMMAND = "pm2 restart <allowlisted-process> --update-env";

function serviceKey(value) {
  return String(value || "").trim().toLowerCase();
}

function getWindowsRestartService(serviceName) {
  const definition = windowsInventory.getWindowsRuntimeDefinition(serviceName);

  if (!definition?.restartSupported) {
    return null;
  }

  return definition;
}

function isRestartSupported(serviceName) {
  return Boolean(getWindowsRestartService(serviceName));
}

function resolveTimeoutMs() {
  const configured = Number(config.windowsExecutorTimeoutMs);

  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }

  return Math.min(Math.max(Math.trunc(configured), 1000), MAX_TIMEOUT_MS);
}

function resolveVerificationTimeoutMs() {
  const configured = Number(config.windowsVerificationTimeoutMs);

  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_VERIFICATION_TIMEOUT_MS;
  }

  return Math.min(Math.max(Math.trunc(configured), 500), MAX_VERIFICATION_TIMEOUT_MS);
}

function resolveLogLines(value) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_LOG_LINES;
  }

  return Math.min(Math.max(Math.trunc(parsed), 20), MAX_LOG_LINES);
}

function limitOutput(value) {
  const text = String(value || "");

  if (text.length <= OUTPUT_LIMIT) {
    return {
      value: text,
      length: text.length,
      truncated: false,
    };
  }

  return {
    value: text.slice(text.length - OUTPUT_LIMIT),
    length: text.length,
    truncated: true,
  };
}

function outputFields(stdout, stderr) {
  const limitedStdout = limitOutput(stdout);
  const limitedStderr = limitOutput(stderr);

  return {
    stdout: limitedStdout.value,
    stderr: limitedStderr.value,
    stdoutLength: limitedStdout.length,
    stderrLength: limitedStderr.length,
    stdoutTruncated: limitedStdout.truncated,
    stderrTruncated: limitedStderr.truncated,
  };
}

function commandOptions(timeoutMs, maxBuffer = 1024 * 1024) {
  return {
    env: {
      ...process.env,
      NO_COLOR: "1",
    },
    maxBuffer,
    timeout: timeoutMs,
    windowsHide: true,
  };
}

function pm2Invocation(pm2Args) {
  if (process.platform !== "win32") {
    return {
      command: "pm2",
      args: pm2Args,
    };
  }

  return {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", ["pm2", ...pm2Args].join(" ")],
  };
}

function runPm2(pm2Args, timeoutMs, maxBuffer) {
  const invocation = pm2Invocation(pm2Args);

  return execFileAsync(invocation.command, invocation.args, commandOptions(timeoutMs, maxBuffer));
}

function errorMessage(error, fallback) {
  const limitedStderr = limitOutput(error?.stderr).value.trim();
  const limitedStdout = limitOutput(error?.stdout).value.trim();

  return limitedStderr || limitedStdout || error?.message || fallback;
}

function isPm2Unavailable(error, message) {
  const combined = `${error?.code || ""} ${error?.message || ""} ${error?.stderr || ""} ${error?.stdout || ""} ${message || ""}`
    .toLowerCase()
    .replace(/\s+/g, " ");

  return (
    error?.code === "ENOENT" ||
    combined.includes("not recognized as an internal or external command") ||
    combined.includes("pm2: command not found") ||
    combined.includes("cannot find path 'pm2'")
  );
}

function elapsedMs(startedAtMs) {
  return Date.now() - startedAtMs;
}

function resultPayload(base) {
  return {
    serviceName: base.serviceName || null,
    host: "windows",
    executor: "windows-local",
    manager: "pm2",
    processName: base.processName || null,
    command: base.command || null,
    startedAt: base.startedAt,
    completedAt: new Date().toISOString(),
    durationMs: elapsedMs(base.startedAtMs),
    timeoutMs: base.timeoutMs || resolveTimeoutMs(),
    verification: base.verification || null,
    ...base.extra,
  };
}

async function verifyHttpUrl(url, timeoutMs, kind = "http") {
  const checkedAt = new Date().toISOString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
    });

    clearTimeout(timeout);

    return {
      method: "http",
      kind,
      ok: response.ok,
      status: response.status,
      url,
      checkedAt,
      ...(response.ok ? {} : { error: `HTTP ${response.status}` }),
    };
  } catch (error) {
    clearTimeout(timeout);
    const causeMessage = String(error?.cause?.message || "").trim();

    return {
      method: "http",
      kind,
      ok: false,
      url,
      checkedAt,
      error: error.name === "AbortError" ? "Verification request timed out" : causeMessage || error.message,
    };
  }
}

async function verifyHttp(service, timeoutMs) {
  return verifyHttpUrl(service.healthUrl, timeoutMs, "health-url");
}

async function checkLocalPort(port, timeoutMs, host = "127.0.0.1") {
  const checkedAt = new Date().toISOString();

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    function finish(result) {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      resolve({
        method: "tcp",
        ok: result.ok,
        host,
        port,
        checkedAt,
        ...(result.ok ? {} : { error: result.error || "Port check failed" }),
      });
    }

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish({ ok: true }));
    socket.once("timeout", () => finish({ ok: false, error: "Port check timed out" }));
    socket.once("error", (error) => finish({ ok: false, error: error.message }));
    socket.connect(port, host);
  });
}

function parsePm2Status(payload, processName) {
  const processes = JSON.parse(payload);
  const match = Array.isArray(processes)
    ? processes.find((processInfo) => processInfo?.name === processName)
    : null;

  return match?.pm2_env?.status || null;
}

function parsePm2ProcessList(payload) {
  const processes = JSON.parse(payload);
  return Array.isArray(processes) ? processes : [];
}

function pm2ProcessSnapshot(processInfo, checkedAt) {
  const startedAtMs = Number(processInfo?.pm2_env?.pm_uptime);

  return {
    processName: String(processInfo?.name || "").trim() || null,
    status: processInfo?.pm2_env?.status || "unknown",
    checkedAt,
    pm2Status: processInfo?.pm2_env?.status || "unknown",
    pid: Number.isInteger(processInfo?.pid) ? processInfo.pid : null,
    pmId: Number.isInteger(processInfo?.pm_id) ? processInfo.pm_id : null,
    uptimeSeconds:
      Number.isFinite(startedAtMs) && startedAtMs > 0 ? Math.max(0, Math.round((Date.now() - startedAtMs) / 1000)) : null,
    startedAt:
      Number.isFinite(startedAtMs) && startedAtMs > 0 ? new Date(startedAtMs).toISOString() : null,
    restarts: Number.isInteger(processInfo?.pm2_env?.restart_time) ? processInfo.pm2_env.restart_time : null,
    memoryBytes: Number.isFinite(processInfo?.monit?.memory) ? processInfo.monit.memory : null,
    cpuPercent: Number.isFinite(processInfo?.monit?.cpu) ? processInfo.monit.cpu : null,
  };
}

async function getPm2ProcessStatuses(processNames = []) {
  const checkedAt = new Date().toISOString();
  const requestedNames = new Set(
    processNames
      .map((processName) => serviceKey(processName))
      .filter(Boolean),
  );

  try {
    const execution = await runPm2(["jlist"], resolveVerificationTimeoutMs(), 512 * 1024);
    const processes = parsePm2ProcessList(execution.stdout);
    const statuses = {};

    for (const processInfo of processes) {
      const processName = String(processInfo?.name || "").trim();
      const normalizedName = serviceKey(processName);

      if (!normalizedName) {
        continue;
      }

      if (requestedNames.size > 0 && !requestedNames.has(normalizedName)) {
        continue;
      }

      statuses[normalizedName] = pm2ProcessSnapshot(processInfo, checkedAt);
    }

    return {
      ok: true,
      checkedAt,
      statuses,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      checkedAt,
      statuses: {},
      error: errorMessage(error, "PM2 status query failed"),
    };
  }
}

async function getWindowsRuntimeSnapshot(runtimeDefinitions = []) {
  const definitions = Array.isArray(runtimeDefinitions) ? runtimeDefinitions.filter(Boolean) : [];
  const checkedAt = new Date().toISOString();
  const timeoutMs = resolveVerificationTimeoutMs();
  const pm2Snapshot = await getPm2ProcessStatuses(definitions.map((definition) => definition.processName));

  const services = {};
  const checks = await Promise.allSettled(
    definitions.map(async (definition) => {
      const checkUrl = definition.healthUrl || definition.localUrl || null;
      const localHttp = checkUrl
        ? await verifyHttpUrl(checkUrl, timeoutMs, definition.healthUrl ? "health-url" : "local-url")
        : null;
      const localPort = Number.isFinite(Number(definition.localPort))
        ? await checkLocalPort(Number(definition.localPort), timeoutMs)
        : null;

      return {
        key: serviceKey(definition.serviceName),
        checks: {
          localHttp,
          localPort,
        },
      };
    }),
  );

  for (const result of checks) {
    if (result.status !== "fulfilled") {
      continue;
    }

    services[result.value.key] = result.value.checks;
  }

  return {
    ok: pm2Snapshot.ok,
    checkedAt,
    pm2: pm2Snapshot,
    services,
    error: pm2Snapshot.error || null,
  };
}

async function verifyPm2(service, timeoutMs) {
  const checkedAt = new Date().toISOString();

  try {
    const execution = await runPm2(["jlist"], timeoutMs, 512 * 1024);
    const pm2Status = parsePm2Status(execution.stdout, service.processName);

    return {
      method: "pm2",
      ok: pm2Status === "online",
      pm2Status: pm2Status || "missing",
      checkedAt,
      ...(pm2Status === "online" ? {} : { error: pm2Status ? `PM2 status ${pm2Status}` : "PM2 process not found" }),
    };
  } catch (error) {
    return {
      method: "pm2",
      ok: false,
      checkedAt,
      error: errorMessage(error, "PM2 verification failed"),
    };
  }
}

async function verifyRestart(service) {
  const timeoutMs = resolveVerificationTimeoutMs();
  const verification = service.healthUrl ? await verifyHttp(service, timeoutMs) : await verifyPm2(service, timeoutMs);

  return {
    timeoutMs,
    verification,
  };
}

function unsupportedServiceResult(serviceName) {
  const normalizedServiceName = String(serviceName || "").trim();
  const message = `${normalizedServiceName || "Service"} is not allowlisted for Windows restart`;
  const startedAtMs = Date.now();

  return {
    ok: false,
    status: 409,
    data: resultPayload({
      serviceName: normalizedServiceName || null,
      startedAt: new Date(startedAtMs).toISOString(),
      startedAtMs,
      command: null,
      extra: {
        code: "restart_unsupported_service",
        message,
        supportedServices: windowsInventory
          .getWindowsRuntimeDefinitions()
          .filter((definition) => definition.restartSupported)
          .map((definition) => definition.serviceName),
      },
    }),
    error: message,
    executor: "windows-local",
  };
}

function unavailableResult(service) {
  const message = "Windows restart executor is only available on the Windows operator host";
  const startedAtMs = Date.now();

  return {
    ok: false,
    status: 503,
    data: resultPayload({
      serviceName: service.serviceName,
      processName: service.processName,
      startedAt: new Date(startedAtMs).toISOString(),
      startedAtMs,
      command: null,
      extra: {
        code: "windows_executor_unavailable",
        message,
        platform: process.platform,
      },
    }),
    error: message,
    executor: "windows-local",
  };
}

function logsUnavailableResult(serviceName, processName) {
  const message = "Windows log executor is only available on the Windows operator host";

  return {
    ok: false,
    status: 503,
    data: {
      ok: false,
      code: "windows_executor_unavailable",
      message,
      serviceName: serviceName || null,
      host: "windows",
      executor: "windows-local",
      manager: "pm2",
      processName: processName || null,
      logs: "",
    },
    error: message,
    executor: "windows-local",
  };
}

function unsupportedLogsResult(serviceName) {
  const message = `${serviceName || "Service"} is missing a Windows PM2 process name for log collection`;

  return {
    ok: false,
    status: 409,
    data: {
      ok: false,
      code: "logs_unsupported_service",
      message,
      serviceName: serviceName || null,
      host: "windows",
      executor: "windows-local",
      manager: "pm2",
      processName: null,
      reason: "The Windows PM2 process name is missing for this service.",
      suggestedSetupHint: "Missing log route",
      logs: "",
    },
    error: message,
    executor: "windows-local",
  };
}

async function getServiceLogs(serviceInput, options = {}) {
  const serviceName = String(serviceInput?.serviceName || "").trim();
  const processName = String(serviceInput?.processName || serviceName).trim();

  if (!processName) {
    return unsupportedLogsResult(serviceName);
  }

  if (process.platform !== "win32") {
    return logsUnavailableResult(serviceName, processName);
  }

  const timeoutMs = resolveTimeoutMs();
  const requestedLines = resolveLogLines(options.lines);

  try {
    const execution = await runPm2(
      ["logs", processName, "--lines", String(requestedLines), "--nostream"],
      timeoutMs,
      1024 * 1024,
    );
    const logs = [execution.stdout, execution.stderr].filter(Boolean).join("\n");

    return {
      ok: true,
      status: 200,
      data: {
        ok: true,
        code: "windows_logs_completed",
        message: `Fetched Windows PM2 logs for ${serviceName || processName}.`,
        serviceName: serviceName || null,
        host: "windows",
        executor: "windows-local",
        manager: "pm2",
        processName,
        requestedLines,
        logs,
        ...outputFields(execution.stdout, execution.stderr),
      },
      error: null,
      executor: "windows-local",
    };
  } catch (error) {
    const message = errorMessage(error, `${serviceName || processName} log collection failed through Windows PM2`);
    const pm2Unavailable = isPm2Unavailable(error, message);

    return {
      ok: false,
      status: pm2Unavailable ? 503 : 500,
      data: {
        ok: false,
        code: pm2Unavailable ? "windows_pm2_unavailable" : "windows_logs_failed",
        message,
        serviceName: serviceName || null,
        host: "windows",
        executor: "windows-local",
        manager: "pm2",
        processName,
        requestedLines,
        logs: [error.stdout, error.stderr].filter(Boolean).join("\n"),
        ...outputFields(error.stdout, error.stderr),
      },
      error: message,
      executor: "windows-local",
    };
  }
}

async function restartService(serviceName) {
  const service = getWindowsRestartService(serviceName);

  if (!service) {
    return unsupportedServiceResult(serviceName);
  }

  if (process.platform !== "win32") {
    return unavailableResult(service);
  }

  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const timeoutMs = resolveTimeoutMs();
  const basePayload = {
    serviceName: service.serviceName,
    processName: service.processName,
    command: RESTART_COMMAND,
    startedAt,
    startedAtMs,
    timeoutMs,
  };

  try {
    const execution = await runPm2(["restart", service.processName, "--update-env"], timeoutMs);
    const verification = await verifyRestart(service);

    return {
      ok: true,
      status: 200,
      data: resultPayload({
        ...basePayload,
        verification: verification.verification,
        extra: {
          code: "windows_restart_completed",
          message: `${service.serviceName} restart completed through Windows PM2`,
          exitCode: 0,
          signal: null,
          verificationTimeoutMs: verification.timeoutMs,
          ...outputFields(execution.stdout, execution.stderr),
        },
      }),
      error: null,
      executor: "windows-local",
    };
  } catch (error) {
    const timedOut = Boolean(error.killed || error.signal === "SIGTERM");
    const message = errorMessage(error, `${service.serviceName} restart failed through Windows PM2`);
    const pm2Unavailable = isPm2Unavailable(error, message);

    return {
      ok: false,
      status: timedOut ? 504 : pm2Unavailable ? 503 : 500,
      data: resultPayload({
        ...basePayload,
        extra: {
          code: timedOut ? "windows_restart_timeout" : pm2Unavailable ? "windows_pm2_unavailable" : "windows_restart_failed",
          message,
          exitCode: Number.isInteger(error.code) ? error.code : null,
          signal: error.signal || null,
          ...outputFields(error.stdout, error.stderr),
        },
      }),
      error: message,
      executor: "windows-local",
    };
  }
}

module.exports = {
  checkLocalPort,
  getServiceLogs,
  getWindowsRestartService,
  getPm2ProcessStatuses,
  getWindowsRuntimeSnapshot,
  isRestartSupported,
  restartService,
  verifyHttpUrl,
};
