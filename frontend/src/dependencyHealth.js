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

function buildDependencyTitle(label, statusInfo, endpoint, confidence, diagnosisLabel) {
  return [
    label,
    `Status: ${statusInfo.label}`,
    statusInfo.rawStatus && statusInfo.rawStatus !== statusInfo.label ? `Inventory status: ${statusInfo.rawStatus}` : "",
    endpoint ? `Endpoint: ${endpoint}` : "",
    confidence ? `Confidence: ${confidence}` : "",
    diagnosisLabel,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function buildDependencyHealthRollup(service, services, diagnosis = null) {
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

  const items = dependencies.map((dependency, index) => {
    const serviceId = readText(dependency.serviceId);
    const targetService = serviceId ? serviceIndex.get(serviceId.toLowerCase()) || null : null;
    const statusInfo = targetService ? getServiceDependencyStatus(targetService) : classifyDependencyStatus("unknown");
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
    const diagnosisLabel = diagnosisRelated
      ? statusInfo.bucket === "unknown"
        ? "Upstream status unknown"
        : "Related to current diagnosis"
      : "";

    counts[statusInfo.bucket] += 1;

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
      diagnosisRelated,
      diagnosisLabel,
      title: buildDependencyTitle(label, statusInfo, endpoint, confidence, diagnosisLabel),
    };
  });

  return {
    declaredCount: items.length,
    counts,
    items,
  };
}
