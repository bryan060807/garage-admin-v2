const bridgeClient = require("./bridgeClient");
const repository = require("./repository");
const config = require("../config");
const { classifyDatabaseError } = require("../db");
const { redactText } = require("./outputRedaction");
const windowsExecutor = require("./windowsExecutor");
const windowsInventory = require("./windowsInventory");

const PRIORITY_SERVICES = [
  "aibry-admin",
  "aibry-website-api",
  "aibry-website",
  "taskmaster-api",
  "taskmaster-app",
  "chordmaster-api",
  "chordmaster-app",
  "garage-admin-v2",
  "aibry-masterclass-landing",
  "trackmaster-api",
  "trackmaster-ui",
  "trackmaster-comparator",
  "aibry-worker-agent",
  "windows-aibry-admin",
  "windows-node-agent",
  "windows-admin-proxy",
  "windows-garage-api",
];

const BRIDGE_BASELINE_SERVICES = ["aibry-admin"];
const REJECTED_SERVICE_NAMES = new Set(["", "none", "null", "undefined", "unknown", "unassigned"]);
const SERVICE_HOSTS = {
  "aibry-admin": "fedora",
  "admin-proxy": "fedora",
  "node-agent": "fedora",
  "trackmaster-api": "windows",
  "trackmaster-ui": "windows",
};

const SERVICE_GROUP_LABELS = {
  api: "API",
  "ui-apps": "UI & Apps",
  admin: "Admin",
  infrastructure: "Infrastructure",
};

const KNOWN_SERVICE_CLASSIFICATIONS = {
  "aibry-admin": {
    groupKey: "admin",
    type: "Bridge",
  },
  "admin-proxy": {
    groupKey: "admin",
    type: "Control Proxy",
  },
  "node-agent": {
    groupKey: "admin",
    type: "Node Agent",
  },
  "taskmaster-api": {
    groupKey: "api",
    type: "API",
  },
  "taskmaster-app": {
    groupKey: "ui-apps",
    type: "UI",
  },
  "chordmaster-api": {
    groupKey: "api",
    type: "API",
  },
  "chordmaster-app": {
    groupKey: "ui-apps",
    type: "UI",
  },
  "garage-admin-v2": {
    groupKey: "ui-apps",
    type: "Operator Console",
  },
  "aibry-masterclass-landing": {
    groupKey: "ui-apps",
    type: "UI",
  },
  "trackmaster-comparator": {
    groupKey: "ui-apps",
    type: "UI",
  },
  "trackmaster-api": {
    groupKey: "api",
    type: "API",
  },
  "trackmaster-ui": {
    groupKey: "ui-apps",
    type: "UI",
  },
  "aibry-website-api": {
    groupKey: "api",
    type: "API",
  },
  "aibry-website": {
    groupKey: "ui-apps",
    type: "UI",
  },
  "aibry-worker-agent": {
    groupKey: "admin",
    type: "Worker Agent",
  },
  "windows-aibry-admin": {
    groupKey: "admin",
    type: "Admin Bridge",
  },
  "windows-node-agent": {
    groupKey: "admin",
    type: "Node Agent",
  },
  "windows-admin-proxy": {
    groupKey: "admin",
    type: "Admin Proxy",
  },
  "windows-garage-api": {
    groupKey: "admin",
    type: "Garage API",
  },
  "taskmaster-db": {
    groupKey: "infrastructure",
    type: "Database",
  },
};

const KNOWN_SERVICE_HINTS = {
  "aibry-admin": {
    provides: [
      {
        kind: "fedora-bridge",
        notes: "Fedora-hosted bridge service exposed through the control-plane.",
      },
    ],
  },
  "admin-proxy": {
    provides: [
      {
        kind: "control-plane",
        endpoint: "http://127.0.0.1:4000",
        healthEndpoint: "http://127.0.0.1:4000/admin/health",
        paths: ["/admin/health", "/admin/services", "/admin/service-discovery", "/admin/status"],
        notes: "Local control-plane proxy used by the Garage Admin bridge client fallback.",
      },
    ],
  },
  "garage-admin-v2": {
    dependencies: [
      {
        serviceId: "admin-proxy",
        relationship: "control-plane-path",
        endpoint: "http://127.0.0.1:4000/admin/health",
        required: true,
        confidence: "authoritative",
        notes: "Backend bridge client falls back to the local admin-proxy health path.",
      },
    ],
  },
};

for (const definition of windowsInventory.getWindowsRuntimeDefinitions()) {
  SERVICE_HOSTS[serviceKey(definition.serviceName)] = "windows";

  for (const alias of definition.aliases || []) {
    SERVICE_HOSTS[serviceKey(alias)] = "windows";
  }
}

const STATIC_SERVICE_INVENTORY = [
  {
    name: "aibry-admin",
    displayName: "AIBRY Admin",
    host: "fedora",
    source: "inventory",
    hasLogs: true,
    metadata: {
      role: "control-plane",
      serviceGroup: "admin",
      serviceType: "Bridge",
    },
    runtime: {
      status: "unknown",
      source: "inventory",
    },
  },
  ...windowsInventory.getWindowsRuntimeDefinitions().map((definition) => ({
    name: definition.serviceName,
    displayName: definition.displayName,
    host: definition.host,
    source: "inventory",
    hasLogs: Boolean(definition.logsSupported),
    provides: Array.isArray(definition.provides) ? definition.provides : [],
    dependencies: Array.isArray(definition.dependencies) ? definition.dependencies : [],
    inventory: {
      id: definition.id,
      displayName: definition.displayName,
      host: definition.host,
      manager: definition.manager,
      processName: definition.processName,
      localPort: definition.localPort || null,
      localUrl: definition.localUrl || null,
      localHealthUrl: definition.healthUrl || null,
      localReadinessUrl: definition.readinessUrl || null,
      publicUrl: definition.publicUrl || null,
      notes: definition.notes || [],
    },
    metadata: compactObject({
      serviceGroup: definition.serviceGroup || null,
      serviceType: definition.serviceType || null,
    }) || undefined,
    health: {
      url: definition.healthUrl || null,
      readinessUrl: definition.readinessUrl || null,
      localUrl: definition.localUrl || null,
      publicUrl: definition.publicUrl || null,
    },
    runtime: {
      status: "unknown",
      source: "inventory",
      manager: definition.manager,
      processName: definition.processName,
    },
  })),
];

