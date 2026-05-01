const config = require("../config");

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/$/, "");
}

function getBaseUrls() {
  const baseUrls = [];
  const configured = normalizeBaseUrl(config.bridgeBaseUrl);

  if (configured) {
    baseUrls.push(configured);
  }

  const defaultProxy = "http://127.0.0.1:4000";
  if (!baseUrls.includes(defaultProxy)) {
    baseUrls.push(defaultProxy);
  }

  return baseUrls;
}

function shouldTryFallback(response) {
  return !response.ok && (!response.status || response.status >= 500 || response.error === "Bridge request timed out");
}

async function request(pathname, options = {}, timeoutMsOverride) {
  const baseUrls = getBaseUrls();

  let lastResponse = {
    ok: false,
    status: 500,
    error: "Bridge request failed",
  };

  for (const baseUrl of baseUrls) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMsOverride || config.bridgeTimeoutMs);

    try {
      const headers = {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      };

      if (config.bridgeToken) {
        headers["x-aibry-auth"] = config.bridgeToken;
      }

      const response = await fetch(`${baseUrl}${pathname}`, {
        method: options.method || "GET",
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });

      const responseText = await response.text();
      let payload = null;

      if (responseText) {
        try {
          payload = JSON.parse(responseText);
        } catch (_error) {
          payload = responseText;
        }
      }

      clearTimeout(timeout);

      const result = {
        ok: response.ok,
        status: response.status,
        data: payload,
        baseUrl,
      };

      if (result.ok || !shouldTryFallback(result)) {
        return result;
      }

      lastResponse = result;
    } catch (error) {
      clearTimeout(timeout);
      lastResponse = {
        ok: false,
        status: 500,
        error: error.name === "AbortError" ? "Bridge request timed out" : error.message,
        baseUrl,
      };
    }
  }

  return lastResponse;
}

async function getHealth() {
  return request("/admin/health");
}

async function discoverServices() {
  const discoveryPaths = ["/admin/services", "/admin/service-discovery", "/admin/status", "/admin/health"];
  const discoveryTimeoutMs = Math.min(config.bridgeTimeoutMs, 3000);
  let lastResponse = {
    ok: false,
    status: 500,
    error: "Bridge service discovery failed",
    discoveryPath: null,
  };

  for (const discoveryPath of discoveryPaths) {
    const response = await request(discoveryPath, {}, discoveryTimeoutMs);
    const result = {
      ...response,
      discoveryPath,
    };

    if (result.ok) {
      return result;
    }

    lastResponse = result;
  }

  return lastResponse;
}

async function getLogs(service) {
  return request(`/admin/logs/${encodeURIComponent(service)}`);
}

async function restartService(serviceName) {
  return request(
    "/admin/restart-service",
    {
      method: "POST",
      body: { serviceName },
    },
    config.bridgeActionTimeoutMs,
  );
}

module.exports = {
  getHealth,
  discoverServices,
  getLogs,
  restartService,
};
