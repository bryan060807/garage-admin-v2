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

function readServiceSourceName(service) {
  return readText(service?.name, service?.id, service?.serviceName, service?.slug);
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
    const parsed = parseTimestampCandidate(candidate.key, candidate.read(service));

    if (parsed) {
      return parsed;
    }
  }

  return {
    source: "",
    sourceType: "",
    sourceName: "",
    timestampField: "",
    timestamp: null,
    parsedAt: null,
  };
}

function inferTimestampSourceType(source) {
  if (source.startsWith("response.")) {
    return "response";
  }

  if (source.startsWith("sources.")) {
    return "source";
  }

  if (source.startsWith("service.")) {
    return "service";
  }

  return "";
}

function inferTimestampField(source, sourceType) {
  const parts = String(source || "")
    .split(".")
    .filter(Boolean);

  if (!parts.length) {
    return "";
  }

  if (sourceType === "response") {
    return parts.slice(1).join(".");
  }

  if (sourceType === "source") {
    return parts.slice(2).join(".");
  }

  if (sourceType === "service") {
    return parts.length > 2 ? parts.slice(2).join(".") : parts.slice(1).join(".");
  }

  return parts.slice(-1)[0];
}

function normalizeTimestampDescriptor(sourceDescriptor) {
  if (typeof sourceDescriptor === "string") {
    const sourceType = inferTimestampSourceType(sourceDescriptor);

    return {
      source: sourceDescriptor,
      sourceType,
      sourceName: "",
      timestampField: inferTimestampField(sourceDescriptor, sourceType),
    };
  }

  const descriptor = toPlainObject(sourceDescriptor);
  const source = readText(descriptor.source, descriptor.key);
  const sourceType = readText(descriptor.sourceType) || inferTimestampSourceType(source);

  return {
    source,
    sourceType,
    sourceName: readText(descriptor.sourceName),
    timestampField: readText(descriptor.timestampField) || inferTimestampField(source, sourceType),
  };
}

function parseTimestampCandidate(sourceDescriptor, timestamp) {
  const value = readText(timestamp);

  if (!value) {
    return null;
  }

  const parsedAt = Date.parse(value);

  if (!Number.isFinite(parsedAt)) {
    return null;
  }

  const descriptor = normalizeTimestampDescriptor(sourceDescriptor);

  return {
    source: descriptor.source,
    sourceType: descriptor.sourceType,
    sourceName: descriptor.sourceName,
    timestampField: descriptor.timestampField,
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
      sourceType: "",
      sourceName: "",
      timestampField: "",
      timestamp: null,
      parsedAt: null,
    }
  );
}

