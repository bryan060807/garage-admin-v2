const baseUrl = process.argv[2] || "http://127.0.0.1:4010";
const SERVICE_GROUP_ORDER = ["api", "ui-apps", "admin", "infrastructure"];

function normalizeCollection(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeObjectCollection(value) {
  return normalizeCollection(value).filter((item) => item && typeof item === "object" && !Array.isArray(item));
}

function normalizeStringArray(value) {
  return normalizeCollection(value)
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
}

function normalizeServiceGroupKey(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  if (!normalized) {
    return "";
  }

  if (normalized === "ui" || normalized === "app" || normalized === "apps" || normalized === "ui-apps") {
    return "ui-apps";
  }

  if (normalized === "infra" || normalized === "infrastructure" || normalized === "database" || normalized === "db") {
    return "infrastructure";
  }

  if (normalized === "bridge" || normalized === "control-plane" || normalized === "control") {
    return "admin";
  }

  if (normalized === "api" || normalized === "admin") {
    return normalized;
  }

  return "";
}

function getServiceRailGroupKey(service) {
  const explicitGroupKey = normalizeServiceGroupKey(
    service?.classification?.groupKey || service?.classification?.group || service?.serviceGroupKey,
  );

  if (explicitGroupKey) {
    return explicitGroupKey;
  }

  const type = String(service?.classification?.type || service?.serviceTypeLabel || "")
    .trim()
    .toLowerCase();

  if (type === "api") {
    return "api";
  }

  if (type === "ui" || type === "app" || type === "operator console") {
    return "ui-apps";
  }

  if (type === "database" || type === "infrastructure") {
    return "infrastructure";
  }

  return "admin";
}

function groupServicesForRail(services) {
  const grouped = Object.fromEntries(SERVICE_GROUP_ORDER.map((key) => [key, []]));

  for (const service of normalizeObjectCollection(services)) {
    const groupKey = getServiceRailGroupKey(service);

    if (!Array.isArray(grouped[groupKey])) {
      grouped[groupKey] = [];
    }

    grouped[groupKey].push(service);
  }

  return SERVICE_GROUP_ORDER.map((key) => ({
    key,
    services: normalizeObjectCollection(grouped[key]),
  }));
}

async function fetchJson(pathname) {
  const response = await fetch(new URL(pathname, baseUrl));
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(`${pathname} failed with HTTP ${response.status}`);
  }

  return payload;
}

const servicesPayload = await fetchJson("/api/services");
const incidentsPayload = await fetchJson("/api/memory/incidents");
const auditPayload = await fetchJson("/api/memory/audit");
const services = normalizeObjectCollection(servicesPayload.items);
const incidents = normalizeObjectCollection(incidentsPayload.items);
const audit = normalizeObjectCollection(auditPayload.items);
const grouped = groupServicesForRail(services);

for (const group of grouped) {
  if (!Array.isArray(group.services)) {
    throw new Error(`Group ${group.key} did not normalize to an array`);
  }
}

for (const service of services) {
  normalizeStringArray(service?.classification?.setupHints);
  normalizeStringArray(service?.capabilities?.setupHints);
  void (service?.supports?.logs === true);
  void (service?.supports?.health === true);
  void (service?.supports?.restart === true);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      baseUrl,
      counts: {
        services: services.length,
        incidents: incidents.length,
        audit: audit.length,
      },
      groups: Object.fromEntries(grouped.map((group) => [group.key, group.services.length])),
    },
    null,
    2,
  ),
);
