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

export const FRESHNESS_WINDOWS_MS = Object.freeze({
  fresh: 2 * 60 * 1000,
  aging: 10 * 60 * 1000,
});

export const DEPENDENCY_FRESHNESS_WINDOWS_MS = FRESHNESS_WINDOWS_MS;

function readServiceLastCheckedAt(service) {
  return readText(
    service?.lastCheckedAt,
    service?.runtime?.lastCheckedAt,
    service?.health?.lastCheckedAt,
    service?.metadata?.lastCheckedAt,
    service?.inventory?.lastCheckedAt,
  );
}

function readServiceCheckedAt(service) {
  return readText(
    service?.checkedAt,
    service?.runtime?.checkedAt,
    service?.health?.checkedAt,
    service?.metadata?.checkedAt,
    service?.inventory?.checkedAt,
  );
}

function readServiceLastSeen(service) {
  return readText(service?.lastSeen, service?.metadata?.lastSeen, service?.inventory?.lastSeen);
}

function readServiceUpdatedAt(service) {
  return readText(
    service?.updatedAt,
    service?.runtime?.updatedAt,
    service?.health?.updatedAt,
    service?.metadata?.updatedAt,
    service?.inventory?.updatedAt,
  );
}

function readServiceHealthCheckedAt(service) {
  return readText(service?.healthCheckedAt, service?.health?.healthCheckedAt, service?.metadata?.healthCheckedAt);
}

function readServiceLocalHttpCheckedAt(service) {
  return readText(service?.health?.checks?.localHttp?.checkedAt);
}

function readServiceLocalPortCheckedAt(service) {
  return readText(service?.health?.checks?.localPort?.checkedAt);
}

const DEPENDENCY_FRESHNESS_TIMESTAMP_PRIORITY = Object.freeze([
  {
    key: "lastCheckedAt",
    read: readServiceLastCheckedAt,
  },
  {
    key: "checkedAt",
    read: readServiceCheckedAt,
  },
  {
    key: "lastSeen",
    read: readServiceLastSeen,
  },
  {
    key: "updatedAt",
    read: readServiceUpdatedAt,
  },
  {
    key: "healthCheckedAt",
    read: readServiceHealthCheckedAt,
  },
  {
    key: "localHttp.checkedAt",
    read: readServiceLocalHttpCheckedAt,
  },
  {
    key: "localPort.checkedAt",
    read: readServiceLocalPortCheckedAt,
  },
]);

const INVENTORY_FRESHNESS_SERVICE_LAST_CHECKED_AT_PRIORITY = Object.freeze([
  {
    key: "service.lastCheckedAt",
    read: readServiceLastCheckedAt,
  },
]);

const INVENTORY_FRESHNESS_SERVICE_LAST_SEEN_PRIORITY = Object.freeze([
  {
    key: "service.lastSeen",
    read: readServiceLastSeen,
  },
]);

