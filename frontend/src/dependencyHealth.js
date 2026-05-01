function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function toPlainObject(value) {
  return isPlainObject(value) ? value : {};
}

function normalizeCollection(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeObjectCollection(value) {
  return normalizeCollection(value).filter((item) => isPlainObject(item));
}

function readText(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) {
      return text;
    }
  }

  return "";
}

function normalizeStatus(value) {
  if (typeof value === "boolean") {
    return value ? "running" : "stopped";
  }

  const text = String(value || "").trim().toLowerCase();
  return text || "unknown";
}

export const DEPENDENCY_FRESHNESS_WINDOWS_MS = Object.freeze({
  fresh: 2 * 60 * 1000,
  aging: 10 * 60 * 1000,
});

const DEPENDENCY_FRESHNESS_TIMESTAMP_PRIORITY = Object.freeze([
  {
    key: "lastCheckedAt",
    read(service) {
      return readText(
        service?.lastCheckedAt,
        service?.runtime?.lastCheckedAt,
        service?.health?.lastCheckedAt,
        service?.metadata?.lastCheckedAt,
        service?.inventory?.lastCheckedAt,
      );
    },
  },
  {
    key: "checkedAt",
    read(service) {
      return readText(
        service?.checkedAt,
        service?.runtime?.checkedAt,
        service?.health?.checkedAt,
        service?.metadata?.checkedAt,
        service?.inventory?.checkedAt,
      );
    },
  },
  {
    key: "lastSeen",
    read(service) {
      return readText(service?.lastSeen, service?.metadata?.lastSeen, service?.inventory?.lastSeen);
    },
  },
  {
    key: "updatedAt",
    read(service) {
      return readText(
        service?.updatedAt,
        service?.runtime?.updatedAt,
        service?.health?.updatedAt,
        service?.metadata?.updatedAt,
        service?.inventory?.updatedAt,
      );
    },
  },
  {
    key: "healthCheckedAt",
    read(service) {
      return readText(service?.healthCheckedAt, service?.health?.healthCheckedAt, service?.metadata?.healthCheckedAt);
    },
  },
  {
    key: "localHttp.checkedAt",
    read(service) {
      return readText(service?.health?.checks?.localHttp?.checkedAt);
    },
  },
  {
    key: "localPort.checkedAt",
    read(service) {
      return readText(service?.health?.checks?.localPort?.checkedAt);
    },
  },
]);

function classifyDependencyStatus(status) {
  if (/^(running|online|healthy|ok|ready|supported|completed)$/.test(status)) {
    return {
      bucket: "healthy",
      label: "running",
      rawStatus: status,
    };
  }

  if (/^(warning|degraded|partial|timeout|attention|restarting|pending-env-or-not-started|needs-setup)$/.test(status)) {
    return {
      bucket: "warning",
      label: "warning",
      rawStatus: status,
    };
  }

  if (/^(failed|stopped|error|unreachable|offline|crashed|missing|disabled|inactive|paused)$/.test(status)) {
    return {
      bucket: "failed",
      label: "failed",
      rawStatus: status,
    };
  }

  return {
    bucket: "unknown",
    label: "unknown",
    rawStatus: status,
  };
}

function resolveDependencyFreshnessTimestamp(service) {
  for (const candidate of DEPENDENCY_FRESHNESS_TIMESTAMP_PRIORITY) {
    const timestamp = candidate.read(service);

    if (!timestamp) {
      continue;
    }

    const parsedAt = Date.parse(timestamp);

    if (!Number.isFinite(parsedAt)) {
      continue;
    }

    return {
      source: candidate.key,
      timestamp,
      parsedAt,
    };
  }

  return {
    source: "",
    timestamp: null,
    parsedAt: null,
  };
}

function formatFreshnessLabel(bucket) {
  return bucket === "unknown" ? "unknown freshness" : bucket;
}

