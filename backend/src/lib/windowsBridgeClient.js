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
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer <redacted>");
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

  if (!settings.token) {
    throw routeError("bridge_auth_missing", `${source} auth is not configured.`, { source });
  }

  return settings;
}

async function request(source, pathname, options = {}) {
  const settings = requireBridgeConfig(source);
  const checkedAt = new Date().toISOString();
  const controller = new AbortController();
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : config.windowsBridgeTimeoutMs;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

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
      source,
      checkedAt,
      latencyMs: Date.now() - startedAt,
      httpStatus: response.status,
      data,
      error: response.ok
        ? null
        : {
            code: `bridge_http_${response.status}`,
            message: sanitizeErrorMessage(
              (typeof data === "object" && data && (data.error || data.message)) || response.statusText || "Bridge request failed.",
            ),
          },
    };
  } catch (error) {
    const isTimeout = error?.name === "AbortError";

    return {
      ok: false,
      source,
      checkedAt,
      latencyMs: Date.now() - startedAt,
      httpStatus: isTimeout ? 504 : 502,
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

function getWindowsAdminHealth(options = {}) {
  return request(WINDOWS_ADMIN_SOURCE, "/admin/health", options);
}

function getWindowsGaragePulse(options = {}) {
  return request(WINDOWS_GARAGE_SOURCE, "/pulse", options);
}

function getWindowsGarageHealth(options = {}) {
  return request(WINDOWS_GARAGE_SOURCE, "/admin/health", options);
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
  getWindowsRepos,
  getWindowsServiceStatus,
  routeError,
};
