const config = require("../config");
const bridgeClient = require("./bridgeClient");
const serviceDiscovery = require("./serviceDiscovery");
const windowsExecutor = require("./windowsExecutor");

const DEFAULT_HEALTH_TIMEOUT_MS = 5000;

function normalizeServiceName(value) {
  return serviceDiscovery.normalizeServiceName(value);
}

function serviceKey(value) {
  return normalizeServiceName(value).toLowerCase();
}

function normalizeStatus(value) {
  return String(value || "unknown").trim().toLowerCase() || "unknown";
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

function getServiceLocalPort(service) {
  return readServiceNumber(service?.inventory?.localPort, service?.health?.checks?.localPort?.port);
}

function getPreferredHealthUrl(service) {
  return readServiceString(
    service?.inventory?.localHealthUrl,
    service?.health?.url,
    service?.health?.localUrl,
    service?.inventory?.localUrl,
    service?.health?.publicUrl,
    service?.inventory?.publicUrl,
  );
}

function healthTimeoutMs() {
  const configured = Number(config.windowsVerificationTimeoutMs);

  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_HEALTH_TIMEOUT_MS;
  }

  return Math.min(Math.max(Math.trunc(configured), 500), 10000);
}

function baseFields(service, executor = null) {
  return {
    serviceName: service?.name || null,
    displayName: service?.displayName || service?.name || null,
    host: service?.host || "unknown",
    manager: getServiceManager(service) || null,
    processName: getServiceProcessName(service) || null,
    executor,
  };
}

function capabilityFor(service, key) {
  const capability = service?.capabilities?.[key];
  return capability && typeof capability === "object" ? capability : {};
}

function capabilityReason(capability) {
  return readServiceString(capability?.reason);
}

function capabilityHint(capability) {
  return readServiceString(capability?.setupHint);
}

function normalizeLogText(payload) {
  if (typeof payload === "string") {
    return payload;
  }

  if (payload && typeof payload.logs === "string") {
    return payload.logs;
  }

  if (payload != null) {
    return JSON.stringify(payload, null, 2);
  }

  return "";
}

function tailLines(value, maxLines) {
  return String(value || "")
    .split(/\r?\n/)
    .slice(-maxLines)
    .join("\n");
}

function bridgeLogTargets(service) {
  const targets = [service?.name];

  if (serviceKey(service?.name) === "aibry-admin") {
    targets.push("admin-proxy");
  }

  return Array.from(new Set(targets.map((value) => normalizeServiceName(value)).filter(Boolean)));
}

function serviceResolutionError(status, code, message, serviceName) {
  const normalizedName = normalizeServiceName(serviceName);

  return {
    ok: false,
    status,
    data: {
      ok: false,
      code,
      message,
      serviceName: normalizedName || null,
      host: "unknown",
      executor: null,
    },
    error: message,
    executor: null,
  };
}

function unsupportedResult(code, message, service, capability, extra = {}) {
  const executor = extra.executor ?? capability?.executor ?? null;

  return {
    ok: false,
    status: extra.status || 409,
    data: {
      ok: false,
      ...baseFields(service, executor),
      code,
      message,
      mode: extra.mode || capability?.mode || "unsupported",
      reason: extra.reason || capabilityReason(capability) || message,
      suggestedSetupHint: extra.suggestedSetupHint || capabilityHint(capability) || null,
      ...extra.data,
    },
    error: message,
    executor,
  };
}

function failureResult(code, message, service, executor, extra = {}) {
  return {
    ok: false,
    status: extra.status || 500,
    data: {
      ok: false,
      ...baseFields(service, executor),
      code,
      message,
      ...extra.data,
    },
    error: message,
    executor,
    ...(extra.baseUrl ? { baseUrl: extra.baseUrl } : {}),
  };
}

function healthCheckKind(service, url) {
  if (!url) {
    return "http";
  }

  if (url === service?.inventory?.localHealthUrl || url === service?.health?.url) {
    return "health-url";
  }

  if (url === service?.inventory?.localUrl || url === service?.health?.localUrl) {
    return "local-url";
  }

  if (url === service?.inventory?.publicUrl || url === service?.health?.publicUrl) {
    return "public-url";
  }

  return "http";
}

function statusLooksHealthy(status) {
  return /^(running|online|healthy|ok|ready|supported|completed)$/i.test(status);
}

function statusLooksUnhealthy(status) {
  return /^(failed|stopped|error|unreachable|offline|crashed|missing|warning|degraded|partial|timeout)$/i.test(status);
}

