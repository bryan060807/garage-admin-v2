const config = require("../config");

const WINDOWS_ADMIN_SOURCE = "windows-admin";
const WINDOWS_GARAGE_SOURCE = "windows-garage";

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/$/, "");
}

function sanitizeErrorMessage(value, fallback = "Bridge request failed.") {
  if (!value) {
    return fallback;
  }

  return String(value)
    .replace(/(token|secret|password|credential|api[-_]?key)\s*[:=]\s*[^\s"'`]+/gi, "$1: <redacted>")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer <redacted>")
    .replace(/[A-Za-z]:\\[^\s"'`]+/g, "<redacted-path>")
    .replace(/(?:\/[A-Za-z0-9._-]+){2,}/g, "<redacted-path>");
}

function normalizePayload(text) {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (_error) {
    return text;
  }
}

function readPayloadErrorMessage(data, fallback = "Bridge request failed.") {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const upstreamError = data.error;

    if (typeof upstreamError === "string") {
      return upstreamError;
    }

    if (upstreamError && typeof upstreamError === "object" && !Array.isArray(upstreamError)) {
      return upstreamError.message || upstreamError.error || upstreamError.code || fallback;
    }

    return data.message || data.errorMessage || data.statusText || data.detail || fallback;
  }

  if (typeof data === "string" && data.trim()) {
    return data;
  }

  return fallback;
}

function readPayloadErrorCode(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "";
  }

  const upstreamError = data.error;
  if (upstreamError && typeof upstreamError === "object" && !Array.isArray(upstreamError)) {
    return String(upstreamError.code || "").trim();
  }

  return String(data.code || data.errorCode || "").trim();
}

function sanitizeConfiguredTarget(baseUrl, pathname = "") {
  try {
    const url = new URL(baseUrl);
    const normalizedPath = pathname ? (pathname.startsWith("/") ? pathname : `/${pathname}`) : "/";

    return {
      protocol: url.protocol.replace(/:$/, ""),
      host: url.hostname,
      port: url.port || (url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : ""),
      basePath: url.pathname || "/",
      requestPath: normalizedPath,
      display: `${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "")}${normalizedPath}`,
    };
  } catch (_error) {
    return {
      protocol: "",
      host: "",
      port: "",
      basePath: "",
      requestPath: pathname || "",
      display: "",
    };
  }
}

function isGarageAdminBridgeRouteBaseUrl(baseUrl) {
  try {
    const url = new URL(baseUrl);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    return pathname === "/api/windows-bridge" || pathname.startsWith("/api/windows-bridge/");
  } catch (_error) {
    return false;
  }
}

function getBridgeConfig(source) {
  if (source === WINDOWS_ADMIN_SOURCE) {
    return {
      source,
      baseUrl: normalizeBaseUrl(config.windowsAdminBaseUrl),
      token: config.windowsAdminAuthToken,
      headerName: "x-aibry-auth",
    };
  }

  if (source === WINDOWS_GARAGE_SOURCE) {
    return {
      source,
      baseUrl: normalizeBaseUrl(config.windowsGarageBaseUrl),
      token: config.windowsGarageApiKey,
      headerName: "X-API-KEY",
    };
  }

  return null;
}

function routeError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function requireBridgeConfig(source) {
  const settings = getBridgeConfig(source);

  if (!settings) {
    throw routeError("unsupported_bridge_source", "Unsupported Windows bridge source.");
  }

  if (!settings.baseUrl) {
    throw routeError("bridge_base_url_missing", `${source} base URL is not configured.`, { source });
  }

  if (isGarageAdminBridgeRouteBaseUrl(settings.baseUrl)) {
    throw routeError(
      "bridge_self_reference",
      `${source} base URL must target the Windows helper service, not Garage Admin V2 bridge routes.`,
      { source },
    );
  }

  if (!settings.token) {
    throw routeError("bridge_auth_missing", `${source} auth is not configured.`, { source });
  }

  return settings;
}

async function requestWithSettings(settings, pathname, options = {}, metadata = {}) {
  const checkedAt = new Date().toISOString();
  const controller = new AbortController();
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : config.windowsBridgeTimeoutMs;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  const configuredTarget = sanitizeConfiguredTarget(settings.baseUrl, pathname);

  try {
    const headers = {
      Accept: "application/json",
      [settings.headerName]: settings.token,
      ...(options.headers || {}),
    };
    const body = options.body ? JSON.stringify(options.body) : undefined;

    if (body && !headers["Content-Type"] && !headers["content-type"]) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(`${settings.baseUrl}${pathname}`, {
      method: options.method || "GET",
      headers,
      body,
      signal: controller.signal,
    });
    const text = await response.text();
    const data = normalizePayload(text);

    return {
      ok: response.ok,
      source: settings.source,
      checkedAt,
      latencyMs: Date.now() - startedAt,
      httpStatus: response.status,
      request: {
        pathname,
        configuredTarget,
        ...(metadata.fallbackFrom ? { fallbackFrom: metadata.fallbackFrom } : {}),
      },
      data,
      error: response.ok
        ? null
        : {
            code: `bridge_http_${response.status}`,
            message: sanitizeErrorMessage(
              readPayloadErrorMessage(data, response.statusText || "Bridge request failed."),
            ),
          },
    };
  } catch (error) {
    const isTimeout = error?.name === "AbortError";

    return {
      ok: false,
      source: settings.source,
      checkedAt,
      latencyMs: Date.now() - startedAt,
      httpStatus: isTimeout ? 504 : 502,
      request: {
        pathname,
        configuredTarget,
        ...(metadata.fallbackFrom ? { fallbackFrom: metadata.fallbackFrom } : {}),
      },
      data: null,
      error: {
        code: isTimeout ? "bridge_timeout" : "bridge_request_failed",
        message: sanitizeErrorMessage(error?.message, isTimeout ? "Bridge request timed out." : "Bridge request failed."),
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

function shouldRetryWindowsGarageLoopback(source, settings, result, options = {}) {
  if (source !== WINDOWS_GARAGE_SOURCE || options.allowLoopbackFallback === false) {
    return false;
  }

  const fallbackBaseUrl = normalizeBaseUrl(config.windowsGarageLoopbackBaseUrl);
  if (!fallbackBaseUrl || fallbackBaseUrl === settings.baseUrl) {
    return false;
  }

  return result.httpStatus === 404 && readPayloadErrorCode(result.data) === "not_found";
}

async function request(source, pathname, options = {}) {
  const settings = requireBridgeConfig(source);
  const result = await requestWithSettings(settings, pathname, options);

  if (!shouldRetryWindowsGarageLoopback(source, settings, result, options)) {
    return result;
  }

  const fallbackSettings = {
    ...settings,
    baseUrl: normalizeBaseUrl(config.windowsGarageLoopbackBaseUrl),
  };

  return requestWithSettings(
    fallbackSettings,
    pathname,
    {
      ...options,
      allowLoopbackFallback: false,
    },
    {
      fallbackFrom: result.request?.configuredTarget,
    },
  );
}

function getWindowsAdminHealth(options = {}) {
  return request(WINDOWS_ADMIN_SOURCE, "/admin/health", options);
}

function getWindowsGaragePulse(options = {}) {
  return request(WINDOWS_GARAGE_SOURCE, "/pulse", options);
}

function getWindowsGarageHealth(options = {}) {
  return request(WINDOWS_GARAGE_SOURCE, "/admin/health", options);
}

function getWindowsGarageMemorySelfCheck(options = {}) {
  return request(WINDOWS_GARAGE_SOURCE, "/memory/self-check", options);
}

function getWindowsServiceStatus(serviceName, options = {}) {
  return request(
    WINDOWS_ADMIN_SOURCE,
    `/admin/services/${encodeURIComponent(String(serviceName || "").trim())}/status`,
    options,
  );
}

function getWindowsRepos(includeStatus = false, options = {}) {
  const suffix = includeStatus ? "?includeStatus=true" : "";
  return request(WINDOWS_GARAGE_SOURCE, `/repos${suffix}`, options);
}

module.exports = {
  WINDOWS_ADMIN_SOURCE,
  WINDOWS_GARAGE_SOURCE,
  getWindowsAdminHealth,
  getWindowsGaragePulse,
  getWindowsGarageHealth,
  getWindowsGarageMemorySelfCheck,
  getWindowsRepos,
  getWindowsServiceStatus,
  readPayloadErrorCode,
  readPayloadErrorMessage,
  routeError,
  sanitizeConfiguredTarget,
};
