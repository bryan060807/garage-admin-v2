const express = require("express");
const windowsBridgeClient = require("../lib/windowsBridgeClient");

const REQUEST_TIMEOUT_MS = 7000;
const ALLOWED_SERVICE_NAMES = new Set([
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
const HEALTH_SOURCE_EXPECTATIONS = Object.freeze({
  windowsAdmin: {
    logicalCheck: "windowsAdmin",
    expectedService: "windows-aibry-admin",
    expectedLabel: "Windows admin bridge",
  },
  windowsGaragePulse: {
    logicalCheck: "windowsGaragePulse",
    expectedService: "windows-garage-api",
    expectedLabel: "Windows garage API",
  },
  windowsGarageHealth: {
    logicalCheck: "windowsGarageHealth",
    expectedService: "windows-garage-api",
    expectedLabel: "Windows garage API",
  },
});

function asyncRoute(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (error) {
      next(error);
    }
  };
}

function apiError(statusCode, code, message, details = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.payload = {
    ok: false,
    code,
    message,
    ...details,
  };
  return error;
}

function toObject(value) {
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

function readNumber(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function readBoolean(...values) {
  for (const value of values) {
    if (typeof value === "boolean") {
      return value;
    }
  }

  return null;
}

function normalizeWarnings(value) {
  if (Array.isArray(value)) {
    return value.map((item) => readText(item)).filter(Boolean);
  }

  const text = readText(value);
  return text ? [text] : [];
}

function normalizeCapabilityEntries(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === "string") {
          const label = readText(entry);
          return label ? { label, enabled: true } : null;
        }

        const item = toObject(entry);
        const label = readText(item.label, item.name, item.id, item.key, item.action, item.capability);
        if (!label) {
          return null;
        }

        return {
          label,
          enabled: item.enabled !== false && item.supported !== false && item.available !== false && item.ok !== false,
          detail: readText(item.detail, item.description, item.reason),
        };
      })
      .filter(Boolean);
  }

  const item = toObject(value);
  const entries = Object.entries(item)
    .map(([key, entryValue]) => {
      if (typeof entryValue === "boolean") {
        return {
          label: key,
          enabled: entryValue,
          detail: "",
        };
      }

      const details = toObject(entryValue);
      const label = readText(details.label, details.name, key);
      return label
        ? {
            label,
            enabled: details.enabled !== false && details.supported !== false && details.available !== false && details.ok !== false,
            detail: readText(details.detail, details.description, details.reason),
          }
        : null;
    })
    .filter(Boolean);

  return entries;
}

function formatCommitSummary(commit) {
  const item = toObject(commit);
  if (!Object.keys(item).length) {
    return readText(commit);
  }

  return readText(
    item.summary,
    item.subject,
    item.message,
    [readText(item.hash, item.sha, item.shortSha), readText(item.author), readText(item.date, item.committedAt)]
      .filter(Boolean)
      .join(" · "),
  );
}

function normalizeRepoEntry(entry) {
  const item = toObject(entry);
  const lastCommit =
    item.lastCommit ||
    item.commit ||
    item.latestCommit ||
    item.headCommit ||
    item.last_commit ||
    item.latest_commit;
  const changedFileCount = readNumber(
    item.changedFileCount,
    item.changedFiles,
    item.changed,
    item.diffStat?.changedFiles,
    item.status?.changedFileCount,
  );
  const cleanValue = readBoolean(item.clean, item.isClean, item.status?.clean);
  const warnings = normalizeWarnings(item.warnings || item.warning || item.notes);
  const remote = item.remote || item.origin || item.upstream;
  const remoteObject = toObject(remote);

  return {
    name: readText(item.name, item.repoName, item.id, item.slug),
    path: readText(item.path, item.repoPath, item.root, item.cwd),
    branch: readText(item.branch, item.currentBranch, item.git?.branch),
    clean: cleanValue,
    dirty: cleanValue == null ? null : !cleanValue,
    changedFileCount,
    lastCommit: {
      summary: formatCommitSummary(lastCommit),
      hash: readText(lastCommit?.hash, lastCommit?.sha, lastCommit?.shortSha),
      author: readText(lastCommit?.author, lastCommit?.authorName),
      committedAt: readText(lastCommit?.date, lastCommit?.committedAt, lastCommit?.timestamp),
    },
    remote: {
      name: readText(remoteObject.name, remoteObject.remote, item.remoteName),
      url: readText(remoteObject.url, item.remoteUrl),
      branch: readText(remoteObject.branch, item.remoteBranch),
      display: readText(remoteObject.display, remoteObject.url, remoteObject.name, item.remote),
    },
    warnings,
    status: readText(item.status, item.state),
  };
}