function resultFromVerification(service, capability, verification, mode, extra = {}) {
  const ok = Boolean(verification?.ok);
  const verificationStatus = verification?.status || null;
  const executor = extra.executor ?? capability?.executor ?? null;
  const code = ok
    ? mode === "status-only"
      ? "health_status_only"
      : "health_check_completed"
    : mode === "status-only"
      ? "health_status_only_failed"
      : "health_check_failed";
  const message =
    extra.message ||
    (ok
      ? mode === "status-only"
        ? `Status-only check completed for ${service.displayName || service.name}.`
        : `Health check completed for ${service.displayName || service.name}.`
      : verification?.error || `Health check failed for ${service.displayName || service.name}.`);

  return {
    ok,
    status: ok ? 200 : verificationStatus || 502,
    data: {
      ok,
      ...baseFields(service, executor),
      code,
      message,
      mode,
      status: verificationStatus,
      reason: extra.reason || (mode === "status-only" ? capabilityReason(capability) || null : null),
      suggestedSetupHint: extra.suggestedSetupHint || capabilityHint(capability) || null,
      derivedFrom: extra.derivedFrom || null,
      verification,
      ...(extra.healthData ? { health: extra.healthData } : {}),
    },
    error: ok ? null : message,
    executor,
    ...(extra.baseUrl ? { baseUrl: extra.baseUrl } : {}),
  };
}

async function resolveService(serviceName) {
  const normalizedName = normalizeServiceName(serviceName);

  if (!normalizedName) {
    return {
      service: null,
      response: serviceResolutionError(400, "service_required", "serviceName is required", serviceName),
    };
  }

  const servicesResult = await serviceDiscovery.listUnifiedServices();
  const service = (servicesResult.items || []).find((item) => serviceKey(item.name) === serviceKey(normalizedName)) || null;

  if (!service) {
    return {
      service: null,
      response: serviceResolutionError(404, "service_not_found", `Service ${normalizedName} was not found`, normalizedName),
    };
  }

  return {
    service,
    response: null,
  };
}

async function fetchServiceLogs(serviceName) {
  const resolution = await resolveService(serviceName);

  if (resolution.response) {
    return resolution.response;
  }

  const service = resolution.service;
  const capability = capabilityFor(service, "logs");

  if (!capability.supported) {
    return unsupportedResult(
      "logs_unsupported",
      capabilityReason(capability) || `${service.displayName || service.name} does not expose a supported log route.`,
      service,
      capability,
    );
  }

  if (capability.executor === "windows-local") {
    return windowsExecutor.getServiceLogs({
      serviceName: service.name,
      processName: getServiceProcessName(service),
    });
  }

  if (capability.executor === "fedora-bridge") {
    let lastResponse = null;

    for (const targetName of bridgeLogTargets(service)) {
      const response = await bridgeClient.getLogs(targetName);
      const logs = normalizeLogText(response.data);

      if (response.ok) {
        return {
          ok: true,
          status: response.status || 200,
          data: {
            ok: true,
            ...baseFields(service, "fedora-bridge"),
            code: "fedora_logs_completed",
            message:
              targetName === service.name
                ? `Fetched Fedora logs for ${service.displayName || service.name}.`
                : `Fetched Fedora logs for ${service.displayName || service.name} via ${targetName}.`,
            logTarget: targetName,
            logs,
            logLength: logs.length,
            preview: tailLines(logs, 40),
            ...(response.baseUrl ? { baseUrl: response.baseUrl } : {}),
          },
          error: null,
          executor: "fedora-bridge",
          ...(response.baseUrl ? { baseUrl: response.baseUrl } : {}),
        };
      }

      lastResponse = {
        ...response,
        logTarget: targetName,
        logs,
      };
    }

    const response = lastResponse || {
      ok: false,
      status: 502,
      error: `Failed to fetch logs for ${service.displayName || service.name}.`,
      baseUrl: null,
      logTarget: service.name,
      logs: "",
    };

    if ([404, 409, 501].includes(response.status)) {
      return unsupportedResult(
        "logs_unsupported",
        response.error || `Fedora logs are not available for ${service.displayName || service.name}.`,
        service,
        capability,
        {
          executor: "fedora-bridge",
          status: response.status || 409,
          data: {
            logTarget: response.logTarget,
          },
        },
      );
    }

    return failureResult(
      "logs_fetch_failed",
      response.error || `Failed to fetch logs for ${service.displayName || service.name}.`,
      service,
      "fedora-bridge",
      {
        status: response.status || 502,
        data: {
          logTarget: response.logTarget,
          logs: response.logs || "",
        },
        baseUrl: response.baseUrl || null,
      },
    );
  }

  return unsupportedResult(
    "logs_unsupported",
    "Logs are not supported for this service from the current executor.",
    service,
    capability,
  );
}