export function classifyDependencyFreshness(service, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const timestampInfo = resolveDependencyFreshnessTimestamp(service);

  if (!Number.isFinite(timestampInfo.parsedAt)) {
    return {
      bucket: "unknown",
      label: formatFreshnessLabel("unknown"),
      ageMs: null,
      timestamp: null,
      timestampSource: "",
    };
  }

  const ageMs = Math.max(0, now - timestampInfo.parsedAt);
  const bucket =
    ageMs <= DEPENDENCY_FRESHNESS_WINDOWS_MS.fresh
      ? "fresh"
      : ageMs <= DEPENDENCY_FRESHNESS_WINDOWS_MS.aging
        ? "aging"
        : "stale";

  return {
    bucket,
    label: formatFreshnessLabel(bucket),
    ageMs,
    timestamp: timestampInfo.timestamp,
    timestampSource: timestampInfo.source,
  };
}

function getServiceDependencyStatus(service) {
  const directStatus = normalizeStatus(service?.status);
  if (directStatus !== "unknown") {
    return classifyDependencyStatus(directStatus);
  }

  const runtimeStatus = normalizeStatus(service?.runtime?.status);
  if (runtimeStatus !== "unknown") {
    return classifyDependencyStatus(runtimeStatus);
  }

  const healthStatus = normalizeStatus(readText(service?.health?.status, service?.health?.state, service?.health?.overall));
  if (healthStatus !== "unknown") {
    return classifyDependencyStatus(healthStatus);
  }

  const health = toPlainObject(service?.health);
  const localHttp = toPlainObject(health?.checks?.localHttp);
  const localPort = toPlainObject(health?.checks?.localPort);
  const localHttpChecked = Boolean(localHttp.checkedAt) || typeof localHttp.ok === "boolean";
  const localPortChecked = Boolean(localPort.checkedAt) || typeof localPort.ok === "boolean";

  if (health.ok === true || localHttp.ok === true || localPort.ok === true) {
    return {
      bucket: "healthy",
      label: "running",
      rawStatus: "ok",
    };
  }

  if (localHttpChecked && localHttp.ok === false && localPortChecked && localPort.ok === false) {
    return {
      bucket: "failed",
      label: "failed",
      rawStatus: "failed",
    };
  }

  if (health.ok === false || (localHttpChecked && localHttp.ok === false) || (localPortChecked && localPort.ok === false)) {
    return {
      bucket: "warning",
      label: "warning",
      rawStatus: "degraded",
    };
  }

  return {
    bucket: "unknown",
    label: "unknown",
    rawStatus: "unknown",
  };
}

function buildServiceIndex(services) {
  const index = new Map();

  normalizeObjectCollection(services).forEach((service) => {
    const serviceId = readText(service?.name, service?.serviceName);
    if (serviceId) {
      index.set(serviceId.toLowerCase(), service);
    }
  });

  return index;
}

function buildFreshnessSummary(counts, declaredCount) {
  if (!declaredCount) {
    return "unknown";
  }

  if (counts.stale > 0) {
    return `${counts.stale} stale`;
  }

  if (counts.aging > 0) {
    return `${counts.aging} aging`;
  }

  if (counts.unknown === declaredCount) {
    return "unknown";
  }

  if (counts.unknown > 0) {
    return `${counts.unknown} unknown`;
  }

  if (counts.fresh === declaredCount) {
    return "all fresh";
  }

  return "unknown";
}

function buildDependencyTitle(label, statusInfo, freshnessInfo, endpoint, confidence, diagnosisNotes) {
  return [
    label,
    `Status: ${statusInfo.label}`,
    freshnessInfo.bucket === "unknown" ? "Freshness: unknown" : `Freshness: ${freshnessInfo.label}`,
    freshnessInfo.timestamp ? `Timestamp: ${freshnessInfo.timestamp}` : "",
    freshnessInfo.timestampSource ? `Timestamp source: ${freshnessInfo.timestampSource}` : "",
    statusInfo.rawStatus && statusInfo.rawStatus !== statusInfo.label ? `Inventory status: ${statusInfo.rawStatus}` : "",
    endpoint ? `Endpoint: ${endpoint}` : "",
    confidence ? `Confidence: ${confidence}` : "",
    ...normalizeCollection(diagnosisNotes),
  ]
    .filter(Boolean)
    .join(" · ");
}