function extractRepoItems(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  const data = toObject(payload);
  return toArray(data.items || data.repos || data.repositories || data.data);
}

function buildConfiguredTarget(result) {
  const target = toObject(result?.request?.configuredTarget);
  return {
    protocol: readText(target.protocol),
    host: readText(target.host),
    port: readText(target.port),
    basePath: readText(target.basePath),
    requestPath: readText(target.requestPath, result?.request?.pathname),
    display: readText(target.display),
  };
}

function buildObservedIdentity(payload) {
  const item = toObject(payload);
  return {
    service: readText(item.service, item.name, item.id, item.identity),
    bind: readText(item.bind, item.listen, item.address),
    host: readText(item.host),
    hostname: readText(item.hostname),
    platform: readText(item.platform),
  };
}

function buildIdentityDrift(expectation, observedIdentity, configuredTarget) {
  const expectedService = readText(expectation?.expectedService);
  const observedService = readText(observedIdentity?.service);

  if (!expectedService || !observedService || observedService === expectedService) {
    return {
      detected: false,
      code: "",
      message: "",
    };
  }

  const configuredDisplay = readText(configuredTarget?.display, configuredTarget?.host);
  const observedBind = readText(observedIdentity?.bind);
  const targetLabel = readText(expectation?.expectedLabel, expectedService);
  const suffix = [configuredDisplay ? `Configured target ${configuredDisplay}.` : "", observedBind ? `Reported bind ${observedBind}.` : ""]
    .filter(Boolean)
    .join(" ");

  return {
    detected: true,
    code: "service_identity_drift",
    message: `${targetLabel} expected ${expectedService} but target reported ${observedService}.${suffix ? ` ${suffix}` : ""}`,
  };
}

function normalizeHealthSource(result, kind, expectation = {}) {
  const payload = toObject(result.data);
  const configuredTarget = buildConfiguredTarget(result);
  const observedIdentity = buildObservedIdentity(payload);
  const drift = buildIdentityDrift(expectation, observedIdentity, configuredTarget);
  const warnings = drift.detected ? [drift.message] : [];

  return {
    ok: result.ok,
    source: result.source,
    kind,
    logicalCheck: readText(expectation.logicalCheck),
    checkedAt: result.checkedAt,
    latencyMs: result.latencyMs,
    httpStatus: result.httpStatus,
    status: readText(payload.status, payload.state, payload.health, result.ok ? "ok" : ""),
    summary: readText(payload.message, payload.summary, payload.statusText, result.ok ? "Read-only bridge check succeeded." : ""),
    configuredTarget,
    expectedIdentity: {
      service: readText(expectation.expectedService),
      label: readText(expectation.expectedLabel),
    },
    observedIdentity,
    identityMatchesExpected: observedIdentity.service
      ? readText(expectation.expectedService) === readText(observedIdentity.service)
      : null,
    drift,
    warnings,
    error: result.error,
    data: result.ok ? payload : null,
  };
}

function bridgeFailureResult(source, error) {
  return {
    ok: false,
    source,
    checkedAt: new Date().toISOString(),
    latencyMs: 0,
    httpStatus: error?.code === "bridge_base_url_missing" || error?.code === "bridge_auth_missing" ? 503 : 502,
    data: null,
    error: {
      code: error?.code || "bridge_request_failed",
      message: error?.message || "Bridge request failed.",
    },
  };
}

async function safeBridgeCheck(source, handler) {
  try {
    return await handler();
  } catch (error) {
    return bridgeFailureResult(source, error);
  }
}