async function fetchServiceHealth(serviceName) {
  const resolution = await resolveService(serviceName);

  if (resolution.response) {
    return resolution.response;
  }

  const service = resolution.service;
  const capability = capabilityFor(service, "health");

  if (!capability.supported) {
    return unsupportedResult(
      "health_unsupported",
      capabilityReason(capability) || `${service.displayName || service.name} does not expose a supported health check.`,
      service,
      capability,
    );
  }

  if (capability.mode === "bridge-health") {
    const response = await bridgeClient.getHealth();
    const verification = {
      method: "bridge",
      ok: response.ok,
      checkedAt: new Date().toISOString(),
      ...(response.status ? { status: response.status } : {}),
      ...(response.error ? { error: response.error } : {}),
    };

    return resultFromVerification(service, capability, verification, "bridge-health", {
      executor: "fedora-bridge",
      message: response.ok
        ? `Bridge health completed for ${service.displayName || service.name}.`
        : response.error || `Bridge health failed for ${service.displayName || service.name}.`,
      healthData: response.data || null,
      baseUrl: response.baseUrl || null,
    });
  }

  const healthUrl = getPreferredHealthUrl(service);

  if (healthUrl) {
    const verification = await windowsExecutor.verifyHttpUrl(
      healthUrl,
      healthTimeoutMs(),
      healthCheckKind(service, healthUrl),
    );

    return resultFromVerification(service, capability, verification, capability.mode || "http", {
      executor: capability.executor || (service.host === "windows" ? "windows-local" : null),
    });
  }

  if (capability.mode === "tcp") {
    const localPort = getServiceLocalPort(service);

    if (localPort != null) {
      const verification = await windowsExecutor.checkLocalPort(localPort, healthTimeoutMs());

      return resultFromVerification(service, capability, verification, "tcp", {
        executor: capability.executor || "windows-local",
      });
    }
  }

  if (capability.mode === "status-only") {
    const processName = getServiceProcessName(service);

    if (service.host === "windows" && getServiceManager(service) === "pm2" && processName) {
      const pm2Snapshot = await windowsExecutor.getPm2ProcessStatuses([processName]);

      if (!pm2Snapshot.ok) {
        return failureResult(
          "health_check_failed",
          pm2Snapshot.error || `Failed to query PM2 for ${service.displayName || service.name}.`,
          service,
          "windows-local",
          {
            status: 503,
          },
        );
      }

      const snapshot = pm2Snapshot.statuses[serviceKey(processName)] || null;
      const pm2Status = snapshot?.status || "missing";
      const verification = {
        method: "pm2",
        ok: pm2Status === "online",
        pm2Status,
        checkedAt: snapshot?.checkedAt || pm2Snapshot.checkedAt || new Date().toISOString(),
        ...(pm2Status === "online" ? {} : { error: pm2Status === "missing" ? "PM2 process not found" : `PM2 status ${pm2Status}` }),
      };

      return resultFromVerification(service, capability, verification, "status-only", {
        executor: "windows-local",
        derivedFrom: "pm2",
      });
    }

    const derivedStatus = normalizeStatus(service.runtime?.status || service.status);

    if (derivedStatus && derivedStatus !== "unknown") {
      const verification = {
        method: "status",
        ok: statusLooksHealthy(derivedStatus),
        checkedAt: new Date().toISOString(),
        ...(statusLooksHealthy(derivedStatus) ? {} : { error: statusLooksUnhealthy(derivedStatus) ? `Service status ${derivedStatus}` : "Service status is unknown" }),
      };

      return resultFromVerification(service, capability, verification, "status-only", {
        executor: capability.executor || null,
        derivedFrom: service.runtime?.source || service.source || "inventory",
        reason: capabilityReason(capability) || "No dedicated health endpoint is configured; using status-only verification.",
      });
    }
  }

  return unsupportedResult(
    "health_unsupported",
    capabilityReason(capability) || `${service.displayName || service.name} does not expose a supported health check.`,
    service,
    capability,
  );
}

module.exports = {
  fetchServiceHealth,
  fetchServiceLogs,
};