function resolveNewestServiceTimestamp(services, priority) {
  const candidates = [];

  normalizeObjectCollection(services).forEach((service) => {
    const sourceName = readServiceSourceName(service);

    priority.forEach((candidate) => {
      const timestampField = candidate.key.startsWith("service.") ? candidate.key.slice("service.".length) : candidate.key;
      const source = sourceName ? `service.${sourceName}.${timestampField}` : candidate.key;
      const parsed = parseTimestampCandidate(
        {
          source,
          sourceType: "service",
          sourceName,
          timestampField,
        },
        candidate.read(service),
      );

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

    const parsed = parseTimestampCandidate(
      {
        source: `sources.${sourceName}.checkedAt`,
        sourceType: "source",
        sourceName,
        timestampField: "checkedAt",
      },
      value.checkedAt,
    );

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
      ageLabel: "",
      timestamp: null,
      timestampSource: "",
      timestampSourceType: "unknown",
      timestampSourceName: "",
      timestampField: "",
      provenance: {
        sourceType: "unknown",
        sourceName: "",
        timestampField: "",
        timestamp: null,
        ageLabel: "",
        bucket: "unknown",
      },
    };
  }

  const ageMs = Math.max(0, now - timestampInfo.parsedAt);
  const bucket = resolveFreshnessBucket(ageMs);
  const ageLabel = formatCompactAge(ageMs);
  const source = readText(timestampInfo.source);
  const sourceType = readText(timestampInfo.sourceType) || inferTimestampSourceType(source) || "unknown";
  const sourceName = readText(timestampInfo.sourceName);
  const timestampField = readText(timestampInfo.timestampField) || inferTimestampField(source, sourceType);

  return {
    bucket,
    ageMs,
    ageLabel,
    timestamp: timestampInfo.timestamp,
    timestampSource: source,
    timestampSourceType: sourceType,
    timestampSourceName: sourceName,
    timestampField,
    provenance: {
      sourceType,
      sourceName,
      timestampField,
      timestamp: timestampInfo.timestamp,
      ageLabel,
      bucket,
    },
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
  const responseCheckedAt = parseTimestampCandidate(
    {
      source: "response.checkedAt",
      sourceType: "response",
      timestampField: "checkedAt",
    },
    payload?.checkedAt,
  );

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

function formatInventoryProvenanceText(freshness) {
  if (freshness.timestampSourceType === "response" && freshness.timestampField) {
    return `Based on response.${freshness.timestampField}`;
  }

  if (freshness.timestampSourceType === "source" && freshness.timestampSourceName && freshness.timestampField) {
    return `Based on sources.${freshness.timestampSourceName}.${freshness.timestampField}`;
  }

  if (freshness.timestampSourceType === "service" && freshness.timestampField) {
    return `Based on newest service ${freshness.timestampField}`;
  }

  return "Timestamp source unknown";
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

function readInventorySourceDisplayLabel(sourceName, metadata) {
  return readText(metadata?.displayName, metadata?.name, metadata?.label, sourceName);
}

function formatInventorySourceBucketLabel(bucket) {
  return bucket === "unknown" ? "unknown" : bucket;
}

function formatInventorySourceHintLabel(source) {
  if (source.bucket === "stale") {
    return `${source.displayLabel} inventory stale`;
  }

  return `${source.displayLabel} inventory timestamp unknown`;
}

function describeInventorySource(sourceName, value, options = {}) {
  const metadata = toPlainObject(value);
  const freshness = classifyFreshnessTimestampInfo(
    parseTimestampCandidate(
      {
        source: `sources.${sourceName}.checkedAt`,
        sourceType: "source",
        sourceName,
        timestampField: "checkedAt",
      },
      metadata.checkedAt,
    ),
    options,
  );
  const displayLabel = readInventorySourceDisplayLabel(sourceName, metadata);
  const status = readText(metadata.status);
  const ok = typeof metadata.ok === "boolean" ? metadata.ok : null;
  const error = readText(metadata.error);
  const compactLabel = `${displayLabel} ${formatInventorySourceBucketLabel(freshness.bucket)}`;

  return {
    key: sourceName,
    sourceKey: sourceName,
    displayLabel,
    checkedAt: freshness.timestamp,
    bucket: freshness.bucket,
    ageLabel: freshness.ageLabel,
    status,
    ok,
    error,
    compactLabel,
    title: [
      displayLabel,
      displayLabel !== sourceName ? `Source key: ${sourceName}` : "",
      freshness.bucket === "unknown" ? "Inventory timestamp unavailable" : `Freshness: ${formatInventorySourceBucketLabel(freshness.bucket)}`,
      freshness.ageLabel ? `Checked ${freshness.ageLabel} ago` : "",
      freshness.timestamp ? `Timestamp: ${freshness.timestamp}` : "",
      status ? `Status: ${status}` : "",
      ok == null ? "" : `OK: ${ok ? "yes" : "no"}`,
      error ? `Error: ${error}` : "",
    ]
      .filter(Boolean)
      .join(" | "),
  };
}

function buildInventorySourceHint(sourceBreakdown) {
  const affectedSources = normalizeCollection(sourceBreakdown).filter(
    (source) => source?.bucket === "stale" || source?.bucket === "unknown",
  );

  if (!affectedSources.length) {
    return {
      text: "",
      title: "",
    };
  }

  if (affectedSources.length <= 2) {
    const text = affectedSources.map((source) => formatInventorySourceHintLabel(source)).join(" | ");
    return {
      text,
      title: text,
    };
  }

  const staleCount = affectedSources.filter((source) => source.bucket === "stale").length;
  const unknownCount = affectedSources.filter((source) => source.bucket === "unknown").length;

  let text = "Some inventory sources may be stale";

  if (staleCount && unknownCount) {
    text = "Some inventory sources may be stale or have unknown timestamps";
  } else if (!staleCount && unknownCount) {
    text = "Some inventory sources have unknown timestamps";
  }

  return {
    text,
    title: affectedSources.map((source) => formatInventorySourceHintLabel(source)).join(" | "),
  };
}

function describeInventorySources(sources, options = {}) {
  const items = Object.entries(toPlainObject(sources)).map(([sourceName, value]) =>
    describeInventorySource(sourceName, value, options),
  );
  const summaryText = items.length ? `Sources: ${items.map((item) => item.compactLabel).join(" | ")}` : "Sources: unknown";
  const hint = buildInventorySourceHint(items);

  return {
    items,
    summaryText,
    title: items.length ? items.map((item) => item.title).filter(Boolean).join(" | ") : "No inventory sources declared",
    hint: hint.text,
    hintTitle: hint.title,
  };
}

export function classifyInventoryFreshness(payload, options = {}) {
  const services = Array.isArray(options.services) ? options.services : payload?.items;
  return classifyFreshnessTimestampInfo(resolveInventoryFreshnessTimestamp(payload, services), options);
}

export function describeInventoryFreshness(payload, options = {}) {
  const freshness = classifyInventoryFreshness(payload, options);
  const sourceBreakdown = describeInventorySources(payload?.sources, options);
  const ageHint = freshness.ageLabel ? `checked ${freshness.ageLabel} ago` : "";
  const hint = getInventoryFreshnessHint(freshness.bucket);
  const label = formatInventoryFreshnessLabel(freshness.bucket);
  const provenanceText = formatInventoryProvenanceText(freshness);

  return {
    ...freshness,
    label,
    ageHint,
    hint,
    provenanceText,
    sourceBreakdown: sourceBreakdown.items,
    sourceBreakdownSummary: sourceBreakdown.summaryText,
    sourceBreakdownTitle: sourceBreakdown.title,
    sourceHint: sourceBreakdown.hint,
    sourceHintTitle: sourceBreakdown.hintTitle,
    title: [label, ageHint, freshness.timestamp ? `Timestamp: ${freshness.timestamp}` : "", freshness.timestampSource ? `Timestamp source: ${freshness.timestampSource}` : "", provenanceText, hint]
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