function normalizeServiceStatus(serviceName, result) {
  const payload = toObject(result.data);
  const pm2 = toObject(payload.pm2 || payload.runtime || payload.process);
  const health = toObject(payload.health || payload.healthCheck || payload.checks);
  const capabilities = normalizeCapabilityEntries(
    payload.capabilities || payload.supportedCapabilities || payload.supportedActions || payload.actions,
  );

  return {
    ok: result.ok,
    source: result.source,
    checkedAt: result.checkedAt,
    latencyMs: result.latencyMs,
    httpStatus: result.httpStatus,
    service: serviceName,
    status: readText(payload.status, payload.state, pm2.status, health.status, health.state, result.ok ? "ok" : ""),
    pm2Status: readText(pm2.status, pm2.pm2Status, payload.pm2Status),
    pid: readNumber(pm2.pid, payload.pid),
    memory: readNumber(pm2.memory, pm2.memoryBytes, payload.memory, payload.memoryBytes),
    cpu: readNumber(pm2.cpu, pm2.cpuPercent, payload.cpu, payload.cpuPercent),
    healthStatus: readText(health.status, health.state, typeof health.ok === "boolean" ? (health.ok ? "healthy" : "unhealthy") : ""),
    summary: readText(payload.message, payload.summary, payload.detail, result.ok ? "Read-only service status loaded." : ""),
    capabilities: capabilities.filter((entry) => !/\brestart\b/i.test(entry.label)),
    approvalGatedCapabilities: [
      {
        label: "restart",
        enabled: false,
        detail: "Approval-gated via Service Actions only.",
      },
    ],
    error: result.error,
    data: result.ok ? payload : null,
  };
}

function normalizeRepoResponse(result, includeStatus = false) {
  const payload = toObject(result.data);
  const items = extractRepoItems(result.data).map(normalizeRepoEntry);
  const warningCount = items.reduce((count, item) => count + item.warnings.length, 0);

  return {
    ok: result.ok,
    source: result.source,
    checkedAt: result.checkedAt,
    latencyMs: result.latencyMs,
    httpStatus: result.httpStatus,
    includeStatus,
    count: items.length,
    warningCount,
    summary: readText(
      payload.message,
      payload.summary,
      result.ok
        ? includeStatus
          ? `${items.length} Windows repos with status loaded.`
          : `${items.length} Windows repos loaded.`
        : "",
    ),
    items,
    error: result.error,
    data: result.ok ? payload : null,
  };
}