const INVENTORY_FRESHNESS_SERVICE_FALLBACK_PRIORITY = Object.freeze([
  {
    key: "service.checkedAt",
    read: readServiceCheckedAt,
  },
  {
    key: "service.updatedAt",
    read: readServiceUpdatedAt,
  },
  {
    key: "service.healthCheckedAt",
    read: readServiceHealthCheckedAt,
  },
  {
    key: "service.localHttp.checkedAt",
    read: readServiceLocalHttpCheckedAt,
  },
  {
    key: "service.localPort.checkedAt",
    read: readServiceLocalPortCheckedAt,
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

function parseTimestampCandidate(source, timestamp) {
  const value = readText(timestamp);

  if (!value) {
    return null;
  }

  const parsedAt = Date.parse(value);

  if (!Number.isFinite(parsedAt)) {
    return null;
  }

  return {
    source,
    timestamp: value,
    parsedAt,
  };
}

function pickNewestTimestamp(candidates) {
  let newest = null;

  normalizeCollection(candidates).forEach((candidate) => {
    if (!Number.isFinite(candidate?.parsedAt)) {
      return;
    }

    if (!newest || candidate.parsedAt > newest.parsedAt) {
      newest = candidate;
    }
  });

  return (
    newest || {
      source: "",
      timestamp: null,
      parsedAt: null,
    }
  );
}

function resolveNewestServiceTimestamp(services, priority) {
  const candidates = [];

  normalizeObjectCollection(services).forEach((service) => {
    priority.forEach((candidate) => {
      const parsed = parseTimestampCandidate(candidate.key, candidate.read(service));

      if (parsed) {
        candidates.push(parsed);
      }
    });
  });

  return pickNewestTimestamp(candidates);
}

function resolveNewestSourceTimestamp(sources) {
  const candidates = [];

  Object.entries(toPlainObject(sources)).forEach(([sourceName, value]) => {
    if (!isPlainObject(value)) {
      return;
    }

    const parsed = parseTimestampCandidate(`sources.${sourceName}.checkedAt`, value.checkedAt);

    if (parsed) {
      candidates.push(parsed);
    }
  });

  return pickNewestTimestamp(candidates);
}

function formatFreshnessLabel(bucket) {
  return bucket === "unknown" ? "unknown freshness" : bucket;
}

function resolveFreshnessBucket(ageMs) {
  if (!Number.isFinite(ageMs)) {
    return "unknown";
  }

  if (ageMs <= FRESHNESS_WINDOWS_MS.fresh) {
    return "fresh";
  }

  if (ageMs <= FRESHNESS_WINDOWS_MS.aging) {
    return "aging";
  }

  return "stale";
}

function classifyFreshnessTimestampInfo(timestampInfo, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();

  if (!Number.isFinite(timestampInfo?.parsedAt)) {
    return {
      bucket: "unknown",
      ageMs: null,
      timestamp: null,
      timestampSource: "",
    };
  }

  const ageMs = Math.max(0, now - timestampInfo.parsedAt);

  return {
    bucket: resolveFreshnessBucket(ageMs),
    ageMs,
    timestamp: timestampInfo.timestamp,
    timestampSource: timestampInfo.source,
  };
}

export function classifyDependencyFreshness(service, options = {}) {
  const timestampInfo = resolveDependencyFreshnessTimestamp(service);
  const freshness = classifyFreshnessTimestampInfo(timestampInfo, options);

  return {
    ...freshness,
    label: formatFreshnessLabel(freshness.bucket),
  };
}

function resolveInventoryFreshnessTimestamp(payload, services) {
  const responseCheckedAt = parseTimestampCandidate("response.checkedAt", payload?.checkedAt);

  if (responseCheckedAt) {
    return responseCheckedAt;
  }

  const sourceCheckedAt = resolveNewestSourceTimestamp(payload?.sources);

  if (Number.isFinite(sourceCheckedAt.parsedAt)) {
    return sourceCheckedAt;
  }

  const lastCheckedAt = resolveNewestServiceTimestamp(services, INVENTORY_FRESHNESS_SERVICE_LAST_CHECKED_AT_PRIORITY);

  if (Number.isFinite(lastCheckedAt.parsedAt)) {
    return lastCheckedAt;
  }

  const lastSeen = resolveNewestServiceTimestamp(services, INVENTORY_FRESHNESS_SERVICE_LAST_SEEN_PRIORITY);

  if (Number.isFinite(lastSeen.parsedAt)) {
    return lastSeen;
  }

  return resolveNewestServiceTimestamp(services, INVENTORY_FRESHNESS_SERVICE_FALLBACK_PRIORITY);
}

function formatCompactAge(ageMs) {
  const totalSeconds = Math.max(0, Math.round(ageMs / 1000));

  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const totalMinutes = Math.round(ageMs / (60 * 1000));

  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }

  const totalHours = Math.round(ageMs / (60 * 60 * 1000));

  if (totalHours < 24) {
    return `${totalHours}h`;
  }

  const totalDays = Math.round(ageMs / (24 * 60 * 60 * 1000));
  return `${totalDays}d`;
}

function formatInventoryFreshnessLabel(bucket) {
  return bucket === "unknown" ? "Inventory freshness unknown" : `Inventory ${bucket}`;
}

function getInventoryFreshnessHint(bucket) {
  if (bucket === "stale") {
    return "Refresh inventory before acting.";
  }

  if (bucket === "unknown") {
    return "Inventory timestamp unavailable.";
  }

  return "";
}

export function classifyInventoryFreshness(payload, options = {}) {
  const services = Array.isArray(options.services) ? options.services : payload?.items;
  return classifyFreshnessTimestampInfo(resolveInventoryFreshnessTimestamp(payload, services), options);
}

export function describeInventoryFreshness(payload, options = {}) {
  const freshness = classifyInventoryFreshness(payload, options);
  const ageHint = Number.isFinite(freshness.ageMs) ? `checked ${formatCompactAge(freshness.ageMs)} ago` : "";
  const hint = getInventoryFreshnessHint(freshness.bucket);
  const label = formatInventoryFreshnessLabel(freshness.bucket);

  return {
    ...freshness,
    label,
    ageHint,
    hint,
    title: [label, ageHint, freshness.timestamp ? `Timestamp: ${freshness.timestamp}` : "", freshness.timestampSource ? `Timestamp source: ${freshness.timestampSource}` : "", hint]
      .filter(Boolean)
      .join(" · "),
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