export function buildDependencyHealthRollup(service, services, diagnosis = null, options = {}) {
  const dependencies = normalizeObjectCollection(service?.dependencies).filter((dependency) =>
    Boolean(readText(dependency?.serviceId, dependency?.endpoint, dependency?.path)),
  );

  if (!dependencies.length) {
    return null;
  }

  const serviceIndex = buildServiceIndex(services);
  const diagnosisRelatedServiceId = readText(diagnosis?.relatedServiceId).toLowerCase();
  const counts = {
    healthy: 0,
    warning: 0,
    failed: 0,
    unknown: 0,
  };
  const freshnessCounts = {
    fresh: 0,
    aging: 0,
    stale: 0,
    unknown: 0,
  };

  const items = dependencies.map((dependency, index) => {
    const serviceId = readText(dependency.serviceId);
    const targetService = serviceId ? serviceIndex.get(serviceId.toLowerCase()) || null : null;
    const statusInfo = targetService ? getServiceDependencyStatus(targetService) : classifyDependencyStatus("unknown");
    const freshnessInfo = targetService ? classifyDependencyFreshness(targetService, options) : classifyDependencyFreshness(null, options);
    const label = readText(
      dependency.displayName,
      dependency.name,
      targetService?.displayName,
      targetService?.name,
      serviceId,
      dependency.endpoint,
      dependency.path,
      `Dependency ${index + 1}`,
    );
    const endpoint = readText(
      dependency.endpoint,
      targetService?.inventory?.localHealthUrl,
      targetService?.health?.url,
      targetService?.inventory?.localUrl,
      targetService?.health?.localUrl,
      targetService?.inventory?.publicUrl,
      targetService?.health?.publicUrl,
    );
    const confidence = readText(dependency.confidence);
    const diagnosisRelated = Boolean(diagnosisRelatedServiceId && serviceId && diagnosisRelatedServiceId === serviceId.toLowerCase());
    const diagnosisLabel = diagnosisRelated ? (statusInfo.bucket === "unknown" ? "Upstream status unknown" : "Related to current diagnosis") : "";
    const diagnosisFreshnessLabel = diagnosisRelated
      ? freshnessInfo.bucket === "stale"
        ? "Status may be stale. Refresh service inventory before acting."
        : freshnessInfo.bucket === "unknown"
          ? "Dependency status age unknown."
          : ""
      : "";

    counts[statusInfo.bucket] += 1;
    freshnessCounts[freshnessInfo.bucket] += 1;

    return {
      key: `${serviceId || label}-${endpoint || dependency.path || index}`.toLowerCase(),
      serviceId,
      hasInventoryService: Boolean(targetService),
      label,
      endpoint,
      confidence,
      status: statusInfo.label,
      statusBucket: statusInfo.bucket,
      rawStatus: statusInfo.rawStatus,
      freshness: freshnessInfo.bucket,
      freshnessLabel: freshnessInfo.label,
      freshnessTimestamp: freshnessInfo.timestamp,
      freshnessTimestampSource: freshnessInfo.timestampSource,
      diagnosisRelated,
      diagnosisLabel,
      diagnosisFreshnessLabel,
      title: buildDependencyTitle(label, statusInfo, freshnessInfo, endpoint, confidence, [
        diagnosisLabel,
        diagnosisFreshnessLabel,
      ]),
    };
  });

  return {
    declaredCount: items.length,
    counts,
    freshnessCounts,
    freshnessSummary: buildFreshnessSummary(freshnessCounts, items.length),
    items,
  };
}