function sanitizeSummaryString(value) {
  return readText(value)
    .replace(/(token|secret|password|credential|api[-_]?key)\s*[:=]\s*[^\s"'`]+/gi, "$1: <redacted>")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer <redacted>")
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
  const entries = Object.entries(value).flatMap(([key, entryValue]) => {
    const normalizedKey = String(key || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!key || blockedKeys.has(normalizedKey)) {
      return [];
    }

    const sanitized = sanitizeSummaryValue(entryValue, depth + 1);
    return sanitized === undefined ? [] : [[key, sanitized]];
  });

  return Object.fromEntries(entries);
}

function normalizeMemorySelfCheckResponse(result) {
  const payload = toObject(result.data);

  return {
    ok: true,
    service: readText(payload.service, "windows-garage-api"),
    checkedAt: readText(payload.checkedAt, result.checkedAt),
    activeMemory: sanitizeSummaryValue(toObject(payload.activeMemory)),
    safety: sanitizeSummaryValue(toObject(payload.safety)),
    summary: sanitizeSummaryString(payload.summary || payload.message),
  };
}

function normalizeMemorySelfCheckError(result) {
  return {
    ok: false,
    service: "windows-garage-api",
    source: result.source,
    status: result.httpStatus,
    code: readText(result?.error?.code, "bridge_request_failed"),
    message: sanitizeSummaryString(result?.error?.message || "Bridge request failed."),
  };
}

function upstreamStatusCode(result) {
  if (!result || result.ok) {
    return 200;
  }

  if (result.httpStatus >= 400 && result.httpStatus < 600) {
    return result.httpStatus === 404 ? 502 : result.httpStatus;
  }

  return 502;
}

function buildBridgeHealthPayload(adminHealth, garagePulse, garageHealth) {
  const windowsAdmin = normalizeHealthSource(adminHealth, "admin-health", HEALTH_SOURCE_EXPECTATIONS.windowsAdmin);
  const windowsGaragePulse = normalizeHealthSource(garagePulse, "pulse", HEALTH_SOURCE_EXPECTATIONS.windowsGaragePulse);
  const windowsGarageHealth = normalizeHealthSource(garageHealth, "admin-health", HEALTH_SOURCE_EXPECTATIONS.windowsGarageHealth);
  const sources = {
    windowsAdmin,
    windowsGaragePulse,
    windowsGarageHealth,
  };
  const warnings = Object.values(sources).flatMap((entry) => normalizeWarnings(entry.warnings));

  return {
    ok: adminHealth.ok && garagePulse.ok,
    partial:
      [adminHealth.ok, garagePulse.ok, garageHealth.ok].some(Boolean) &&
      ![adminHealth.ok, garagePulse.ok, garageHealth.ok].every(Boolean),
    checkedAt: new Date().toISOString(),
    warnings,
    sources,
  };
}

function createRouter(client = windowsBridgeClient) {
  const router = express.Router();

  router.get(
    "/health",
    asyncRoute(async (_req, res) => {
      const [adminHealth, garagePulse, garageHealth] = await Promise.all([
        safeBridgeCheck(client.WINDOWS_ADMIN_SOURCE, () =>
          client.getWindowsAdminHealth({ timeoutMs: REQUEST_TIMEOUT_MS }),
        ),
        safeBridgeCheck(client.WINDOWS_GARAGE_SOURCE, () =>
          client.getWindowsGaragePulse({ timeoutMs: REQUEST_TIMEOUT_MS }),
        ),
        safeBridgeCheck(client.WINDOWS_GARAGE_SOURCE, () =>
          client.getWindowsGarageHealth({ timeoutMs: REQUEST_TIMEOUT_MS }),
        ),
      ]);

      const payload = buildBridgeHealthPayload(adminHealth, garagePulse, garageHealth);

      const statusCode = adminHealth.ok || garagePulse.ok || garageHealth.ok ? 200 : 502;
      res.status(statusCode).json(payload);
    }),
  );

  router.get(
    "/services/:service/status",
    asyncRoute(async (req, res) => {
      const serviceName = readText(req.params.service);

      if (!ALLOWED_SERVICE_NAMES.has(serviceName)) {
        throw apiError(400, "service_not_allowlisted", "Requested service is not allowlisted for Windows bridge status.", {
          service: serviceName,
        });
      }

      const result = await client.getWindowsServiceStatus(serviceName, { timeoutMs: REQUEST_TIMEOUT_MS });
      const payload = normalizeServiceStatus(serviceName, result);

      res.status(upstreamStatusCode(result)).json(payload);
    }),
  );

  router.get(
    "/repos",
    asyncRoute(async (_req, res) => {
      const result = await client.getWindowsRepos(false, { timeoutMs: REQUEST_TIMEOUT_MS });
      const payload = normalizeRepoResponse(result, false);

      res.status(upstreamStatusCode(result)).json(payload);
    }),
  );

  router.get(
    "/repos/status",
    asyncRoute(async (_req, res) => {
      const result = await client.getWindowsRepos(true, { timeoutMs: REQUEST_TIMEOUT_MS });
      const payload = normalizeRepoResponse(result, true);

      res.status(upstreamStatusCode(result)).json(payload);
    }),
  );

  router.get(
    "/memory/self-check",
    asyncRoute(async (_req, res) => {
      const result = await client.getWindowsGarageMemorySelfCheck({ timeoutMs: REQUEST_TIMEOUT_MS });

      if (result.ok) {
        return res.status(200).json(normalizeMemorySelfCheckResponse(result));
      }

      return res.status(upstreamStatusCode(result)).json(normalizeMemorySelfCheckError(result));
    }),
  );

  router.use((error, _req, res, next) => {
    if (!error.statusCode || !error.payload) {
      if (error?.code === "bridge_base_url_missing" || error?.code === "bridge_auth_missing") {
        return res.status(503).json({
          ok: false,
          service: "windows-garage-api",
          code: error.code,
          message: error.message,
          source: error.source || "",
          status: 503,
        });
      }

      return next(error);
    }

    return res.status(error.statusCode).json(error.payload);
  });

  return router;
}

const router = createRouter();

module.exports = router;
module.exports.createRouter = createRouter;
module.exports.__testables = {
  HEALTH_SOURCE_EXPECTATIONS,
  buildBridgeHealthPayload,
  buildConfiguredTarget,
  buildIdentityDrift,
  buildObservedIdentity,
  normalizeMemorySelfCheckError,
  normalizeMemorySelfCheckResponse,
  normalizeHealthSource,
  sanitizeSummaryValue,
};
