const TIMESTAMP_PREFIX_PATTERN =
  /^(\[?\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\]?)/;

const FILE_REFERENCE_PATTERNS = [
  /\(?([A-Za-z]:\\[^:\r\n]+?\.[A-Za-z0-9._-]+):(\d+)(?::(\d+))?\)?/,
  /\(?(\/[^\s:()]+?\.[A-Za-z0-9._-]+):(\d+)(?::(\d+))?\)?/,
  /\(?((?:\.\.\/|\.\/)[^\s:()]+?\.[A-Za-z0-9._-]+):(\d+)(?::(\d+))?\)?/,
];

const HOST_PORT_PATTERN = /((?:\d{1,3}\.){3}\d{1,3}|localhost|[A-Za-z0-9.-]+):(\d{2,5})/;
const URL_CANDIDATE_PATTERN = /https?:\/\/[^\s'"`)>]+/gi;
const HOST_PORT_CANDIDATE_PATTERN = /((?:\d{1,3}\.){3}\d{1,3}|localhost|[A-Za-z0-9.-]+):(\d{2,5})(\/[^\s'"`)>]+)?/gi;
const LOG_EVENT_LIMIT = 6;
const CONTROL_PLANE_IDS = new Set(["aibry-admin", "admin-proxy", "node-agent"]);

const SEVERITY_SCORES = {
  critical: 3,
  warning: 2,
  info: 1,
  unknown: 0,
};

const CONFIDENCE_SCORES = {
  high: 3,
  medium: 2,
  low: 1,
};

function cleanText(value) {
  return String(value || "").trim();
}

function uniqueValues(values) {
  return values.filter((value, index) => value && values.indexOf(value) === index);
}

function uniqueBy(values, getKey) {
  const seen = new Set();

  return values.filter((value) => {
    const key = getKey(value);

    if (!key || seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeObjectCollection(value) {
  return Array.isArray(value) ? value.filter((entry) => isPlainObject(entry)) : [];
}

function normalizeStringArray(value) {
  return Array.isArray(value)
    ? Array.from(new Set(value.map((entry) => cleanText(entry)).filter(Boolean)))
    : [];
}

function normalizeHost(value) {
  const host = cleanText(value).toLowerCase();

  if (host === "windows" || host === "fedora") {
    return host;
  }

  return "unknown";
}

function normalizeStatus(value) {
  return cleanText(value).toLowerCase() || "unknown";
}

function normalizeSeverity(value) {
  const severity = cleanText(value).toLowerCase();
  return ["info", "warning", "critical", "unknown"].includes(severity) ? severity : "unknown";
}

function severityFromRiskLevel(value) {
  const riskLevel = cleanText(value).toLowerCase();

  if (riskLevel === "dangerous") {
    return "critical";
  }

  if (riskLevel === "caution") {
    return "warning";
  }

  if (riskLevel === "safe") {
    return "info";
  }

  return "unknown";
}

function riskLevelFromSeverity(value) {
  const severity = normalizeSeverity(value);

  if (severity === "critical") {
    return "dangerous";
  }

  if (severity === "warning") {
    return "caution";
  }

  if (severity === "info") {
    return "safe";
  }

  return "unknown";
}

function normalizeIssueSource(value) {
  const source = cleanText(value).toLowerCase();

  if (!source) {
    return "none";
  }

  if (source === "audit") {
    return "action";
  }

  if (source === "runtime") {
    return "combined";
  }

  if (["logs", "action", "health", "combined", "none"].includes(source)) {
    return source;
  }

  return "combined";
}

function titleCaseWord(value) {
  const text = cleanText(value);

  if (!text) {
    return "Unknown";
  }

  return text.charAt(0).toUpperCase() + text.slice(1);
}

function quoteCommandValue(value) {
  const text = cleanText(value);

  if (!text) {
    return "";
  }

  return /\s/.test(text) ? `"${text}"` : text;
}

function fileNameFromPath(value) {
  const path = cleanText(value);

  if (!path) {
    return "";
  }

  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function extractTimestamp(value) {
  const match = cleanText(value).match(TIMESTAMP_PREFIX_PATTERN);
  return match ? match[1].replace(/^\[|\]$/g, "") : "";
}

function parseFileReference(value) {
  const text = cleanText(value);

  if (!text) {
    return null;
  }

  for (const pattern of FILE_REFERENCE_PATTERNS) {
    const match = text.match(pattern);

    if (match) {
      const filePath = match[1];
      const lineNumber = Number(match[2]);
      const columnNumber = Number(match[3]);

      return {
        filePath,
        fileName: fileNameFromPath(filePath),
        lineNumber: Number.isFinite(lineNumber) ? lineNumber : null,
        columnNumber: Number.isFinite(columnNumber) ? columnNumber : null,
      };
    }
  }

  return null;
}

function findNearbyFileReference(lines, index) {
  const offsets = [0, 1, -1, 2, -2, 3, -3];

  for (const offset of offsets) {
    const candidate = parseFileReference(lines[index + offset]);

    if (candidate) {
      return candidate;
    }
  }

  return null;
}

function findTimestampNearLine(lines, index, fallbackTimestamp) {
  const offsets = [0, -1, 1, -2, 2];

  for (const offset of offsets) {
    const timestamp = extractTimestamp(lines[index + offset]);

    if (timestamp) {
      return timestamp;
    }
  }

  return fallbackTimestamp || null;
}

function findLineMatch(lines, patterns) {
  for (let index = 0; index < lines.length; index += 1) {
    const line = cleanText(lines[index]);

    if (!line) {
      continue;
    }

    if (patterns.some((pattern) => pattern.test(line))) {
      return {
        index,
        line,
      };
    }
  }

  return null;
}

function extractModuleName(line) {
  const match = cleanText(line).match(/(?:Cannot find module|module not found)\s+['"]([^'"]+)['"]/i);
  return match ? match[1] : "";
}

function extractHostPort(line) {
  const match = cleanText(line).match(HOST_PORT_PATTERN);

  if (!match) {
    return null;
  }

  return {
    host: match[1],
    port: Number(match[2]),
  };
}

function pickPort(line, fallbackPort) {
  const hostPort = extractHostPort(line);

  if (hostPort?.port) {
    return hostPort.port;
  }

  const explicitPort = cleanText(line).match(/\bport\s+(\d{2,5})\b/i);

  if (explicitPort) {
    return Number(explicitPort[1]);
  }

  return fallbackPort || null;
}

function readServiceString(...values) {
  for (const value of values) {
    const text = cleanText(value);

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

function normalizeEndpointHost(value) {
  const host = cleanText(value).toLowerCase();

  if (!host) {
    return "";
  }

  if (host === "127.0.0.1" || host === "localhost" || host === "::1") {
    return "loopback";
  }

  return host;
}

function hostCompatible(left, right) {
  const normalizedLeft = normalizeEndpointHost(left);
  const normalizedRight = normalizeEndpointHost(right);

  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function normalizeEndpointPath(value) {
  const path = cleanText(value);

  if (!path) {
    return "";
  }

  const normalized = path.startsWith("/") ? path : `/${path}`;
  return normalized.replace(/\/+$/, "") || "/";
}

function safeParseUrl(value) {
  const text = cleanText(value);

  if (!text) {
    return null;
  }

  try {
    return new URL(text);
  } catch (_error) {
    return null;
  }
}

function buildEndpointCandidate({ raw, host, port, path = "", label = "endpoint" }) {
  const normalizedHost = normalizeEndpointHost(host);
  const normalizedPort = Number(port);

  if (!normalizedHost || !Number.isFinite(normalizedPort)) {
    return null;
  }

  return {
    raw: cleanText(raw) || `${host}:${normalizedPort}${path || ""}`,
    host: normalizedHost,
    originalHost: cleanText(host).toLowerCase(),
    port: normalizedPort,
    path: normalizeEndpointPath(path),
    label,
  };
}

function endpointFromUrl(value, label = "url") {
  const url = safeParseUrl(value);

  if (!url) {
    return null;
  }

  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  return buildEndpointCandidate({
    raw: cleanText(value),
    host: url.hostname,
    port,
    path: url.pathname || "",
    label,
  });
}

function endpointSignature(endpoint) {
  return [endpoint?.host, endpoint?.port, endpoint?.path].filter(Boolean).join("|");
}

function endpointPathMatches(left, right) {
  const normalizedLeft = normalizeEndpointPath(left);
  const normalizedRight = normalizeEndpointPath(right);

  if (!normalizedLeft || !normalizedRight) {
    return false;
  }

  return normalizedLeft === normalizedRight || normalizedLeft.startsWith(normalizedRight) || normalizedRight.startsWith(normalizedLeft);
}

function extractEndpointCandidates(text) {
  const value = cleanText(text);

  if (!value) {
    return [];
  }

  const endpoints = [];

  for (const match of value.matchAll(URL_CANDIDATE_PATTERN)) {
    const endpoint = endpointFromUrl(match[0], "log-url");

    if (endpoint) {
      endpoints.push(endpoint);
    }
  }

  for (const match of value.matchAll(HOST_PORT_CANDIDATE_PATTERN)) {
    const endpoint = buildEndpointCandidate({
      raw: match[0],
      host: match[1],
      port: Number(match[2]),
      path: match[3] || "",
      label: "log-host-port",
    });

    if (endpoint) {
      endpoints.push(endpoint);
    }
  }

  return uniqueBy(endpoints, endpointSignature);
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isUsefulServiceToken(value) {
  const token = cleanText(value).toLowerCase();

  if (!token || token.length < 4) {
    return false;
  }

  return !["service", "process", "runtime", "system", "pm2"].includes(token);
}

function getCatalogServiceId(service) {
  return readServiceString(service?.name, service?.serviceName, service?.id);
}

function getCatalogServiceName(service) {
  return readServiceString(service?.displayName, service?.name, service?.serviceName, service?.id);
}

function getCatalogServiceHost(service) {
  return normalizeHost(service?.host || service?.inventory?.host);
}

function getCatalogServiceManager(service) {
  return readServiceString(service?.manager, service?.inventory?.manager, service?.runtime?.manager);
}

function getCatalogProcessName(service) {
  return readServiceString(service?.processName, service?.inventory?.processName, service?.runtime?.processName);
}

function getCatalogLocalPort(service) {
  return readServiceNumber(service?.inventory?.localPort, service?.localPort);
}

function getCatalogLocalUrl(service) {
  return readServiceString(service?.inventory?.localUrl, service?.health?.localUrl, service?.localUrl);
}

function getCatalogLocalHealthUrl(service) {
  return readServiceString(service?.inventory?.localHealthUrl, service?.health?.url, service?.localHealthUrl);
}

function getCatalogLocalReadinessUrl(service) {
  return readServiceString(service?.inventory?.localReadinessUrl, service?.health?.readinessUrl, service?.localReadinessUrl);
}

function getCatalogPublicUrl(service) {
  return readServiceString(service?.inventory?.publicUrl, service?.health?.publicUrl, service?.publicUrl);
}

function extractUrlHost(value) {
  const url = safeParseUrl(value);
  return cleanText(url?.hostname).toLowerCase();
}

function extractPathReference(value) {
  const text = cleanText(value);

  if (!text) {
    return "";
  }

  if (text.startsWith("/")) {
    return normalizeEndpointPath(text);
  }

  const url = safeParseUrl(text);
  return normalizeEndpointPath(url?.pathname || "");
}

function isSpecificPath(value) {
  const path = normalizeEndpointPath(value);
  return Boolean(path && path !== "/");
}

function isControlPlanePath(value) {
  return normalizeEndpointPath(value).toLowerCase().startsWith("/admin/");
}

function textHasToken(text, token) {
  const value = cleanText(text).toLowerCase();
  const needle = cleanText(token).toLowerCase();

  if (!value || !needle) {
    return false;
  }

  return new RegExp(`(^|[^a-z0-9.-])${escapeRegex(needle)}([^a-z0-9.-]|$)`, "i").test(value);
}

function textIncludesPath(text, path) {
  const normalizedPath = normalizeEndpointPath(path);

  if (!isSpecificPath(normalizedPath)) {
    return false;
  }

  return cleanText(text).toLowerCase().includes(normalizedPath.toLowerCase());
}

function buildCatalogProvideRecord(provide) {
  if (!isPlainObject(provide)) {
    return null;
  }

  const endpoint = readServiceString(provide.endpoint);
  const healthEndpoint = readServiceString(provide.healthEndpoint);
  const readinessEndpoint = readServiceString(provide.readinessEndpoint);
  const publicHost = cleanText(provide.publicHost).toLowerCase();
  const endpoints = uniqueBy(
    [
      endpointFromUrl(endpoint, "provided-endpoint"),
      endpointFromUrl(healthEndpoint, "provided-health"),
      endpointFromUrl(readinessEndpoint, "provided-readiness"),
    ].filter(Boolean),
    endpointSignature,
  );
  const paths = uniqueValues(
    [
      ...normalizeStringArray(provide.paths).map((path) => normalizeEndpointPath(path)),
      ...endpoints.map((item) => item.path).filter(isSpecificPath),
    ].filter(Boolean),
  );

  return {
    kind: cleanText(provide.kind),
    endpoint,
    healthEndpoint,
    readinessEndpoint,
    publicHost,
    notes: cleanText(provide.notes),
    endpoints,
    paths,
  };
}

function buildCatalogDependencyRecord(dependency) {
  if (!isPlainObject(dependency)) {
    return null;
  }

  const serviceId = readServiceString(dependency.serviceId);
  const endpoint = readServiceString(dependency.endpoint);
  return {
    serviceId,
    serviceIdKey: cleanText(serviceId).toLowerCase(),
    relationship: cleanText(dependency.relationship),
    endpoint,
    required: dependency.required === true,
    confidence: cleanText(dependency.confidence).toLowerCase(),
    notes: cleanText(dependency.notes),
    endpointCandidate: endpointFromUrl(endpoint, "dependency-endpoint"),
    path: extractPathReference(endpoint),
  };
}

function buildServiceCatalog(services) {
  if (!Array.isArray(services)) {
    return [];
  }

  return services
    .map((service) => {
      const id = getCatalogServiceId(service);

      if (!id) {
        return null;
      }

      const displayName = getCatalogServiceName(service);
      const processName = getCatalogProcessName(service);
      const localHealthUrl = getCatalogLocalHealthUrl(service);
      const localReadinessUrl = getCatalogLocalReadinessUrl(service);
      const localUrl = getCatalogLocalUrl(service);
      const publicUrl = getCatalogPublicUrl(service);
      const localPort = getCatalogLocalPort(service);
      const provides = normalizeObjectCollection(service?.provides).map(buildCatalogProvideRecord).filter(Boolean);
      const dependencies = normalizeObjectCollection(service?.dependencies)
        .map(buildCatalogDependencyRecord)
        .filter((entry) => entry && (entry.serviceId || entry.endpoint || isSpecificPath(entry.path)));
      const endpoints = uniqueBy(
        [
          endpointFromUrl(localHealthUrl, "health"),
          endpointFromUrl(localReadinessUrl, "readiness"),
          endpointFromUrl(localUrl, "local"),
          endpointFromUrl(publicUrl, "public"),
          ...provides.flatMap((provide) => provide.endpoints),
          localPort
            ? buildEndpointCandidate({
                raw: `127.0.0.1:${localPort}`,
                host: "127.0.0.1",
                port: localPort,
                label: "local-port",
              })
            : null,
        ].filter(Boolean),
        endpointSignature,
      );
      const publicHosts = uniqueValues(
        [extractUrlHost(publicUrl), ...provides.map((provide) => provide.publicHost)].filter(Boolean),
      );
      const paths = uniqueValues(provides.flatMap((provide) => provide.paths).filter(Boolean));

      return {
        id,
        name: displayName || id,
        host: getCatalogServiceHost(service),
        manager: getCatalogServiceManager(service),
        processName,
        localHealthUrl,
        localReadinessUrl,
        localUrl,
        publicUrl,
        provides,
        dependencies,
        endpoints,
        publicHosts,
        paths,
        tokens: uniqueValues([id, processName, displayName]).map((token) => cleanText(token).toLowerCase()).filter(isUsefulServiceToken),
      };
    })
    .filter(Boolean);
}

function buildCorrelationConfidence(score) {
  if (score >= 10) {
    return "high";
  }

  if (score >= 7) {
    return "medium";
  }

  return "low";
}

function getCorrelationCommand(service) {
  if (!service) {
    return "";
  }

  if (service.host === "windows" && service.manager === "pm2") {
    const healthUrl = readServiceString(service.localHealthUrl, service.localReadinessUrl, service.localUrl);

    if (healthUrl) {
      return `Invoke-RestMethod ${quoteCommandValue(healthUrl)}`;
    }

    return `pm2 logs ${quoteCommandValue(service.processName || service.id || "service")} --lines 160 --nostream`;
  }

  if (service.host === "fedora") {
    if (CONTROL_PLANE_IDS.has(cleanText(service.id).toLowerCase())) {
      return `Fetch logs for ${service.id} through Garage Admin.`;
    }

    return `Check service status for ${service.id} through Garage Admin.`;
  }

  return "";
}

function shouldAllowSelfCorrelation(issue, context) {
  if (normalizeIssueSource(issue?.source) === "health") {
    return true;
  }

  return ["Health check failed", "Local port unavailable", "Runtime status"].includes(issue?.primaryIssue);
}

function isSelfServiceCandidate(service, context) {
  const serviceId = cleanText(service?.id).toLowerCase();
  const processName = cleanText(service?.processName).toLowerCase();
  const contextServiceId = cleanText(context?.serviceName).toLowerCase();
  const contextProcessName = cleanText(context?.processName).toLowerCase();

  return Boolean(
    (serviceId && contextServiceId && serviceId === contextServiceId) ||
      (processName && contextProcessName && processName === contextProcessName),
  );
}

function buildServiceMentionMatch(service, text) {
  for (const token of service.tokens || []) {
    if (textHasToken(text, token)) {
      return {
        score: 10,
        relatedEndpoint: readServiceString(service.localHealthUrl, service.localReadinessUrl, service.localUrl, service.publicUrl),
        correlationReason: "Matched service/process name",
      };
    }
  }

  return null;
}

function buildEndpointCorrelationMatches(service, endpoints, issue) {
  const matches = [];

  endpoints.forEach((endpoint) => {
    (service.endpoints || []).forEach((serviceEndpoint) => {
      if (!hostCompatible(endpoint.host, serviceEndpoint.host) || endpoint.port !== serviceEndpoint.port) {
        return;
      }

      let score = 8;
      const pathMatches = endpointPathMatches(endpoint.path, serviceEndpoint.path);
      const isHealthMatch = isHealthEndpointLabel(serviceEndpoint.label) && pathMatches;

      if (endpoint.originalHost && serviceEndpoint.originalHost && endpoint.originalHost === serviceEndpoint.originalHost) {
        score += 1;
      }

      if (isHealthMatch) {
        score += 1;
      }

      if (pathMatches) {
        score += 1;
      }

      matches.push({
        score,
        relatedEndpoint: endpoint.raw || serviceEndpoint.raw,
        correlationReason: isHealthMatch ? "Matched provided health endpoint" : "Fallback inference",
      });
    });
  });

  return matches;
}

function isHealthEndpointLabel(label) {
  return ["health", "readiness", "provided-health", "provided-readiness"].includes(cleanText(label).toLowerCase());
}

function candidateMatchesServiceHealthEndpoint(service, endpointCandidate) {
  if (!endpointCandidate) {
    return false;
  }

  return (service?.endpoints || []).some((serviceEndpoint) => {
    if (!isHealthEndpointLabel(serviceEndpoint.label)) {
      return false;
    }

    return (
      hostCompatible(endpointCandidate.host, serviceEndpoint.host) &&
      endpointCandidate.port === serviceEndpoint.port &&
      endpointPathMatches(endpointCandidate.path, serviceEndpoint.path)
    );
  });
}

function buildProvidedMetadataMatches(service, text, endpoints, options = {}) {
  const matches = [];
  const baseScore = Number(options.baseScore) || 10;
  const fallbackReason = cleanText(options.fallbackReason) || "Fallback inference";
  const healthReason = cleanText(options.healthReason) || "Matched provided health endpoint";
  const publicHostReason = cleanText(options.publicHostReason) || "Matched public host";

  (service.provides || []).forEach((provide) => {
    if (provide.publicHost && textHasToken(text, provide.publicHost)) {
      matches.push({
        score: baseScore + 2,
        relatedEndpoint: provide.publicHost,
        correlationReason: publicHostReason,
      });
    }

    (provide.paths || []).forEach((path) => {
      if (!textIncludesPath(text, path)) {
        return;
      }

      if (!isControlPlanePath(path) && options.allowGenericPath !== true) {
        return;
      }

      matches.push({
        score: baseScore + 2,
        relatedEndpoint: readServiceString(provide.healthEndpoint, provide.endpoint, path),
        correlationReason: fallbackReason,
      });
    });

    endpoints.forEach((endpoint) => {
      (provide.endpoints || []).forEach((serviceEndpoint) => {
        if (!hostCompatible(endpoint.host, serviceEndpoint.host) || endpoint.port !== serviceEndpoint.port) {
          return;
        }

        let score = baseScore + 1;
        const pathMatches = endpointPathMatches(endpoint.path, serviceEndpoint.path);
        const isHealthMatch = isHealthEndpointLabel(serviceEndpoint.label) && pathMatches;

        if (pathMatches) {
          score += 1;
        }

        if (isHealthMatch) {
          score += 1;
        }

        matches.push({
          score,
          relatedEndpoint:
            endpoint.raw ||
            serviceEndpoint.raw ||
            readServiceString(provide.healthEndpoint, provide.readinessEndpoint, provide.endpoint),
          correlationReason: isHealthMatch ? healthReason : fallbackReason,
        });
      });
    });
  });

  return matches;
}

function buildDeclaredDependencyMatches(contextService, dependency, targetService, text, endpoints) {
  if (!targetService) {
    return [];
  }

  const matches = [];

  if (dependency.serviceId && textHasToken(text, dependency.serviceId)) {
    matches.push({
      score: 14,
      relatedEndpoint: readServiceString(
        dependency.endpoint,
        targetService.localHealthUrl,
        targetService.localReadinessUrl,
        targetService.localUrl,
        targetService.publicUrl,
      ),
      correlationReason: "Matched declared dependency",
    });
  }

  if (targetService.processName && textHasToken(text, targetService.processName)) {
    matches.push({
      score: 13,
      relatedEndpoint: readServiceString(
        dependency.endpoint,
        targetService.localHealthUrl,
        targetService.localReadinessUrl,
        targetService.localUrl,
        targetService.publicUrl,
      ),
      correlationReason: "Matched service/process name",
    });
  }

  if (dependency.endpointCandidate) {
    endpoints.forEach((endpoint) => {
      if (!hostCompatible(endpoint.host, dependency.endpointCandidate.host) || endpoint.port !== dependency.endpointCandidate.port) {
        return;
      }

      let score = 13;
      const pathMatches = endpointPathMatches(endpoint.path, dependency.endpointCandidate.path);

      if (pathMatches) {
        score += 1;
      }

      matches.push({
        score,
        relatedEndpoint: dependency.endpoint || dependency.endpointCandidate.raw || endpoint.raw,
        correlationReason:
          pathMatches && candidateMatchesServiceHealthEndpoint(targetService, dependency.endpointCandidate)
            ? "Matched provided health endpoint"
            : "Matched declared dependency",
      });
    });
  }

  if (dependency.path && isControlPlanePath(dependency.path) && textIncludesPath(text, dependency.path)) {
    matches.push({
      score: 13,
      relatedEndpoint: dependency.endpoint || dependency.path,
      correlationReason: "Matched declared dependency",
    });
  }

  buildProvidedMetadataMatches(targetService, text, endpoints, {
    baseScore: 12,
    fallbackReason: "Matched declared dependency",
  }).forEach((match) => matches.push(match));

  return matches;
}

function buildControlPlaneHeuristicMatch(service, text) {
  const serviceId = cleanText(service?.id).toLowerCase();
  const lowerText = cleanText(text).toLowerCase();

  if (!CONTROL_PLANE_IDS.has(serviceId)) {
    return null;
  }

  if (serviceId === "node-agent" && (/\bnode-agent\b/i.test(lowerText) || /\bagent health\b/i.test(lowerText))) {
    return {
      score: 8,
      relatedEndpoint: readServiceString(service.localHealthUrl, service.localUrl, service.publicUrl),
      correlationReason: "Fallback inference",
    };
  }

  if (serviceId === "admin-proxy" && (/\badmin-proxy\b/i.test(lowerText) || /\bproxy\b/i.test(lowerText) || /\/admin\//i.test(lowerText))) {
    return {
      score: 7,
      relatedEndpoint: readServiceString(service.publicUrl, service.localUrl, service.localHealthUrl),
      correlationReason: "Fallback inference",
    };
  }

  if (serviceId === "aibry-admin" && (/\baibry-admin\b/i.test(lowerText) || /\bbridge\b/i.test(lowerText) || /\bcontrol-plane\b/i.test(lowerText))) {
    return {
      score: 7,
      relatedEndpoint: readServiceString(service.publicUrl, service.localHealthUrl, service.localUrl),
      correlationReason: "Fallback inference",
    };
  }

  return null;
}

function correlateIssue(context, issue) {
  const catalog = buildServiceCatalog(context.services);

  if (!catalog.length) {
    return null;
  }

  const catalogById = new Map(catalog.map((service) => [cleanText(service.id).toLowerCase(), service]));
  const contextService =
    catalogById.get(cleanText(context.serviceName).toLowerCase()) ||
    catalog.find((service) => isSelfServiceCandidate(service, context)) ||
    null;
  const evidenceText = cleanText(issue?.mostRelevantError || issue?.errorMessage || issue?.primaryIssue);
  const endpoints = extractEndpointCandidates(evidenceText);
  const matches = [];

  if (contextService) {
    (contextService.dependencies || []).forEach((dependency) => {
      const targetService = catalogById.get(cleanText(dependency.serviceIdKey || dependency.serviceId).toLowerCase()) || null;

      if (!targetService) {
        return;
      }

      if (!shouldAllowSelfCorrelation(issue, context) && isSelfServiceCandidate(targetService, context)) {
        return;
      }

      buildDeclaredDependencyMatches(contextService, dependency, targetService, evidenceText, endpoints).forEach((match) => {
        matches.push({
          service: targetService,
          ...match,
        });
      });
    });
  }

  catalog.forEach((service) => {
    if (!shouldAllowSelfCorrelation(issue, context) && isSelfServiceCandidate(service, context)) {
      return;
    }

    buildProvidedMetadataMatches(service, evidenceText, endpoints).forEach((match) => {
      matches.push({
        service,
        ...match,
      });
    });

    const mentionMatch = buildServiceMentionMatch(service, evidenceText);

    if (mentionMatch) {
      matches.push({
        service,
        ...mentionMatch,
      });
    }

    buildEndpointCorrelationMatches(service, endpoints, issue).forEach((match) => {
      matches.push({
        service,
        ...match,
      });
    });

    const heuristicMatch = buildControlPlaneHeuristicMatch(service, evidenceText);

    if (heuristicMatch) {
      matches.push({
        service,
        ...heuristicMatch,
      });
    }
  });

  if (!matches.length && shouldAllowSelfCorrelation(issue, context)) {
    const selfService = catalog.find((service) => isSelfServiceCandidate(service, context));

    if (selfService) {
      matches.push({
        service: selfService,
        score: 8,
        relatedEndpoint: readServiceString(selfService.localHealthUrl, selfService.localReadinessUrl, selfService.localUrl),
        correlationReason: "Fallback inference",
      });
    }
  }

  if (!matches.length) {
    return null;
  }

  matches.sort((left, right) => right.score - left.score);

  const bestMatch = matches[0];
  const nextDistinctMatch =
    matches.find(
      (candidate, index) => index > 0 && cleanText(candidate?.service?.id).toLowerCase() !== cleanText(bestMatch?.service?.id).toLowerCase(),
    ) || null;

  if (bestMatch.score < 7) {
    return null;
  }

  if (nextDistinctMatch && bestMatch.score <= nextDistinctMatch.score) {
    return null;
  }

  return {
    relatedServiceId: bestMatch.service.id,
    relatedServiceName: bestMatch.service.name,
    relatedServiceHost: bestMatch.service.host,
    relatedServiceManager: bestMatch.service.manager,
    relatedEndpoint: bestMatch.relatedEndpoint || readServiceString(bestMatch.service.localHealthUrl, bestMatch.service.localUrl, bestMatch.service.publicUrl),
    correlationReason: bestMatch.correlationReason,
    correlationConfidence: buildCorrelationConfidence(bestMatch.score),
    correlatedSuggestedCommand: getCorrelationCommand(bestMatch.service),
  };
}

function applyCorrelationToIssue(context, issue) {
  const correlation = correlateIssue(context, issue);

  if (!correlation) {
    return {
      ...issue,
      relatedServiceId: "",
      relatedServiceName: "",
      relatedServiceHost: "",
      relatedServiceManager: "",
      relatedEndpoint: "",
      correlationReason: "",
      correlationConfidence: "",
    };
  }

  const relatedLabel = correlation.relatedServiceName || correlation.relatedServiceId;
  const isSelfCorrelation = cleanText(correlation.relatedServiceId).toLowerCase() === cleanText(context.serviceName).toLowerCase();
  const suggestedCommand = correlation.correlatedSuggestedCommand || issue.suggestedCommand || "";
  const suggestedActions = uniqueValues([
    correlation.relatedServiceHost === "windows"
      ? `Review ${relatedLabel} health or PM2 logs before retrying ${context.serviceName}.`
      : `Use Garage Admin to inspect ${relatedLabel} before retrying the failing request.`,
    ...issue.suggestedActions,
  ]).slice(0, 4);

  return {
    ...issue,
    ...correlation,
    suggestedCommand,
    suggestedCheck: suggestedCommand,
    suggestedNextStep: isSelfCorrelation
      ? issue.suggestedNextStep
      : `Check ${relatedLabel}${correlation.relatedEndpoint ? ` at ${correlation.relatedEndpoint}` : ""} before retrying the failing dependency call.`,
    suggestedActions,
  };
}

function getActionStatus(action) {
  return normalizeStatus(action?.status || action?.action?.status);
}

function getActionTimestamp(action) {
  return (
    action?.createdAt ||
    action?.action?.createdAt ||
    action?.executedAt ||
    action?.result?.executedAt ||
    null
  );
}

function getActionCode(action) {
  return cleanText(
    action?.result?.data?.code ||
      action?.result?.code ||
      action?.data?.code ||
      action?.code,
  );
}

function getActionError(action) {
  return cleanText(
    action?.result?.data?.message ||
      action?.result?.error ||
      action?.error ||
      action?.data?.message ||
      action?.output?.restart?.message ||
      action?.output?.health?.error,
  );
}

function buildStatusCommand(context) {
  const target = quoteCommandValue(context.processName || context.serviceName || "service");

  if (context.host === "windows" || context.manager === "pm2" || context.processName) {
    return `pm2 status ${target || "all"}`;
  }

  return `systemctl status ${target || "service"} --no-pager`;
}

function buildLogCommand(context) {
  const target = quoteCommandValue(context.processName || context.serviceName || "service");

  if (context.host === "windows" || context.manager === "pm2" || context.processName) {
    return `pm2 logs ${target || "all"} --lines 160 --nostream`;
  }

  return `journalctl -u ${target || "service"} -n 160 --no-pager`;
}

function buildPortCommand(context, explicitPort) {
  const port = explicitPort || context.localPort;

  if (!port) {
    return buildStatusCommand(context);
  }

  if (context.host === "windows") {
    return `Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,OwningProcess,State`;
  }

  return `ss -ltnp | grep ':${port} '`;
}

function buildEndpointCommand(context, endpoint) {
  if (!endpoint?.host || !endpoint?.port) {
    return buildUrlCommand(context);
  }

  if (context.host === "windows") {
    return `Test-NetConnection ${endpoint.host} -Port ${endpoint.port}`;
  }

  return `nc -vz ${endpoint.host} ${endpoint.port}`;
}

function buildUrlCommand(context, overrideUrl = "") {
  const url = cleanText(overrideUrl || context.localHealthUrl || context.localReadinessUrl || context.localUrl || context.publicUrl);

  if (!url) {
    return buildStatusCommand(context);
  }

  if (context.host === "windows") {
    return `Invoke-WebRequest ${quoteCommandValue(url)} -UseBasicParsing -Method Get`;
  }

  return `curl -i ${quoteCommandValue(url)}`;
}

function getHealthSummary(context) {
  const localHttp = context.service?.health?.checks?.localHttp || {};
  const localPort = context.service?.health?.checks?.localPort || {};

  if (context.healthOutput?.status || typeof context.healthOutput?.ok === "boolean") {
    return `${context.healthOutput.ok ? "OK" : "Attention"}${
      context.healthOutput.status ? ` · HTTP ${context.healthOutput.status}` : ""
    }`;
  }

  if (localHttp.checkedAt) {
    return localHttp.ok
      ? `Local HTTP ok${localHttp.status ? ` · HTTP ${localHttp.status}` : ""}`
      : `Local HTTP failed${localHttp.status ? ` · HTTP ${localHttp.status}` : ""}`;
  }

  if (localPort.checkedAt) {
    const port = localPort.port || context.localPort;
    return localPort.ok ? `Port ${port} listening` : `Port ${port} unavailable`;
  }

  return "No health result yet";
}

function buildBaseHighlights(context) {
  return [
    {
      label: "Service status",
      value: titleCaseWord(normalizeStatus(context.status)),
    },
    {
      label: "Log alerts",
      value: cleanText(context.logSignals?.summary) || "No current logs",
    },
    {
      label: "Health",
      value: getHealthSummary(context),
    },
    {
      label: "Latest action",
      value: cleanText(context.latestActionText) || "No action result yet",
    },
  ];
}

function buildIssueHighlights(context, issue) {
  const timestamp = issue.timestamp || context.logsFetchedAt || context.healthMeta?.receivedAt || getActionTimestamp(context.latestAction);
  const severity = normalizeSeverity(issue.severity || severityFromRiskLevel(issue.riskLevel));

  return [
    {
      label: "Detected error",
      value: issue.errorType || issue.primaryIssue,
    },
    {
      label: "Severity",
      value: titleCaseWord(severity),
    },
    {
      label: "Source",
      value: titleCaseWord(issue.source || "logs"),
    },
    {
      label: "Detected at",
      value: timestamp || "Latest output",
    },
    issue.fileName
      ? {
          label: "File",
          value: issue.lineNumber ? `${issue.fileName}:${issue.lineNumber}` : issue.fileName,
        }
      : null,
  ].filter(Boolean);
}

function hasFailedHealthSignal(context) {
  const localHttp = context.service?.health?.checks?.localHttp || {};
  const localPort = context.service?.health?.checks?.localPort || {};

  return (
    context.healthOutput?.ok === false ||
    (localHttp.checkedAt && localHttp.ok === false) ||
    (localPort.checkedAt && localPort.ok === false)
  );
}

function hasFailedActionSignal(context) {
  return getActionStatus(context.failedAction || context.latestAction) === "failed";
}

function resolveIssueSource(context, sourceValue) {
  const source = normalizeIssueSource(sourceValue);

  if (source === "none" || source === "combined") {
    return source;
  }

  if (source === "logs" && (hasFailedHealthSignal(context) || hasFailedActionSignal(context))) {
    return "combined";
  }

  if (source === "health" && hasFailedActionSignal(context)) {
    return "combined";
  }

  if (source === "action" && hasFailedHealthSignal(context)) {
    return "combined";
  }

  return source;
}

function finalizeIssue(context, issue) {
  const timestamp =
    issue.timestamp ||
    context.logsFetchedAt ||
    context.healthMeta?.receivedAt ||
    getActionTimestamp(context.latestAction) ||
    null;
  const severity = normalizeSeverity(issue.severity || severityFromRiskLevel(issue.riskLevel));
  const mostRelevantError = cleanText(issue.mostRelevantError || issue.errorMessage || issue.primaryIssue);
  const suggestedActions = uniqueValues(issue.suggestedActions || []).slice(0, 4);
  const suggestedNextStep = cleanText(issue.suggestedNextStep || suggestedActions[0]);
  const source = resolveIssueSource(context, issue.source || "logs");

  const result = {
    detected: true,
    source,
    severity,
    primaryIssue: issue.primaryIssue,
    likelyCause: issue.likelyCause,
    errorType: issue.errorType || "",
    mostRelevantError,
    errorMessage: mostRelevantError,
    filePath: issue.filePath || "",
    fileName: issue.fileName || fileNameFromPath(issue.filePath),
    lineNumber: issue.lineNumber || null,
    columnNumber: issue.columnNumber || null,
    affectedService: issue.affectedService || context.serviceName || "",
    timestamp,
    suggestedNextStep,
    suggestedCommand: issue.suggestedCommand || "",
    suggestedCheck: issue.suggestedCommand || "",
    suggestedActions,
    riskLevel: riskLevelFromSeverity(severity),
    confidence: issue.confidence || "medium",
    highlights: (issue.highlights || buildIssueHighlights(context, { ...issue, timestamp })).filter((item) =>
      cleanText(item?.value),
    ),
  };

  return applyCorrelationToIssue(context, result);
}

function buildSyntaxIssue(context, lines, match) {
  const fileReference = findNearbyFileReference(lines, match.index);

  return finalizeIssue(context, {
    source: "logs",
    primaryIssue: "Node syntax failure",
    likelyCause: fileReference?.fileName
      ? `${fileReference.fileName} cannot be parsed.`
      : "The service failed during JavaScript parse time.",
    errorType: "SyntaxError",
    mostRelevantError: match.line,
    filePath: fileReference?.filePath || "",
    fileName: fileReference?.fileName || "",
    lineNumber: fileReference?.lineNumber || null,
    columnNumber: fileReference?.columnNumber || null,
    timestamp: findTimestampNearLine(lines, match.index, context.logsFetchedAt),
    suggestedCommand: fileReference?.filePath
      ? `node --check ${quoteCommandValue(fileReference.filePath)}`
      : buildLogCommand(context),
    suggestedNextStep: fileReference?.filePath ? "Run a syntax check on the referenced file." : "Inspect the syntax failure in the current logs.",
    suggestedActions: [
      "Inspect the referenced file and line.",
      "Run a syntax check.",
      "Prepare a patch after approval.",
      "Restart the service after the patch is approved.",
    ],
    severity: "critical",
    confidence: fileReference?.filePath ? "high" : "medium",
  });
}

function buildJavascriptRuntimeIssue(context, lines, match, errorType) {
  const fileReference = findNearbyFileReference(lines, match.index);
  const runtimeLabel = errorType || "RuntimeError";

  return finalizeIssue(context, {
    source: "logs",
    primaryIssue: `${runtimeLabel} in service runtime`,
    likelyCause: fileReference?.fileName
      ? `${fileReference.fileName} is throwing ${runtimeLabel} during execution.`
      : `The service raised an unhandled ${runtimeLabel}.`,
    errorType: runtimeLabel,
    mostRelevantError: match.line,
    filePath: fileReference?.filePath || "",
    fileName: fileReference?.fileName || "",
    lineNumber: fileReference?.lineNumber || null,
    columnNumber: fileReference?.columnNumber || null,
    timestamp: findTimestampNearLine(lines, match.index, context.logsFetchedAt),
    suggestedCommand: buildLogCommand(context),
    suggestedNextStep: "Inspect the stack frame that names the failing file and line.",
    suggestedActions: [
      "Inspect the failing file and line from the stack trace.",
      "Review the referenced variable or object state.",
      "Prepare a patch after approval.",
      "Restart the service only after the code path is corrected.",
    ],
    severity: "critical",
    confidence: fileReference?.filePath ? "high" : "medium",
  });
}

function buildModuleIssue(context, lines, match) {
  const moduleName = extractModuleName(match.line);
  const fileReference = findNearbyFileReference(lines, match.index);

  return finalizeIssue(context, {
    source: "logs",
    primaryIssue: "Node module resolution failure",
    likelyCause: moduleName
      ? `The service cannot resolve ${moduleName}.`
      : "A required module or import path could not be resolved.",
    errorType: /MODULE_NOT_FOUND/i.test(match.line) ? "MODULE_NOT_FOUND" : "Module not found",
    mostRelevantError: match.line,
    filePath: fileReference?.filePath || "",
    fileName: fileReference?.fileName || "",
    lineNumber: fileReference?.lineNumber || null,
    columnNumber: fileReference?.columnNumber || null,
    timestamp: findTimestampNearLine(lines, match.index, context.logsFetchedAt),
    suggestedCommand: buildLogCommand(context),
    suggestedNextStep: moduleName
      ? `Confirm that ${moduleName} exists in the deployed runtime.`
      : "Inspect the failing import or require path in the current logs.",
    suggestedActions: [
      "Review the failing import or require path.",
      "Confirm the dependency or built artifact exists on the host.",
      "Prepare a patch after approval.",
      "Restart the service only after the missing module is corrected.",
    ],
    severity: "critical",
    confidence: moduleName ? "high" : "medium",
  });
}

function buildPortInUseIssue(context, lines, match) {
  const port = pickPort(match.line, context.localPort);

  return finalizeIssue(context, {
    source: "logs",
    primaryIssue: "Port binding failure",
    likelyCause: port
      ? `Another process is already listening on port ${port}.`
      : "Another process is already using the configured listener port.",
    errorType: "EADDRINUSE",
    mostRelevantError: match.line,
    timestamp: findTimestampNearLine(lines, match.index, context.logsFetchedAt),
    suggestedCommand: buildPortCommand(context, port),
    suggestedNextStep: "Identify which process already holds the listener port.",
    suggestedActions: [
      "Identify the process holding the port.",
      "Confirm the expected local port for this service.",
      "Stop or reconfigure the conflicting process.",
      "Restart the service after the port conflict is cleared.",
    ],
    severity: "critical",
    confidence: "high",
  });
}

function buildUnsupportedActionIssue(context, errorMessage, timestamp) {
  return finalizeIssue(context, {
    source: "action",
    primaryIssue: "Unsupported control-plane action",
    likelyCause: "The requested action is not enabled for this host or service.",
    errorType: "409 Unsupported action",
    mostRelevantError: errorMessage || "The latest action returned a 409 unsupported action response.",
    timestamp,
    suggestedCommand: buildStatusCommand(context),
    suggestedNextStep: "Use a read-only action first and confirm the host/runtime mapping.",
    suggestedActions: [
      "Use fetch logs or health check instead of retrying the same action.",
      "Review the service restart capability for the selected host.",
      "Confirm the operator is working on the correct host and service.",
    ],
    severity: "info",
    confidence: "high",
  });
}

function buildUnauthorizedIssue(context, errorMessage, timestamp, source = "health") {
  return finalizeIssue(context, {
    source,
    primaryIssue: "Authentication failure",
    likelyCause: "A required token, bridge credential, or access session is missing or expired.",
    errorType: "401 Unauthorized",
    mostRelevantError: errorMessage,
    timestamp,
    suggestedCommand: buildUrlCommand(context),
    suggestedNextStep: "Confirm the request includes the expected credential or access token.",
    suggestedActions: [
      "Confirm the expected auth header or token is present.",
      "Verify the operator still has a valid access session.",
      "Retry the request after credentials are refreshed.",
    ],
    severity: "warning",
    confidence: "high",
  });
}

function buildForbiddenIssue(context, errorMessage, timestamp, source = "health") {
  return finalizeIssue(context, {
    source,
    primaryIssue: "Access policy failure",
    likelyCause: "Cloudflare Access or another upstream policy denied the request.",
    errorType: "403 Forbidden",
    mostRelevantError: errorMessage,
    timestamp,
    suggestedCommand: buildUrlCommand(context),
    suggestedNextStep: "Confirm that access policy and identity context still permit this route.",
    suggestedActions: [
      "Verify the access policy for the selected route.",
      "Confirm the request includes the expected identity context.",
      "Retry only after access is restored.",
    ],
    severity: "warning",
    confidence: "high",
  });
}

function buildRouteIssue(context, errorMessage, timestamp, source = "health") {
  return finalizeIssue(context, {
    source,
    primaryIssue: "Route not found",
    likelyCause: "The selected path is missing, misspelled, or not routed to the expected service.",
    errorType: "404 Route not found",
    mostRelevantError: errorMessage,
    timestamp,
    suggestedCommand: buildUrlCommand(context),
    suggestedNextStep: "Compare the requested path with the expected route mapping.",
    suggestedActions: [
      "Confirm the expected route and base path.",
      "Compare the route against the frontend or proxy configuration.",
      "Retry after the route mapping is corrected.",
    ],
    severity: "warning",
    confidence: "high",
  });
}

function buildUpstreamIssue(context, errorMessage, timestamp, source = "health") {
  return finalizeIssue(context, {
    source,
    primaryIssue: "Upstream unavailable",
    likelyCause: "The proxy target or upstream service is not responding.",
    errorType: "502 Upstream unavailable",
    mostRelevantError: errorMessage,
    timestamp,
    suggestedCommand: buildUrlCommand(context),
    suggestedNextStep: "Verify that the upstream listener is reachable before retrying.",
    suggestedActions: [
      "Confirm the upstream service is listening.",
      "Inspect proxy or bridge target configuration.",
      "Fetch fresh logs before attempting a restart.",
    ],
    severity: "warning",
    confidence: "high",
  });
}

function buildExitIssue(context, lines, match) {
  const restartCount = Number(context.runtimeRestarts);
  const repeatedTooQuickly = /Start request repeated too quickly/i.test(match.line);
  const hasExitCode = /Failed with result 'exit-code'|status=1\/FAILURE/i.test(match.line);

  return finalizeIssue(context, {
    source: "logs",
    primaryIssue: repeatedTooQuickly ? "Service restart loop" : "Service exited during startup",
    likelyCause: repeatedTooQuickly
      ? "The supervisor is throttling restarts after repeated failures."
      : hasExitCode
        ? "The service process is exiting with a non-zero status."
        : restartCount >= 3
          ? `${context.serviceName} has restarted ${restartCount} times in the current runtime window.`
          : "The service is exiting before it can stay healthy.",
    errorType: repeatedTooQuickly ? "Restart loop" : "Exit code failure",
    mostRelevantError: match.line,
    timestamp: findTimestampNearLine(lines, match.index, context.logsFetchedAt),
    suggestedCommand: buildLogCommand(context),
    suggestedNextStep: "Inspect the first error line that appears before the exit or restart loop.",
    suggestedActions: [
      "Inspect the preceding error lines for the first failure.",
      "Review config, environment, and startup dependencies.",
      "Patch the root cause before requesting another restart.",
      "Use restart only after the failure mode is understood.",
    ],
    severity: "critical",
    confidence: repeatedTooQuickly || hasExitCode ? "high" : "medium",
  });
}

function buildConnectionRefusedIssue(context, lines, match) {
  const endpoint = extractHostPort(match.line);
  const endpointText = endpoint ? `${endpoint.host}:${endpoint.port}` : "the required upstream dependency";

  return finalizeIssue(context, {
    source: "logs",
    primaryIssue: "Dependency connection refused",
    likelyCause: `${endpointText} is not accepting connections.`,
    errorType: "ECONNREFUSED",
    mostRelevantError: match.line,
    timestamp: findTimestampNearLine(lines, match.index, context.logsFetchedAt),
    suggestedCommand: buildEndpointCommand(context, endpoint),
    suggestedNextStep: "Verify the target host and port before retrying the connection.",
    suggestedActions: [
      "Confirm the upstream listener is running.",
      "Verify the configured host and port.",
      "Inspect both service logs before retrying the connection.",
    ],
    severity: "warning",
    confidence: endpoint ? "high" : "medium",
  });
}

function buildTimeoutIssue(context, lines, match) {
  return finalizeIssue(context, {
    source: "logs",
    primaryIssue: "Dependency timeout",
    likelyCause: "A startup or upstream dependency did not respond before the timeout window elapsed.",
    errorType: "Timeout",
    mostRelevantError: match.line,
    timestamp: findTimestampNearLine(lines, match.index, context.logsFetchedAt),
    suggestedCommand: buildUrlCommand(context),
    suggestedNextStep: "Check whether the upstream dependency is slow, unavailable, or overloaded.",
    suggestedActions: [
      "Confirm the upstream service is healthy and responsive.",
      "Inspect recent latency or resource pressure on the host.",
      "Retry only after the timeout condition is understood.",
    ],
    severity: "warning",
    confidence: "medium",
  });
}

function buildLocalPortIssue(context, timestamp) {
  const port = context.service?.health?.checks?.localPort?.port || context.localPort;

  return finalizeIssue(context, {
    source: "health",
    primaryIssue: "Local port unavailable",
    likelyCause: port
      ? `The service is not listening on port ${port}.`
      : "The expected local listener is unavailable.",
    errorType: "Health check failed",
    mostRelevantError: port ? `Port ${port} check failed.` : "Local port check failed.",
    timestamp,
    suggestedCommand: buildPortCommand(context, port),
    suggestedNextStep: "Confirm the process is running before retrying the health check.",
    suggestedActions: [
      "Verify the process is running.",
      "Fetch current logs to find the startup failure.",
      "Run the health check again after the listener is restored.",
    ],
    severity: "warning",
    confidence: "medium",
  });
}

function buildGenericHealthIssue(context, localHttp, timestamp) {
  return finalizeIssue(context, {
    source: "health",
    primaryIssue: "Health check failed",
    likelyCause: "The service health probe is returning a non-OK result.",
    errorType: "Health check failed",
    mostRelevantError: localHttp?.status ? `HTTP ${localHttp.status}` : localHttp?.error || "Health probe failed.",
    timestamp,
    suggestedCommand: buildUrlCommand(context),
    suggestedNextStep: "Correlate the failing health response with the most recent service logs.",
    suggestedActions: [
      "Confirm the expected health endpoint and response.",
      "Fetch logs to correlate the health failure with recent errors.",
      "Review recent audit entries before taking action.",
    ],
    severity: "warning",
    confidence: "medium",
  });
}

function buildGenericActionFailure(context, errorMessage, timestamp) {
  return finalizeIssue(context, {
    source: "action",
    primaryIssue: "Recent action failed",
    likelyCause: "The latest operator action did not complete successfully.",
    errorType: "Action failure",
    mostRelevantError: errorMessage || "The latest action returned a failed result.",
    timestamp,
    suggestedCommand: buildStatusCommand(context),
    suggestedNextStep: "Review the action result before attempting another control-plane change.",
    suggestedActions: [
      "Review the action result details.",
      "Fetch current logs before retrying.",
      "Confirm service state and host context first.",
    ],
    severity: "warning",
    confidence: "medium",
  });
}

function buildRestartCountIssue(context) {
  return finalizeIssue(context, {
    source: "combined",
    primaryIssue: "Elevated restart count",
    likelyCause: `${context.serviceName} has restarted ${context.runtimeRestarts} times in the current runtime window.`,
    errorType: "Restart counter",
    mostRelevantError: `${context.runtimeRestarts} recent restarts detected.`,
    suggestedCommand: buildLogCommand(context),
    suggestedNextStep: "Review the first failing restart in the current runtime window.",
    suggestedActions: [
      "Inspect the earliest failing log lines in the current window.",
      "Review config drift or dependency availability.",
      "Avoid repeated restarts until the failure pattern is clear.",
    ],
    severity: "warning",
    confidence: "medium",
  });
}

function buildServiceStatusIssue(context) {
  return finalizeIssue(context, {
    source: "combined",
    primaryIssue: "Service not healthy",
    likelyCause: `Current service status is ${context.status || "unknown"} and no higher-confidence error signature was found.`,
    errorType: "Runtime status",
    mostRelevantError: `Service status: ${context.status || "unknown"}`,
    suggestedCommand: buildStatusCommand(context),
    suggestedNextStep: "Fetch fresh logs and a health check before considering restart or remediation.",
    suggestedActions: [
      "Fetch logs from the selected service.",
      "Run a health check.",
      "Review recent audit entries before taking action.",
    ],
    severity: "warning",
    confidence: "low",
  });
}

function buildPm2ProcessIssue(context, lines, match) {
  const hasScriptNotFound = /script not found/i.test(match.line);
  const hasRestartFailure = /too many unstable restarts|exited with code|errored/i.test(match.line);

  return finalizeIssue(context, {
    source: "logs",
    primaryIssue: "PM2 process failure",
    likelyCause: hasScriptNotFound
      ? "PM2 could not find the configured script or entrypoint."
      : hasRestartFailure
        ? "PM2 reported a process exit or unstable restart loop."
        : "PM2 reported an unhealthy process state.",
    errorType: "PM2 process failure",
    mostRelevantError: match.line,
    timestamp: findTimestampNearLine(lines, match.index, context.logsFetchedAt),
    suggestedCommand: buildStatusCommand(context),
    suggestedNextStep: "Check PM2 status and the most recent process logs before requesting a restart.",
    suggestedActions: [
      "Review the PM2 process state and restart count.",
      "Fetch the current PM2 logs for the affected service.",
      "Correct the script, environment, or startup command before retrying.",
    ],
    severity: "critical",
    confidence: hasScriptNotFound || hasRestartFailure ? "high" : "medium",
  });
}

function buildDiagnosisContext(input) {
  const serviceName = cleanText(input?.serviceName || input?.selectedService);
  const recentAudit = Array.isArray(input?.recentAudit) ? input.recentAudit.filter(Boolean) : [];
  const latestAction = input?.latestAction || recentAudit[0] || null;
  const failedAction = recentAudit.find((entry) => getActionStatus(entry) === "failed") || (getActionStatus(latestAction) === "failed" ? latestAction : null);

  if (!serviceName) {
    return null;
  }

  return {
    ...input,
    serviceName,
    services: Array.isArray(input?.services) ? input.services.filter(Boolean) : [],
    recentAudit,
    latestAction,
    failedAction,
    host: normalizeHost(input?.host || input?.service?.host),
    manager: cleanText(input?.manager),
    processName: cleanText(input?.processName),
    localPort: Number.isFinite(Number(input?.localPort)) ? Number(input.localPort) : null,
    localUrl: cleanText(input?.localUrl),
    localHealthUrl: cleanText(input?.localHealthUrl),
    localReadinessUrl: cleanText(input?.localReadinessUrl),
    publicUrl: cleanText(input?.publicUrl),
    status: normalizeStatus(input?.status),
    runtimeRestarts: Number.isFinite(Number(input?.runtimeRestarts)) ? Number(input.runtimeRestarts) : 0,
    latestActionText: cleanText(input?.latestActionText),
    logSignals: input?.logSignals || null,
  };
}

function getDiagnosisLogLines(input) {
  const logText = cleanText(input?.logs || input?.visibleLogs);
  return logText ? String(logText).split(/\r?\n/) : [];
}

function detectLogIssueAtLine(context, lines, index) {
  const line = cleanText(lines[index]);

  if (!line) {
    return null;
  }

  const match = { index, line };

  if (
    /\bSyntaxError\b/i.test(line) ||
    /missing \) after argument list/i.test(line) ||
    /Unexpected token/i.test(line) ||
    /Cannot use import statement outside a module/i.test(line)
  ) {
    return buildSyntaxIssue(context, lines, match);
  }

  const jsRuntimeMatch = line.match(/\b(TypeError|ReferenceError)\b/i);

  if (jsRuntimeMatch) {
    return buildJavascriptRuntimeIssue(context, lines, match, jsRuntimeMatch[1]);
  }

  if (/\bCannot find module\b/i.test(line) || /\bmodule not found\b/i.test(line) || /\bMODULE_NOT_FOUND\b/i.test(line)) {
    return buildModuleIssue(context, lines, match);
  }

  if (/\bEADDRINUSE\b/i.test(line) || /address already in use/i.test(line)) {
    return buildPortInUseIssue(context, lines, match);
  }

  if (/\bECONNREFUSED\b/i.test(line) || /connection refused/i.test(line)) {
    return buildConnectionRefusedIssue(context, lines, match);
  }

  if (
    /\bpm2\b/i.test(line) &&
    /(errored|stopped|script not found|exited with code|too many unstable restarts|process or namespace not found)/i.test(line)
  ) {
    return buildPm2ProcessIssue(context, lines, match);
  }

  if (/HTTP\s*401/i.test(line) || /status(?:=|:)?\s*401/i.test(line) || /\bunauthorized\b/i.test(line)) {
    return buildUnauthorizedIssue(context, line, findTimestampNearLine(lines, index, context.logsFetchedAt), "logs");
  }

  if (/HTTP\s*403/i.test(line) || /status(?:=|:)?\s*403/i.test(line) || /\bforbidden\b/i.test(line) || /Cloudflare Access/i.test(line)) {
    return buildForbiddenIssue(context, line, findTimestampNearLine(lines, index, context.logsFetchedAt), "logs");
  }

  if (/HTTP\s*404/i.test(line) || /status(?:=|:)?\s*404/i.test(line) || /route not found/i.test(line) || /Cannot GET \//i.test(line)) {
    return buildRouteIssue(context, line, findTimestampNearLine(lines, index, context.logsFetchedAt), "logs");
  }

  if (/HTTP\s*502/i.test(line) || /status(?:=|:)?\s*502/i.test(line) || /upstream unavailable/i.test(line) || /bad gateway/i.test(line)) {
    return buildUpstreamIssue(context, line, findTimestampNearLine(lines, index, context.logsFetchedAt), "logs");
  }

  if (
    /\bMain process exited\b/i.test(line) ||
    /\bexited with code\b/i.test(line) ||
    /status=\d+\/FAILURE/i.test(line) ||
    /Failed with result 'exit-code'/i.test(line) ||
    /Start request repeated too quickly/i.test(line) ||
    (/\bfailed\b/i.test(line) && /\b(service|process|unit)\b/i.test(line))
  ) {
    return buildExitIssue(context, lines, match);
  }

  if (/\btimeout\b/i.test(line)) {
    return buildTimeoutIssue(context, lines, match);
  }

  return null;
}

function issuePriority(issue, index) {
  const severityScore = SEVERITY_SCORES[normalizeSeverity(issue?.severity)] || 0;
  const confidenceScore = CONFIDENCE_SCORES[cleanText(issue?.confidence).toLowerCase()] || 0;
  const fileScore = issue?.filePath ? 1 : 0;
  return severityScore * 100 + confidenceScore * 10 + fileScore - index / 1000;
}

function issueSignature(issue) {
  return [
    cleanText(issue?.errorType).toLowerCase(),
    cleanText(issue?.filePath).toLowerCase(),
    String(issue?.lineNumber || ""),
    cleanText(issue?.mostRelevantError || issue?.errorMessage).toLowerCase(),
  ]
    .filter(Boolean)
    .join("|");
}

function toLogEvent(issue, index) {
  return {
    id: `log-event-${index}-${cleanText(issue?.errorType || issue?.primaryIssue)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")}`,
    severity: normalizeSeverity(issue?.severity),
    detectedError: issue?.primaryIssue || issue?.errorType || "Log event",
    primaryIssue: issue?.primaryIssue || issue?.errorType || "Log event",
    likelyCause: issue?.likelyCause || "",
    mostRelevantError: issue?.mostRelevantError || issue?.errorMessage || "",
    errorType: issue?.errorType || "",
    filePath: issue?.filePath || "",
    fileName: issue?.fileName || "",
    lineNumber: issue?.lineNumber || null,
    timestamp: issue?.timestamp || null,
    affectedService: issue?.affectedService || "",
    suggestedCheck: issue?.suggestedCheck || issue?.suggestedCommand || "",
    suggestedCommand: issue?.suggestedCommand || "",
    confidence: issue?.confidence || "medium",
    source: "logs",
    relatedServiceId: issue?.relatedServiceId || "",
    relatedServiceName: issue?.relatedServiceName || "",
    relatedServiceHost: issue?.relatedServiceHost || "",
    relatedServiceManager: issue?.relatedServiceManager || "",
    relatedEndpoint: issue?.relatedEndpoint || "",
    correlationReason: issue?.correlationReason || "",
    correlationConfidence: issue?.correlationConfidence || "",
  };
}

function extractLogIssues(context, lines) {
  const issues = [];

  for (let index = 0; index < lines.length; index += 1) {
    const issue = detectLogIssueAtLine(context, lines, index);

    if (issue) {
      issues.push({
        ...issue,
        matchIndex: index,
      });
    }
  }

  return uniqueBy(issues, issueSignature)
    .sort((left, right) => issuePriority(right, right.matchIndex || 0) - issuePriority(left, left.matchIndex || 0))
    .slice(0, LOG_EVENT_LIMIT);
}

function attachLogEvents(issue, logEvents) {
  return {
    ...issue,
    logEvents,
  };
}

export function extractServiceLogEvents(input) {
  const context = buildDiagnosisContext(input);

  if (!context) {
    return [];
  }

  return extractLogIssues(context, getDiagnosisLogLines(input)).map((issue, index) => toLogEvent(issue, index));
}

export function extractServiceDiagnosis(input) {
  const context = buildDiagnosisContext(input);

  if (!context) {
    return null;
  }
  const lines = getDiagnosisLogLines(input);
  const localHttp = context.service?.health?.checks?.localHttp || {};
  const localPort = context.service?.health?.checks?.localPort || {};
  const latestAction = context.latestAction || null;
  const failedAction = context.failedAction || latestAction;
  const latestActionStatus = getActionStatus(failedAction);
  const latestActionCode = getActionCode(failedAction);
  const latestActionError = getActionError(failedAction);
  const latestActionTimestamp = getActionTimestamp(failedAction);
  const healthStatus = Number(context.healthOutput?.status || localHttp.status || 0);
  const healthTimestamp = context.healthMeta?.receivedAt || localHttp.checkedAt || localPort.checkedAt || null;
  const logIssues = extractLogIssues(context, lines);
  const logEvents = logIssues.map((issue, index) => toLogEvent(issue, index));

  if (logIssues.length) {
    return attachLogEvents(logIssues[0], logEvents);
  }

  if (healthStatus === 401) {
    return attachLogEvents(buildUnauthorizedIssue(context, `HTTP 401 from health or proxy check.`, healthTimestamp), logEvents);
  }

  if (healthStatus === 403) {
    return attachLogEvents(buildForbiddenIssue(context, `HTTP 403 from health or proxy check.`, healthTimestamp), logEvents);
  }

  if (healthStatus === 404) {
    return attachLogEvents(buildRouteIssue(context, `HTTP 404 from health or proxy check.`, healthTimestamp), logEvents);
  }

  if (healthStatus === 502) {
    return attachLogEvents(buildUpstreamIssue(context, `HTTP 502 from health or proxy check.`, healthTimestamp), logEvents);
  }

  if (localPort.checkedAt && localPort.ok === false) {
    return attachLogEvents(buildLocalPortIssue(context, healthTimestamp), logEvents);
  }

  if (localHttp.checkedAt && localHttp.ok === false) {
    return attachLogEvents(buildGenericHealthIssue(context, localHttp, healthTimestamp), logEvents);
  }

  if (context.healthOutput && context.healthOutput.ok === false) {
    return attachLogEvents(buildGenericHealthIssue(context, context.healthOutput, healthTimestamp), logEvents);
  }

  if (latestActionStatus === "failed" && (/unsupported/i.test(latestActionError) || latestActionCode.includes("unsupported"))) {
    return attachLogEvents(buildUnsupportedActionIssue(context, latestActionError, latestActionTimestamp), logEvents);
  }

  if (latestActionStatus === "failed") {
    return attachLogEvents(buildGenericActionFailure(context, latestActionError, latestActionTimestamp), logEvents);
  }

  if (context.runtimeRestarts >= 3) {
    return attachLogEvents(buildRestartCountIssue(context), logEvents);
  }

  if (["failed", "error", "stopped", "offline"].includes(context.status)) {
    return attachLogEvents(buildServiceStatusIssue(context), logEvents);
  }

  return attachLogEvents({
    detected: false,
    severity: "info",
    primaryIssue: "",
    likelyCause: "",
    errorType: "",
    mostRelevantError: "",
    errorMessage: "",
    filePath: "",
    fileName: "",
    lineNumber: null,
    columnNumber: null,
    affectedService: context.serviceName,
    timestamp: null,
    suggestedNextStep: "Review raw logs or run a health check for more context.",
    suggestedCommand: "",
    suggestedCheck: "",
    suggestedActions: ["Fetch logs.", "Run a health check.", "Review recent audit."],
    source: "none",
    riskLevel: "safe",
    confidence: "low",
    highlights: buildBaseHighlights(context),
  }, logEvents);
}