function normalizeServiceName(value) {
  const name = String(value || "")
    .trim()
    .replace(/\s+/g, " ");

  if (!name || REJECTED_SERVICE_NAMES.has(name.toLowerCase())) {
    return "";
  }

  return name;
}

function serviceKey(value) {
  return normalizeServiceName(value).toLowerCase();
}

function normalizeSource(value) {
  const source = String(value || "inventory")
    .trim()
    .toLowerCase();

  return source || "inventory";
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function pickString(source, keys) {
  if (!source || typeof source !== "object") {
    return "";
  }

  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

function pickBoolean(source, keys, fallback) {
  if (!source || typeof source !== "object") {
    return fallback;
  }

  for (const key of keys) {
    const value = source[key];
    if (typeof value === "boolean") {
      return value;
    }
  }

  return fallback;
}

function pickNumber(source, keys, fallback) {
  if (!source || typeof source !== "object") {
    return fallback;
  }

  for (const key of keys) {
    const value = source[key];
    const parsed = Number(value);

    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return fallback;
}

function compactObject(value) {
  if (!isObject(value)) {
    return null;
  }

  const entries = Object.entries(value).filter(([, entryValue]) => {
    if (entryValue == null) {
      return false;
    }

    if (typeof entryValue === "string" && !entryValue.trim()) {
      return false;
    }

    if (isObject(entryValue) && Object.keys(entryValue).length === 0) {
      return false;
    }

    return true;
  });

  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function createCapability(input) {
  if (!isObject(input)) {
    return null;
  }

  return (
    compactObject({
      supported: typeof input.supported === "boolean" ? input.supported : null,
      executor: pickString(input, ["executor"]) || null,
      mode: pickString(input, ["mode"]) || null,
      reason: pickString(input, ["reason", "message"]) || null,
      setupHint: pickString(input, ["setupHint", "setup_hint"]) || null,
    }) || null
  );
}

function createCapabilities(input) {
  if (!isObject(input)) {
    return {};
  }

  return (
    compactObject({
      logs: createCapability(input.logs),
      health: createCapability(input.health),
      restart: createCapability(input.restart),
    }) || {}
  );
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(new Set(value.map((entry) => String(entry || "").trim()).filter(Boolean)));
}

function createProvide(input) {
  if (!isObject(input)) {
    return null;
  }

  const paths = normalizeStringArray(input.paths);
  return (
    compactObject({
      kind: pickString(input, ["kind"]) || null,
      endpoint: pickString(input, ["endpoint"]) || null,
      healthEndpoint: pickString(input, ["healthEndpoint", "health_endpoint"]) || null,
      readinessEndpoint: pickString(input, ["readinessEndpoint", "readiness_endpoint"]) || null,
      publicHost: pickString(input, ["publicHost", "public_host"]) || null,
      paths: paths.length > 0 ? paths : null,
      notes: pickString(input, ["notes"]) || null,
    }) || null
  );
}

function createProvides(input) {
  if (!Array.isArray(input)) {
    return [];
  }

  return input.map(createProvide).filter(Boolean);
}

function createDependency(input) {
  if (!isObject(input)) {
    return null;
  }

  return (
    compactObject({
      serviceId: pickString(input, ["serviceId", "service_id"]) || null,
      relationship: pickString(input, ["relationship"]) || null,
      endpoint: pickString(input, ["endpoint"]) || null,
      required: pickBoolean(input, ["required"], null),
      confidence: pickString(input, ["confidence"]) || null,
      notes: pickString(input, ["notes"]) || null,
    }) || null
  );
}

function createDependencies(input) {
  if (!Array.isArray(input)) {
    return [];
  }

  return input.map(createDependency).filter(Boolean);
}

function provideSignature(value) {
  return [
    pickString(value, ["kind"]),
    pickString(value, ["endpoint"]),
    pickString(value, ["healthEndpoint", "health_endpoint"]),
    pickString(value, ["readinessEndpoint", "readiness_endpoint"]),
    pickString(value, ["publicHost", "public_host"]),
    normalizeStringArray(value?.paths).join(","),
  ].join("|");
}

function dependencySignature(value) {
  return [
    pickString(value, ["serviceId", "service_id"]),
    pickString(value, ["relationship"]),
    pickString(value, ["endpoint"]),
    pickBoolean(value, ["required"], null),
    pickString(value, ["confidence"]),
  ].join("|");
}

function mergeHintCollections(existingValue, incomingValue, getSignature) {
  const merged = [];
  const seen = new Set();

  [...(Array.isArray(existingValue) ? existingValue : []), ...(Array.isArray(incomingValue) ? incomingValue : [])].forEach(
    (entry) => {
      const signature = getSignature(entry);

      if (!signature || seen.has(signature)) {
        return;
      }

      seen.add(signature);
      merged.push(entry);
    },
  );

  return merged;
}

function getKnownServiceHints(name) {
  return KNOWN_SERVICE_HINTS[serviceKey(name)] || null;
}

function normalizeTimestamp(value, fallback = null) {
  if (!value) {
    return fallback;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return fallback;
  }

  return date.toISOString();
}

function latestTimestamp(left, right) {
  const leftDate = left ? new Date(left) : null;
  const rightDate = right ? new Date(right) : null;

  if (!leftDate || Number.isNaN(leftDate.getTime())) {
    return right || null;
  }

  if (!rightDate || Number.isNaN(rightDate.getTime())) {
    return left || null;
  }

  return rightDate.getTime() > leftDate.getTime() ? right : left;
}

function normalizeStatus(value) {
  if (typeof value === "boolean") {
    return value ? "running" : "stopped";
  }

  if (value == null) {
    return "unknown";
  }

  const status = String(value).trim();
  return status || "unknown";
}

function normalizeHost(value, serviceName) {
  const registryHost = SERVICE_HOSTS[serviceKey(serviceName)];
  if (registryHost) {
    return registryHost;
  }

  const host = String(value || "")
    .trim()
    .toLowerCase();

  if (host === "fedora" || host === "windows") {
    return host;
  }

  return "unknown";
}

function hasKnownStatus(value) {
  return Boolean(value && value !== "unknown");
}

function createInventory(input) {
  const inventoryInput = isObject(input) ? input : {};
  const notesInput = inventoryInput.notes;
  const notes = Array.isArray(notesInput)
    ? notesInput.map((value) => String(value || "").trim()).filter(Boolean)
    : typeof notesInput === "string" && notesInput.trim()
      ? [notesInput.trim()]
      : [];

  return (
    compactObject({
      id: pickString(inventoryInput, ["id"]) || null,
      displayName: pickString(inventoryInput, ["displayName", "display_name"]) || null,
      host: pickString(inventoryInput, ["host"]) || null,
      manager: pickString(inventoryInput, ["manager"]) || null,
      processName: pickString(inventoryInput, ["processName", "process_name"]) || null,
      localPort: pickNumber(inventoryInput, ["localPort", "local_port"], null),
      localUrl: pickString(inventoryInput, ["localUrl", "local_url"]) || null,
      localHealthUrl: pickString(inventoryInput, ["localHealthUrl", "local_health_url"]) || null,
      localReadinessUrl: pickString(inventoryInput, ["localReadinessUrl", "local_readiness_url"]) || null,
      publicUrl: pickString(inventoryInput, ["publicUrl", "public_url"]) || null,
      notes: notes.length > 0 ? notes : null,
    }) || {}
  );
}

function createRuntime(input, fallbackStatus, fallbackSource) {
  const runtimeInput = isObject(input) ? input : {};
  const runtime = compactObject({
    status: normalizeStatus(runtimeInput.status ?? fallbackStatus),
    manager: pickString(runtimeInput, ["manager"]) || null,
    processName: pickString(runtimeInput, ["processName", "process_name"]) || null,
    source: pickString(runtimeInput, ["source"]) || normalizeSource(fallbackSource),
    checkedAt: normalizeTimestamp(runtimeInput.checkedAt || runtimeInput.checked_at, null),
    pm2Status: pickString(runtimeInput, ["pm2Status", "pm2_status"]) || null,
    error: pickString(runtimeInput, ["error"]) || null,
    startedAt: normalizeTimestamp(runtimeInput.startedAt || runtimeInput.started_at, null),
    uptimeSeconds: pickNumber(runtimeInput, ["uptimeSeconds", "uptime_seconds"], null),
    restarts: pickNumber(runtimeInput, ["restarts", "restartCount", "restart_count"], null),
    memoryBytes: pickNumber(runtimeInput, ["memoryBytes", "memory_bytes"], null),
    cpuPercent: pickNumber(runtimeInput, ["cpuPercent", "cpu_percent"], null),
    pid: pickNumber(runtimeInput, ["pid"], null),
    pmId: pickNumber(runtimeInput, ["pmId", "pm_id"], null),
    health: pickString(runtimeInput, ["health"]) || null,
  });

  return runtime || { status: normalizeStatus(fallbackStatus) };
}

function createServiceRecord(input) {
  const name = normalizeServiceName(input.name);

  if (!name) {
    return null;
  }

  const source = normalizeSource(input.source);
  const runtime = createRuntime(input.runtime, input.status, source);
  const knownHints = getKnownServiceHints(name);
  const provides = mergeHintCollections(
    createProvides(input.provides),
    createProvides(knownHints?.provides),
    provideSignature,
  );
  const dependencies = mergeHintCollections(
    createDependencies(input.dependencies),
    createDependencies(knownHints?.dependencies),
    dependencySignature,
  );
  const capabilities = createCapabilities(input.capabilities);

  return {
    name,
    displayName: normalizeServiceName(input.displayName) || name,
    status: runtime.status,
    host: normalizeHost(input.host, name),
    source,
    lastSeen: normalizeTimestamp(input.lastSeen),
    hasLogs: Boolean(input.hasLogs),
    inventory: createInventory(input.inventory),
    metadata: compactObject(isObject(input.metadata) ? { ...input.metadata } : null) || {},
    health: compactObject(isObject(input.health) ? { ...input.health } : null) || {},
    provides,
    dependencies,
    capabilityOverrides: capabilities,
    runtime,
  };
}

function mergeCapabilityOverrides(existingValue, incomingValue, incomingSource) {
  const existing = createCapabilities(existingValue);
  const incoming = createCapabilities(incomingValue);

  if (!Object.keys(incoming).length) {
    return existing;
  }

  if (incomingSource === "bridge") {
    return {
      ...existing,
      ...incoming,
    };
  }

  return {
    ...incoming,
    ...existing,
  };
}

function mergeSupportingObject(existingValue, incomingValue) {
  const existing = isObject(existingValue) ? existingValue : {};
  const incoming = isObject(incomingValue) ? incomingValue : {};
  return {
    ...incoming,
    ...existing,
  };
}

function mergeRuntime(existingRuntime, incomingRuntime, nextStatus) {
  const existing = isObject(existingRuntime) ? existingRuntime : {};
  const incoming = isObject(incomingRuntime) ? incomingRuntime : {};

  return (
    compactObject({
      status: normalizeStatus(nextStatus),
      manager: existing.manager || incoming.manager || null,
      processName: existing.processName || incoming.processName || null,
      source: incoming.source || existing.source || null,
      checkedAt: incoming.checkedAt || existing.checkedAt || null,
      pm2Status: incoming.pm2Status || existing.pm2Status || null,
      error: incoming.error || existing.error || null,
      startedAt: incoming.startedAt || existing.startedAt || null,
      uptimeSeconds: incoming.uptimeSeconds ?? existing.uptimeSeconds ?? null,
      restarts: incoming.restarts ?? existing.restarts ?? null,
      memoryBytes: incoming.memoryBytes ?? existing.memoryBytes ?? null,
      cpuPercent: incoming.cpuPercent ?? existing.cpuPercent ?? null,
      pid: incoming.pid ?? existing.pid ?? null,
      pmId: incoming.pmId ?? existing.pmId ?? null,
      health: incoming.health || existing.health || null,
    }) || { status: normalizeStatus(nextStatus) }
  );
}

function mergeService(recordsByName, service) {
  if (!service) {
    return;
  }

  const key = serviceKey(service.name);
  if (!key) {
    return;
  }

  const existing = recordsByName.get(key);
  if (!existing) {
    recordsByName.set(key, {
      ...service,
      sources: new Set([service.source]),
    });
    return;
  }

  existing.sources.add(service.source);
  existing.source = existing.sources.size > 1 ? "merged" : service.source;

  if (service.source === "bridge" || existing.displayName === existing.name) {
    existing.displayName = service.displayName || existing.displayName;
  }

  const protectPm2ManagedStatus = existing.runtime?.manager === "pm2";
  if (!protectPm2ManagedStatus) {
    if (service.source === "bridge" && hasKnownStatus(service.status)) {
      existing.status = service.status;
    } else if (!hasKnownStatus(existing.status) && hasKnownStatus(service.status)) {
      existing.status = service.status;
    }
  }

  existing.runtime = protectPm2ManagedStatus
    ? mergeRuntime(
        existing.runtime,
        {
          manager: service.runtime?.manager || null,
          processName: service.runtime?.processName || null,
        },
        existing.status,
      )
    : mergeRuntime(existing.runtime, service.runtime, existing.status);
  existing.lastSeen = latestTimestamp(existing.lastSeen, service.lastSeen);
  existing.hasLogs = existing.hasLogs || service.hasLogs;
  existing.inventory = mergeSupportingObject(existing.inventory, service.inventory);
  existing.metadata = mergeSupportingObject(existing.metadata, service.metadata);
  existing.health = mergeSupportingObject(existing.health, service.health);
  existing.provides = mergeHintCollections(existing.provides, service.provides, provideSignature);
  existing.dependencies = mergeHintCollections(existing.dependencies, service.dependencies, dependencySignature);
  existing.capabilityOverrides = mergeCapabilityOverrides(existing.capabilityOverrides, service.capabilityOverrides, service.source);

  if (existing.host === "unknown" && service.host !== "unknown") {
    existing.host = service.host;
  }
}

function readServiceString(...values) {
  for (const value of values) {
    const text = String(value || "").trim();

    if (text) {
      return text;
    }
  }

  return "";
}

function readServiceNumber(...values) {
  for (const value of values) {
    const parsed = Number(value);

    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function getServiceManager(service) {
  return readServiceString(service?.runtime?.manager, service?.inventory?.manager);
}

function getServiceProcessName(service) {
  return readServiceString(service?.runtime?.processName, service?.inventory?.processName, service?.name);
}

function getServiceHealthUrl(service) {
  return readServiceString(
    service?.inventory?.localHealthUrl,
    service?.health?.url,
    service?.health?.localUrl,
    service?.inventory?.localUrl,
    service?.health?.publicUrl,
    service?.inventory?.publicUrl,
  );
}

function getServiceLocalPort(service) {
  return readServiceNumber(service?.inventory?.localPort, service?.health?.checks?.localPort?.port);
}

function normalizeGroupKey(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  if (!normalized) {
    return "";
  }

  if (normalized === "ui" || normalized === "app" || normalized === "apps" || normalized === "ui-app" || normalized === "ui-apps") {
    return "ui-apps";
  }

  if (normalized === "infra" || normalized === "infrastructure" || normalized === "database" || normalized === "db") {
    return "infrastructure";
  }

  if (normalized === "bridge" || normalized === "control-plane" || normalized === "control" || normalized === "operator") {
    return "admin";
  }

  if (normalized === "api" || normalized === "admin") {
    return normalized;
  }

  return "";
}

function resolveKnownClassification(serviceName) {
  return KNOWN_SERVICE_CLASSIFICATIONS[serviceKey(serviceName)] || null;
}

function resolveExplicitClassification(service) {
  const metadata = isObject(service?.metadata) ? service.metadata : {};
  const inventory = isObject(service?.inventory) ? service.inventory : {};
  const known = resolveKnownClassification(service?.name);
  const groupKey = normalizeGroupKey(
    metadata.serviceGroup || metadata.group || inventory.serviceGroup || inventory.group || known?.groupKey,
  );
  const type = readServiceString(
    metadata.serviceType,
    metadata.type,
    inventory.serviceType,
    inventory.type,
    known?.type,
  );

  if (!groupKey && !type) {
    return null;
  }

  return {
    groupKey,
    type,
    source:
      metadata.serviceGroup ||
      metadata.group ||
      metadata.serviceType ||
      metadata.type ||
      inventory.serviceGroup ||
      inventory.group ||
      inventory.serviceType ||
      inventory.type
        ? "metadata"
        : "registry",
  };
}

function inferServiceType(service) {
  const name = serviceKey(service?.name);
  const displayName = readServiceString(service?.displayName);
  const text = `${name} ${displayName}`.trim().toLowerCase();

  if (!text) {
    return "Service";
  }

  if (/postgres|taskmaster-db|\bdb\b|database/.test(text) || service?.metadata?.backend === "postgres") {
    return "Database";
  }

  if (name === "garage-admin-v2" || /garage-admin|operator console/.test(text)) {
    return "Operator Console";
  }

  if (name === "admin-proxy" || /admin-proxy|control proxy/.test(text)) {
    return "Control Proxy";
  }

  if (name === "node-agent" || /node-agent/.test(text)) {
    return "Node Agent";
  }

  if (/bridge/.test(text) || (name === "aibry-admin" && service?.host === "fedora")) {
    return "Bridge";
  }

  if (/(^|[-\s])api($|[-\s])/.test(text) || name.endsWith("-api")) {
    return "API";
  }

  if (/(^|[-\s])ui($|[-\s])/.test(text) || /landing|web|comparator/.test(text) || name.endsWith("-ui")) {
    return "UI";
  }

  if (/(^|[-\s])app($|[-\s])/.test(text)) {
    return "App";
  }

  return service?.host === "windows" ? "App" : "Service";
}

function inferServiceGroupKey(service, type) {
  const normalizedType = String(type || "")
    .trim()
    .toLowerCase();

  if (normalizedType === "api") {
    return "api";
  }

  if (["ui", "app", "operator console"].includes(normalizedType)) {
    return "ui-apps";
  }

  if (["database", "infrastructure"].includes(normalizedType)) {
    return "infrastructure";
  }

  return "admin";
}

function deriveServiceStatus(service, runtime, health) {
  const healthStatus = normalizeStatus(health?.status);

  if (healthStatus === "degraded" || healthStatus === "errored" || healthStatus === "probe-failed") {
    return healthStatus;
  }

  const explicitStatus = normalizeStatus(service?.status);

  if (explicitStatus !== "unknown") {
    return explicitStatus;
  }

  const runtimeStatus = normalizeStatus(runtime?.status);
  if (runtimeStatus !== "unknown") {
    return runtimeStatus;
  }

  const localHttp = isObject(health?.checks?.localHttp) ? health.checks.localHttp : null;
  const localPort = isObject(health?.checks?.localPort) ? health.checks.localPort : null;

  if (localHttp?.ok === true || localPort?.ok === true) {
    return "running";
  }

  if (
    (localHttp?.checkedAt && localHttp.ok === false) &&
    (localPort?.checkedAt && localPort.ok === false)
  ) {
    return "failed";
  }

  return "unknown";
}

function deriveServiceSeverity(service, setupHints = []) {
  const status = normalizeStatus(service?.status);

  if (/^(disabled|inactive|paused)$/.test(status)) {
    return "disabled";
  }

  if (/^(failed|stopped|error|errored|unreachable|offline|crashed|missing)$/.test(status)) {
    return "failed";
  }

  if (/^(warning|degraded|partial|timeout|attention|restarting|probe-failed)$/.test(status)) {
    return "warning";
  }

  if (status === "pending-env-or-not-started" || status === "needs-setup") {
    return "needs-setup";
  }

  if (setupHints.length > 0 && status === "unknown") {
    return "needs-setup";
  }

  if (/^(running|online|healthy|ok|ready|supported|completed)$/.test(status)) {
    return "running";
  }

  return "unknown";
}

function classifyService(service, capabilities) {
  const explicit = resolveExplicitClassification(service);
  const type = explicit?.type || inferServiceType(service);
  const groupKey = explicit?.groupKey || inferServiceGroupKey(service, type);
  const setupHints = Array.isArray(capabilities?.setupHints) ? capabilities.setupHints : [];

  return {
    groupKey,
    groupLabel: SERVICE_GROUP_LABELS[groupKey] || SERVICE_GROUP_LABELS.admin,
    type,
    severity: deriveServiceSeverity(service, setupHints),
    setupHints,
    primarySetupHint: setupHints[0] || "",
    source: explicit?.source || "inferred",
  };
}

function uniqueHints(values) {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
}

function logCapability(service) {
  const host = normalizeHost(service.host, service.name);
  const manager = getServiceManager(service);
  const processName = getServiceProcessName(service);

  if (host === "windows" && manager === "pm2" && processName) {
    return {
      supported: true,
      executor: "windows-local",
      mode: "pm2",
      reason: null,
      setupHint: null,
    };
  }

  if (host === "fedora" && service.hasLogs) {
    return {
      supported: true,
      executor: "fedora-bridge",
      mode: "bridge",
      reason: null,
      setupHint: null,
    };
  }

  if (host === "unknown") {
    return {
      supported: false,
      executor: null,
      mode: "unsupported",
      reason: "Host metadata is missing, so a safe log executor cannot be selected.",
      setupHint: "Missing host metadata",
    };
  }

  if (host === "windows" && manager === "pm2" && !processName) {
    return {
      supported: false,
      executor: null,
      mode: "unsupported",
      reason: "Windows PM2 logs require a process name for this service.",
      setupHint: "Missing log route",
    };
  }

  return {
    supported: false,
    executor: null,
    mode: "unsupported",
    reason: "No supported log route is configured for this service.",
    setupHint: "Missing log route",
  };
}

function healthCapability(service) {
  const host = normalizeHost(service.host, service.name);
  const manager = getServiceManager(service);
  const processName = getServiceProcessName(service);
  const healthUrl = getServiceHealthUrl(service);
  const localPort = getServiceLocalPort(service);
  const runtimeStatus = normalizeStatus(service.runtime?.status || service.status);

  if (host === "fedora" && serviceKey(service.name) === "aibry-admin") {
    return {
      supported: true,
      executor: "fedora-bridge",
      mode: "bridge-health",
      reason: null,
      setupHint: null,
    };
  }

  if (service?.inventory?.localHealthUrl || service?.health?.url) {
    return {
      supported: true,
      executor: host === "windows" ? "windows-local" : host === "fedora" ? "http" : null,
      mode: "http",
      reason: null,
      setupHint: null,
    };
  }

  if (service?.inventory?.localUrl || service?.health?.localUrl || service?.inventory?.publicUrl || service?.health?.publicUrl) {
    return {
      supported: true,
      executor: host === "windows" ? "windows-local" : host === "fedora" ? "http" : null,
      mode: "local-url",
      reason: "No dedicated health endpoint is configured; using local HTTP reachability instead.",
      setupHint: null,
    };
  }

  if (host === "windows" && localPort != null) {
    return {
      supported: true,
      executor: "windows-local",
      mode: "tcp",
      reason: "No dedicated health endpoint is configured; using local port verification instead.",
      setupHint: null,
    };
  }

  if (host === "windows" && manager === "pm2" && processName) {
    return {
      supported: true,
      executor: "windows-local",
      mode: "status-only",
      reason: "No dedicated health endpoint is configured; using PM2 status verification instead.",
      setupHint: null,
    };
  }

  if (runtimeStatus !== "unknown" && runtimeStatus !== "pending-env-or-not-started") {
    return {
      supported: true,
      executor: host === "fedora" ? "fedora-bridge" : null,
      mode: "status-only",
      reason: "No dedicated health endpoint is configured; using runtime status instead.",
      setupHint: null,
    };
  }

  if (host === "unknown") {
    return {
      supported: false,
      executor: null,
      mode: "unsupported",
      reason: "Host metadata is missing, so a safe health check path cannot be selected.",
      setupHint: "Missing host metadata",
    };
  }

  if (!healthUrl && localPort == null && !processName) {
    return {
      supported: false,
      executor: null,
      mode: "unsupported",
      reason: "No supported health endpoint or runtime verification path is configured for this service.",
      setupHint: "Missing health check",
    };
  }

  return {
    supported: false,
    executor: null,
    mode: "unsupported",
    reason: "Health check support is unavailable for this service from the current executor.",
    setupHint: "Setup details unavailable",
  };
}

function restartCapability(service) {
  const host = normalizeHost(service.host, service.name);
  const manager = getServiceManager(service);
  const explicitRestart = createCapability(service.capabilityOverrides?.restart);

  if (host === "fedora") {
    if (explicitRestart?.supported === true) {
      return {
        supported: true,
        executor: explicitRestart.executor || "fedora-bridge",
        mode: explicitRestart.mode || "service-restart",
        reason: explicitRestart.reason || null,
        setupHint: explicitRestart.setupHint || null,
      };
    }

    return {
      supported: false,
      executor: null,
      mode: "unsupported",
      reason: explicitRestart?.reason || "Fedora restart is unavailable until the bridge reports restart.supported=true.",
      setupHint: explicitRestart?.setupHint || "Bridge restart capability unavailable",
    };
  }

  if (host === "windows" && windowsExecutor.isRestartSupported(service.name)) {
    return {
      supported: true,
      executor: "windows-local",
      mode: "pm2-restart",
      reason: null,
      setupHint: null,
    };
  }

  if (host === "windows" && manager === "pm2") {
    return {
      supported: false,
      executor: null,
      mode: "unsupported",
      reason: "Restart is intentionally unavailable for this Windows PM2 service from the current executor.",
      setupHint: null,
    };
  }

  if (host === "unknown") {
    return {
      supported: false,
      executor: null,
      mode: "unsupported",
      reason: "Host metadata is missing, so a safe restart executor cannot be selected.",
      setupHint: "Missing host metadata",
    };
  }

  return {
    supported: false,
    executor: null,
    mode: "unsupported",
    reason: "Restart is not supported for this service from the current executor.",
    setupHint: "Missing restart executor",
  };
}

function serviceCapabilities(service) {
  const logs = logCapability(service);
  const health = healthCapability(service);
  const restart = restartCapability(service);
  const setupHints = uniqueHints([
    logs.setupHint,
    health.setupHint,
    restart.setupHint,
    normalizeStatus(service.status) === "pending-env-or-not-started" ? "Pending environment or runtime start" : "",
  ]);

  return {
    logs,
    health,
    restart,
    setupHints,
  };
}

function finalizeService(service) {
  const {
    sources: _sources,
    inventory: rawInventory,
    metadata: rawMetadata,
    health: rawHealth,
    provides: rawProvides,
    dependencies: rawDependencies,
    capabilityOverrides: rawCapabilityOverrides,
    runtime: rawRuntime,
    ...base
  } = service;

  const inventory = compactObject(rawInventory);
  const metadata = compactObject(rawMetadata);
  const health = compactObject(rawHealth);
  const provides = createProvides(rawProvides);
  const dependencies = createDependencies(rawDependencies);
  const capabilityOverrides = createCapabilities(rawCapabilityOverrides);
  const initialRuntime = mergeRuntime(rawRuntime, null, base.status);
  const resolvedStatus = deriveServiceStatus(
    {
      ...base,
      ...(health ? { health } : {}),
    },
    initialRuntime,
    health,
  );
  const runtime = mergeRuntime(initialRuntime, null, resolvedStatus);
  const capabilities = serviceCapabilities({
    ...base,
    status: resolvedStatus,
    ...(inventory ? { inventory } : {}),
    ...(metadata ? { metadata } : {}),
    ...(health ? { health } : {}),
    ...(Object.keys(capabilityOverrides).length > 0 ? { capabilityOverrides } : {}),
    runtime,
  });
  const classification = classifyService(
    {
      ...base,
      status: resolvedStatus,
      ...(inventory ? { inventory } : {}),
      ...(metadata ? { metadata } : {}),
      ...(health ? { health } : {}),
      runtime,
    },
    capabilities,
  );
  const manager = getServiceManager({
    ...base,
    ...(inventory ? { inventory } : {}),
    runtime,
  });
  const processName = getServiceProcessName({
    ...base,
    ...(inventory ? { inventory } : {}),
    runtime,
  });

  return {
    ...base,
    status: resolvedStatus,
    ...(inventory ? { inventory } : {}),
    ...(metadata ? { metadata } : {}),
    ...(health ? { health } : {}),
    ...(provides.length > 0 ? { provides } : {}),
    ...(dependencies.length > 0 ? { dependencies } : {}),
    ...(Object.keys(capabilityOverrides).length > 0 ? { capabilityOverrides } : {}),
    runtime,
    restartCount: pickNumber(health, ["restartCount"], runtime.restarts),
    uptimeSeconds: pickNumber(health, ["uptimeSeconds"], runtime.uptimeSeconds),
    pid: pickNumber(health, ["pid"], runtime.pid),
    warnings: Array.isArray(health?.warnings) ? health.warnings : [],
    lastErrorHints: Array.isArray(health?.lastErrorHints) ? health.lastErrorHints : [],
    manager: manager || null,
    processName: processName || null,
    serviceGroupKey: classification.groupKey,
    serviceGroupLabel: classification.groupLabel,
    serviceTypeLabel: classification.type,
    supports: {
      logs: capabilities.logs.supported === true,
      health: capabilities.health.supported === true,
      restart: capabilities.restart.supported === true,
    },
    classification,
    capabilities,
    restart: capabilities.restart,
  };
}

function serviceSortValue(service) {
  const priorityIndex = PRIORITY_SERVICES.indexOf(serviceKey(service.name));
  return priorityIndex === -1 ? Number.MAX_SAFE_INTEGER : priorityIndex;
}

function sortServices(services) {
  return [...services].sort((left, right) => {
    const leftPriority = serviceSortValue(left);
    const rightPriority = serviceSortValue(right);

    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }

    const leftSeen = left.lastSeen ? new Date(left.lastSeen).getTime() : 0;
    const rightSeen = right.lastSeen ? new Date(right.lastSeen).getTime() : 0;

    if (leftSeen !== rightSeen) {
      return rightSeen - leftSeen;
    }

    return left.name.localeCompare(right.name);
  });
}

function isLikelyServiceMapKey(key) {
  const normalized = serviceKey(key);

  if (!normalized) {
    return false;
  }

  return normalized.includes("-") || /(api|app|admin|bridge|service|worker|scheduler)$/.test(normalized);
}

function bridgeRecordFromObject(value, fallbackName, now) {
  const name = normalizeServiceName(
    pickString(value, ["serviceName", "service_name", "name", "service", "id"]) || fallbackName,
  );

  if (!name) {
    return null;
  }

  return createServiceRecord({
    name,
    displayName: pickString(value, ["displayName", "display_name", "label", "title"]) || name,
    status: value.status ?? value.state ?? value.health ?? value.active,
    host: value.host || value.targetHost || value.target_host,
    source: "bridge",
    lastSeen:
      value.lastSeen ||
      value.last_seen ||
      value.updatedAt ||
      value.updated_at ||
      value.timestamp ||
      value.checkedAt ||
      now,
    hasLogs: pickBoolean(value, ["hasLogs", "has_logs", "logsAvailable", "logs_available"], true),
    inventory: isObject(value.inventory) ? value.inventory : null,
    metadata: isObject(value.metadata) ? value.metadata : null,
    health: isObject(value.health) ? value.health : null,
    capabilities: isObject(value.capabilities)
      ? value.capabilities
      : isObject(value.restart)
        ? { restart: value.restart }
        : isObject(value.supports)
          ? { restart: { supported: value.supports.restart === true } }
          : null,
    runtime: isObject(value.runtime) ? value.runtime : null,
  });
}

function extractBridgeServices(payload, now = new Date().toISOString()) {
  const services = [];

  function visit(value, fallbackName = "", depth = 0) {
    if (depth > 4 || value == null) {
      return;
    }

    if (typeof value === "string") {
      const record = createServiceRecord({
        name: value,
        source: "bridge",
        lastSeen: now,
        hasLogs: true,
      });
      if (record) {
        services.push(record);
      }
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, "", depth + 1));
      return;
    }

    if (!isObject(value)) {
      return;
    }

    const directRecord = bridgeRecordFromObject(value, fallbackName, now);
    if (directRecord) {
      services.push(directRecord);
    }

    for (const key of ["services", "items", "results"]) {
      if (value[key] != null) {
        visit(value[key], "", depth + 1);
      }
    }

    if (isObject(value.data)) {
      visit(value.data, "", depth + 1);
    }

    if (!directRecord) {
      for (const [key, entry] of Object.entries(value)) {
        if (isLikelyServiceMapKey(key)) {
          visit(entry, key, depth + 1);
        }
      }
    }
  }

  visit(payload);
  return services;
}

function inventoryDefinitionForService(serviceName) {
  return STATIC_SERVICE_INVENTORY.find((definition) => serviceKey(definition.name) === serviceKey(serviceName)) || null;
}

function bridgeBaselineServices(now = new Date().toISOString()) {
  return BRIDGE_BASELINE_SERVICES.map((name) => {
    const definition = inventoryDefinitionForService(name);

    return createServiceRecord({
      ...(definition || {
        name,
        host: SERVICE_HOSTS[name] || "unknown",
        source: "bridge",
        hasLogs: true,
        runtime: {
          status: "unknown",
          source: "bridge",
        },
      }),
      source: "bridge",
      lastSeen: now,
    });
  }).filter(Boolean);
}

function deriveMemoryServices(serviceFacts, incidents) {
  const recordsByName = new Map();

  for (const fact of serviceFacts) {
    const factValue = isObject(fact.factValue) ? fact.factValue : {};
    const service = createServiceRecord({
      name: fact.serviceName || factValue.serviceName || factValue.name,
      displayName:
        factValue.displayName ||
        factValue.display_name ||
        factValue.label ||
        factValue.title ||
        fact.serviceName,
      status: factValue.status ?? factValue.state ?? factValue.health,
      host: factValue.host || factValue.targetHost || factValue.target_host,
      source: "memory",
      lastSeen:
        factValue.lastSeen ||
        factValue.last_seen ||
        factValue.updatedAt ||
        factValue.updated_at ||
        fact.updatedAt ||
        fact.createdAt,
      hasLogs: pickBoolean(factValue, ["hasLogs", "has_logs", "logsAvailable", "logs_available"], false),
      inventory: isObject(factValue.inventory) ? factValue.inventory : null,
      metadata: isObject(factValue.metadata) ? factValue.metadata : null,
      health: isObject(factValue.health) ? factValue.health : null,
      runtime: isObject(factValue.runtime) ? factValue.runtime : null,
    });

    mergeService(recordsByName, service);
  }

  for (const incident of incidents) {
    const service = createServiceRecord({
      name: incident.serviceName,
      source: "memory",
      lastSeen: incident.updatedAt || incident.createdAt,
      hasLogs: false,
    });

    mergeService(recordsByName, service);
  }

  return sortServices(Array.from(recordsByName.values()).map(finalizeService));
}

function createMemoryReadTimeoutError(label) {
  const error = new Error(`${label} read timed out after ${config.memoryReadTimeoutMs}ms.`);
  error.code = "memory_read_timeout";
  return error;
}

function withMemoryReadTimeout(label, readPromise) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(createMemoryReadTimeoutError(label)), config.memoryReadTimeoutMs);
  });

  return Promise.race([readPromise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

async function readMemoryServices() {
  try {
    const [serviceFacts, incidents] = await withMemoryReadTimeout(
      "Service discovery memory",
      Promise.all([repository.listServiceFacts(), repository.listIncidents()]),
    );

    return {
      ok: true,
      items: deriveMemoryServices(serviceFacts, incidents),
      error: null,
    };
  } catch (error) {
    const safeError = classifyDatabaseError(error);
    console.warn("[services] memory source unavailable", {
      code: error?.code || safeError.code || error?.name || "memory_read_failed",
      message: redactText(error?.message || "Memory read failed."),
      degraded: true,
    });

    return {
      ok: false,
      items: [],
      error: safeError.message,
    };
  }
}

async function readBridgeServices() {
  const now = new Date().toISOString();
  const response = await bridgeClient.discoverServices();

  if (!response.ok) {
    return {
      ok: false,
      items: [],
      discoveryPath: response.discoveryPath || null,
      usedBaseline: false,
      error:
        response.error ||
        (response.data && typeof response.data === "object" ? response.data.error : null) ||
        "Bridge service discovery failed",
    };
  }

  let items = extractBridgeServices(response.data, now);
  let usedBaseline = false;

  if (response.discoveryPath === "/admin/health" || items.length === 0) {
    items = [...items, ...bridgeBaselineServices(now)];
    usedBaseline = true;
  }

  return {
    ok: true,
    items,
    discoveryPath: response.discoveryPath || null,
    usedBaseline,
    error: null,
  };
}

async function writeBridgeObservations(bridgeServices, bridgeResult) {
  const discoveredAt = new Date().toISOString();
  const uniqueServices = sortServices(
    Array.from(
      bridgeServices.reduce((recordsByName, service) => {
        mergeService(recordsByName, service);
        return recordsByName;
      }, new Map()).values(),
    ).map(finalizeService),
  );

  await Promise.allSettled(
    uniqueServices.slice(0, 50).map((service) =>
      repository.upsertServiceFact({
        serviceName: service.name,
        factType: "runtime",
        factKey: "bridge.discovery",
        factValue: {
          name: service.name,
          displayName: service.displayName,
          status: service.status,
          lastSeen: service.lastSeen,
          hasLogs: service.hasLogs,
          host: service.host,
          capabilities: service.capabilities,
          inventory: service.inventory || {},
          metadata: service.metadata || {},
          health: service.health || {},
          runtime: service.runtime || {},
          discoveredAt,
          discoveryPath: bridgeResult.discoveryPath,
          usedBaseline: bridgeResult.usedBaseline,
        },
        source: "bridge",
      }),
    ),
  );
}

async function readWindowsPm2Statuses() {
  const runtimeDefinitions = STATIC_SERVICE_INVENTORY.filter(
    (definition) => definition.host === "windows" && definition.runtime?.manager === "pm2",
  ).map((definition) => ({
    serviceName: definition.name,
    processName: definition.runtime?.processName || definition.inventory?.processName || definition.name,
    localPort: definition.inventory?.localPort || null,
    localUrl: definition.inventory?.localUrl || definition.health?.localUrl || null,
    healthUrl: definition.inventory?.localHealthUrl || definition.health?.url || null,
  }));

  return windowsExecutor.getWindowsRuntimeSnapshot(runtimeDefinitions);
}

function resolveInventoryRuntime(definition, windowsSnapshot) {
  const baseRuntime = createRuntime(definition.runtime, definition.status, definition.source || "inventory");
  const pm2Snapshot = windowsSnapshot?.pm2 || windowsSnapshot;

  if (baseRuntime.manager !== "pm2") {
    return baseRuntime;
  }

  const processKey = serviceKey(baseRuntime.processName || definition.name);
  const liveStatus = pm2Snapshot?.statuses?.[processKey] || null;

  if (liveStatus) {
    return mergeRuntime(
      baseRuntime,
      {
        ...liveStatus,
        source: "pm2",
      },
      liveStatus.status,
    );
  }

  if (pm2Snapshot?.ok) {
    return mergeRuntime(
      baseRuntime,
      {
        source: baseRuntime.source || "inventory",
        pm2Status: "missing",
      },
      "missing",
    );
  }

  return baseRuntime;
}

function resolveInventoryHealth(definition, windowsSnapshot) {
  const baseHealth = isObject(definition.health) ? { ...definition.health } : {};
  const liveChecks = windowsSnapshot?.services?.[serviceKey(definition.name)] || {};
  const pm2 = isObject(liveChecks.pm2) ? liveChecks.pm2 : null;
  const localHttp = isObject(liveChecks.localHttp) ? liveChecks.localHttp : null;
  const localPort = isObject(liveChecks.localPort) ? liveChecks.localPort : null;
  const pm2Status = pickString(pm2, ["pm2Status"]);
  const pm2HealthStatus = pickString(pm2, ["status"]);
  const probeCode = pickString(localHttp, ["code", "errorCode"]);
  const probeFailedWithRuntimeEvidence =
    localHttp?.checkedAt &&
    localHttp.ok === false &&
    localPort?.checkedAt &&
    localPort.ok === true &&
    (pm2Status === "online" || pm2HealthStatus === "healthy");
  const warnings = Array.isArray(pm2?.warnings) ? pm2.warnings : Array.isArray(baseHealth.warnings) ? baseHealth.warnings : [];
  const probeWarning =
    probeCode === "probe_timeout"
      ? "HTTP health probe timed out, but PM2 is online and the local port is listening."
      : probeCode === "probe_aborted"
        ? "HTTP health probe was aborted, but PM2 is online and the local port is listening."
        : "HTTP health probe failed, but PM2 is online and the local port is listening.";
  const checks = compactObject({
    localHttp,
    localPort,
  });

  return (
    compactObject({
      ...baseHealth,
      status: probeFailedWithRuntimeEvidence ? "degraded" : pm2HealthStatus || baseHealth.status || null,
      warnings: probeFailedWithRuntimeEvidence
        ? uniqueHints([
            ...warnings,
            probeWarning,
          ])
        : warnings.length > 0
          ? warnings
          : null,
      lastErrorHints:
        Array.isArray(pm2?.lastErrorHints)
          ? pm2.lastErrorHints
          : Array.isArray(baseHealth.lastErrorHints)
            ? baseHealth.lastErrorHints
            : null,
      restartCount: pickNumber(pm2, ["restartCount"], pickNumber(baseHealth, ["restartCount"], null)),
      uptimeSeconds: pickNumber(pm2, ["uptimeSeconds"], pickNumber(baseHealth, ["uptimeSeconds"], null)),
      pid: pickNumber(pm2, ["pid"], pickNumber(baseHealth, ["pid"], null)),
      pm2Status: pm2Status || baseHealth.pm2Status || null,
      checks,
      checkedAt:
        liveChecks.localHttp?.checkedAt ||
        liveChecks.localPort?.checkedAt ||
        baseHealth.checkedAt ||
        null,
    }) || {}
  );
}

function buildStaticInventory(windowsSnapshot) {
  return STATIC_SERVICE_INVENTORY.map((definition) => {
    const runtime = resolveInventoryRuntime(definition, windowsSnapshot);
    const processKey = serviceKey(runtime.processName || definition.name);
    const liveStatus = windowsSnapshot?.pm2?.statuses?.[processKey] || windowsSnapshot?.statuses?.[processKey] || null;
    const health = resolveInventoryHealth(definition, windowsSnapshot);

    return createServiceRecord({
      ...definition,
      status: runtime.status,
      runtime,
      health,
      lastSeen: liveStatus ? liveStatus.checkedAt : definition.lastSeen || null,
    });
  }).filter(Boolean);
}

async function listUnifiedServices() {
  const [bridgeResult, memoryResult, windowsSnapshot] = await Promise.all([
    readBridgeServices(),
    readMemoryServices(),
    readWindowsPm2Statuses(),
  ]);

  const recordsByName = new Map();

  buildStaticInventory(windowsSnapshot).forEach((service) => mergeService(recordsByName, service));
  bridgeResult.items.forEach((service) => mergeService(recordsByName, service));
  memoryResult.items.forEach((service) => mergeService(recordsByName, service));

  if (bridgeResult.ok && bridgeResult.items.length > 0) {
    writeBridgeObservations(bridgeResult.items, bridgeResult).catch(() => {});
  }

  return {
    ok: true,
    items: sortServices(Array.from(recordsByName.values()).map(finalizeService)),
    sources: {
      inventory: {
        ok: true,
        itemCount: STATIC_SERVICE_INVENTORY.length,
      },
      windowsPm2: {
        ok: windowsSnapshot.ok,
        checkedAt: windowsSnapshot.pm2?.checkedAt || windowsSnapshot.checkedAt || null,
        error: windowsSnapshot.error || null,
      },
      windowsLocalChecks: {
        ok: true,
        checkedAt: windowsSnapshot.checkedAt || null,
      },
      bridge: {
        ok: bridgeResult.ok,
        discoveryPath: bridgeResult.discoveryPath,
        usedBaseline: bridgeResult.usedBaseline,
        error: bridgeResult.error,
      },
      memory: {
        ok: memoryResult.ok,
        error: memoryResult.error,
      },
    },
  };
}

module.exports = {
  PRIORITY_SERVICES,
  deriveMemoryServices,
  extractBridgeServices,
  listUnifiedServices,
  normalizeServiceName,
  sortServices,
};
