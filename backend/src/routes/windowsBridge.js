const express = require("express");
const windowsBridgeClient = require("../lib/windowsBridgeClient");

const router = express.Router();

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

function normalizeHealthSource(result, kind) {
  const payload = toObject(result.data);
  return {
    ok: result.ok,
    source: result.source,
    kind,
    checkedAt: result.checkedAt,
    latencyMs: result.latencyMs,
    httpStatus: result.httpStatus,
    status: readText(payload.status, payload.state, payload.health, result.ok ? "ok" : ""),
    summary: readText(payload.message, payload.summary, payload.statusText, result.ok ? "Read-only bridge check succeeded." : ""),
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

function upstreamStatusCode(result) {
  if (!result || result.ok) {
    return 200;
  }

  if (result.httpStatus >= 400 && result.httpStatus < 600) {
    return result.httpStatus === 404 ? 502 : result.httpStatus;
  }

  return 502;
}

router.get(
  "/health",
  asyncRoute(async (_req, res) => {
    const [adminHealth, garagePulse, garageHealth] = await Promise.all([
      safeBridgeCheck(windowsBridgeClient.WINDOWS_ADMIN_SOURCE, () =>
        windowsBridgeClient.getWindowsAdminHealth({ timeoutMs: REQUEST_TIMEOUT_MS }),
      ),
      safeBridgeCheck(windowsBridgeClient.WINDOWS_GARAGE_SOURCE, () =>
        windowsBridgeClient.getWindowsGaragePulse({ timeoutMs: REQUEST_TIMEOUT_MS }),
      ),
      safeBridgeCheck(windowsBridgeClient.WINDOWS_GARAGE_SOURCE, () =>
        windowsBridgeClient.getWindowsGarageHealth({ timeoutMs: REQUEST_TIMEOUT_MS }),
      ),
    ]);

    const payload = {
      ok: adminHealth.ok && garagePulse.ok,
      partial: [adminHealth.ok, garagePulse.ok, garageHealth.ok].some(Boolean) && ![adminHealth.ok, garagePulse.ok, garageHealth.ok].every(Boolean),
      checkedAt: new Date().toISOString(),
      sources: {
        windowsAdmin: normalizeHealthSource(adminHealth, "admin-health"),
        windowsGaragePulse: normalizeHealthSource(garagePulse, "pulse"),
        windowsGarageHealth: normalizeHealthSource(garageHealth, "admin-health"),
      },
    };

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

    const result = await windowsBridgeClient.getWindowsServiceStatus(serviceName, { timeoutMs: REQUEST_TIMEOUT_MS });
    const payload = normalizeServiceStatus(serviceName, result);

    res.status(upstreamStatusCode(result)).json(payload);
  }),
);

router.get(
  "/repos",
  asyncRoute(async (_req, res) => {
    const result = await windowsBridgeClient.getWindowsRepos(false, { timeoutMs: REQUEST_TIMEOUT_MS });
    const payload = normalizeRepoResponse(result, false);

    res.status(upstreamStatusCode(result)).json(payload);
  }),
);

router.get(
  "/repos/status",
  asyncRoute(async (_req, res) => {
    const result = await windowsBridgeClient.getWindowsRepos(true, { timeoutMs: REQUEST_TIMEOUT_MS });
    const payload = normalizeRepoResponse(result, true);

    res.status(upstreamStatusCode(result)).json(payload);
  }),
);

router.use((error, _req, res, next) => {
  if (!error.statusCode || !error.payload) {
    if (error?.code === "bridge_base_url_missing" || error?.code === "bridge_auth_missing") {
      return res.status(503).json({
        ok: false,
        code: error.code,
        message: error.message,
        source: error.source || "",
      });
    }

    return next(error);
  }

  return res.status(error.statusCode).json(error.payload);
});

module.exports = router;
