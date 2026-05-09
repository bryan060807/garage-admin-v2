const DEFAULT_OPTIONS = {
  minHealthyUptimeSeconds: 30,
  flappingRestartThreshold: 5,
  highRestartThreshold: 20,
};

const EADDRINUSE_PATTERN = /\bEADDRINUSE\b|address already in use/i;
const ERRORED_PM2_STATUSES = new Set(["errored", "error", "stopped", "stopping", "offline"]);
const DEGRADED_PM2_STATUSES = new Set(["launching", "waiting restart", "one-launch-status"]);

function normalizeStatus(value) {
  return String(value || "").trim().toLowerCase() || "unknown";
}

function normalizeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeHints(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .map((entry) => String(entry || "").trim())
        .filter(Boolean),
    ),
  ).slice(0, 3);
}

function extractEaddrinuseHints(lines) {
  return normalizeHints(lines).filter((line) => EADDRINUSE_PATTERN.test(line));
}

function classifyPm2Health(snapshot, options = {}, previousSnapshot = null) {
  const mergedOptions = {
    ...DEFAULT_OPTIONS,
    ...options,
  };
  const pm2Status = normalizeStatus(snapshot?.pm2Status ?? snapshot?.status);
  const uptimeSeconds = normalizeNumber(snapshot?.uptimeSeconds);
  const restartCount = normalizeNumber(snapshot?.restartCount ?? snapshot?.restarts);
  const pid = normalizeNumber(snapshot?.pid);
  const port = normalizeNumber(snapshot?.port);
  const portOwnerPid = normalizeNumber(snapshot?.portOwnerPid);
  const previousRestartCount = normalizeNumber(previousSnapshot?.restartCount ?? previousSnapshot?.restarts);
  const lastErrorHints = normalizeHints(snapshot?.lastErrorHints);
  const eaddrinuseHints = extractEaddrinuseHints(lastErrorHints);
  const warnings = [];

  if (ERRORED_PM2_STATUSES.has(pm2Status)) {
    warnings.push(`PM2 reported ${pm2Status}.`);
  }

  if (
    pm2Status === "online" &&
    uptimeSeconds != null &&
    uptimeSeconds < mergedOptions.minHealthyUptimeSeconds &&
    restartCount != null &&
    restartCount >= mergedOptions.flappingRestartThreshold
  ) {
    warnings.push(
      `PM2 is online but uptime is only ${uptimeSeconds}s with ${restartCount} restarts.`,
    );
  }

  if (restartCount != null && restartCount >= mergedOptions.highRestartThreshold) {
    warnings.push(`Restart count is high (${restartCount}).`);
  }

  if (previousRestartCount != null && restartCount != null && restartCount > previousRestartCount) {
    warnings.push(`Restart count increased since the last observation (${previousRestartCount} -> ${restartCount}).`);
  }

  if (eaddrinuseHints.length > 0) {
    warnings.push("Recent PM2 logs show EADDRINUSE.");
  }

  if (port != null && portOwnerPid != null && pid != null && portOwnerPid !== pid) {
    warnings.push(`Port ${port} is held by PID ${portOwnerPid}, not the PM2 PID ${pid}.`);
  }

  let status = "unknown";

  if (ERRORED_PM2_STATUSES.has(pm2Status)) {
    status = "errored";
  } else if (warnings.length > 0 || DEGRADED_PM2_STATUSES.has(pm2Status)) {
    status = "degraded";
  } else if (pm2Status === "online") {
    status = "healthy";
  }

  return {
    status,
    warnings,
    lastErrorHints,
    restartCount,
    uptimeSeconds,
    pid,
    pm2Status: pm2Status || "unknown",
    port,
    portOwnerPid,
    restartCountIncreased: previousRestartCount != null && restartCount != null ? restartCount > previousRestartCount : false,
  };
}

module.exports = {
  classifyPm2Health,
  extractEaddrinuseHints,
};
