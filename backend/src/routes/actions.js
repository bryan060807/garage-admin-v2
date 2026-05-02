const express = require("express");
const bridgeClient = require("../lib/bridgeClient");
const repository = require("../lib/repository");
const serviceOperations = require("../lib/serviceOperations");
const serviceDiscovery = require("../lib/serviceDiscovery");
const windowsExecutor = require("../lib/windowsExecutor");
const windowsInventory = require("../lib/windowsInventory");

const router = express.Router();

const ACTION_DEFINITIONS = {
  "fetch-logs": {
    label: "Fetch logs",
    risk: "low",
    requiresApproval: false,
    requiresService: true,
    execute: async ({ serviceName }) => {
      const response = await serviceOperations.fetchServiceLogs(serviceName);
      const logs = typeof response.data?.logs === "string" ? response.data.logs : "";

      return {
        auditResult: executorResultForAudit(response),
        output: {
          logs,
        },
      };
    },
  },
  "health-check": {
    label: "Health check",
    risk: "low",
    requiresApproval: false,
    requiresService: true,
    execute: async ({ serviceName }) => {
      const response = await serviceOperations.fetchServiceHealth(serviceName);

      return {
        auditResult: executorResultForAudit(response),
        output: {
          health: response.data || null,
        },
      };
    },
  },
  "restart-service": {
    label: "Restart service",
    risk: "medium",
    requiresApproval: true,
    requiresService: true,
    execute: async ({ serviceName, host }) => {
      const response = await restartServiceForHost(serviceName, host);

      return {
        auditResult: executorResultForAudit(response),
        output: {
          restart: response.data || null,
        },
      };
    },
  },
};

function asyncRoute(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (error) {
      next(error);
    }
  };
}

function normalizeActionType(value) {
  return String(value || "").trim();
}

function normalizeServiceName(value) {
  return String(value || "").trim();
}

function serviceKey(value) {
  return normalizeServiceName(value).toLowerCase();
}

function normalizeHost(value, serviceName) {
  const normalizedServiceKey = serviceKey(serviceName);

  if (normalizedServiceKey === "aibry-admin") {
    return "fedora";
  }

  if (windowsInventory.isWindowsRuntime(normalizedServiceKey)) {
    return "windows";
  }

  const host = String(value || "")
    .trim()
    .toLowerCase();

  if (host === "fedora" || host === "windows") {
    return host;
  }

  return "unknown";
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

function bridgeResultForAudit(response) {
  return {
    ok: response.ok,
    status: response.status || null,
    data: response.data || null,
    error: response.error || null,
    baseUrl: response.baseUrl || null,
  };
}

function executorResultForAudit(response) {
  return {
    ok: response.ok,
    status: response.status || null,
    data: response.data || null,
    error: response.error || null,
    baseUrl: response.baseUrl || null,
    executor: response.executor || (response.baseUrl ? "fedora-bridge" : null),
  };
}

function unsupportedRestartForHost(serviceName, host) {
  const message = `Restart is not supported for ${host || "unknown"}-hosted service ${serviceName || "unknown"}`;

  return {
    ok: false,
    status: 409,
    data: {
      code: "restart_unsupported_for_host",
      message,
      serviceName: serviceName || null,
      host: host || "unknown",
    },
    error: message,
    executor: null,
  };
}

async function restartServiceForHost(serviceName, host) {
  const normalizedHost = normalizeHost(host, serviceName);

  if (normalizedHost === "fedora") {
    return bridgeClient.restartService(serviceName);
  }

  if (normalizedHost === "windows") {
    return windowsExecutor.restartService(serviceName);
  }

  return unsupportedRestartForHost(serviceName, normalizedHost);
}

function actionDefinition(actionType) {
  return ACTION_DEFINITIONS[actionType] || null;
}

function apiError(statusCode, code, message, details = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.payload = {
    ok: false,
    code,
    message,
    ...details,
  };
  return error;
}

function actionResponse(action, extra = {}) {
  return {
    ok: true,
    action,
    actionId: action.id,
    status: action.status,
    ...extra,
  };
}

async function refreshServices() {
  try {
    return await serviceDiscovery.listUnifiedServices();
  } catch (error) {
    return {
      ok: false,
      items: [],
      error: error.message,
    };
  }
}

function resultWithExecutionMetadata(result, action) {
  return {
    ...result,
    actionType: action.actionType,
    target: action.target,
    executedAt: new Date().toISOString(),
  };
}

async function createAction(input) {
  const actionType = normalizeActionType(input.actionType);
  const definition = actionDefinition(actionType);

  if (!definition) {
    throw apiError(400, "unsupported_action_type", `Unsupported action type: ${actionType || "none"}`);
  }

  const serviceName = normalizeServiceName(input.serviceName || input.target);

  if (definition.requiresService && !serviceName) {
    throw apiError(400, "service_required", `${actionType} requires serviceName`);
  }

  const requestedBy = String(input.requestedBy || "").trim();
  if (!requestedBy) {
    throw apiError(400, "requested_by_required", "requestedBy is required");
  }

  const host = normalizeHost(input.host, serviceName);
  const target = serviceName || input.target || "garage-control-plane";
  const status = definition.requiresApproval ? "pending" : "approved";

  return repository.createAudit({
    actionType,
    target,
    status,
    requestedBy,
    approvedBy: definition.requiresApproval ? null : requestedBy,
      input: {
        serviceName: serviceName || null,
        host,
        reason: input.reason ? String(input.reason).trim() : "",
        risk: definition.risk || null,
        requiresApproval: definition.requiresApproval,
      },
    result: {},
  });
}

async function approveAction(id, approvedBy) {
  const action = await repository.getAudit(id);

  if (!action) {
    throw apiError(404, "action_not_found", `Action ${id} was not found`);
  }

  const definition = actionDefinition(action.actionType);
  if (!definition) {
    throw apiError(400, "unsupported_action_type", `Unsupported action type: ${action.actionType}`);
  }

  if (!definition.requiresApproval) {
    throw apiError(409, "approval_not_required", `${action.actionType} does not require approval`, {
      actionId: id,
      status: action.status,
    });
  }

  if (action.status !== "pending") {
    throw apiError(409, "invalid_action_status", `Only pending actions can be approved`, {
      actionId: id,
      status: action.status,
    });
  }

  const approver = String(approvedBy || "").trim();
  if (!approver) {
    throw apiError(400, "approved_by_required", "approvedBy is required");
  }

  return repository.updateAudit(id, {
    status: "approved",
    approvedBy: approver,
  });
}

async function executeAction(id) {
  const action = await repository.getAudit(id);

  if (!action) {
    throw apiError(404, "action_not_found", `Action ${id} was not found`);
  }

  const definition = actionDefinition(action.actionType);
  if (!definition) {
    throw apiError(400, "unsupported_action_type", `Unsupported action type: ${action.actionType}`);
  }

  if (definition.requiresApproval && action.status !== "approved") {
    throw apiError(409, "approval_required", `${action.actionType} must be approved before execution`, {
      actionId: id,
      status: action.status,
    });
  }

  if (!definition.requiresApproval && action.status !== "approved") {
    throw apiError(409, "invalid_action_status", `${action.actionType} is not ready for execution`, {
      actionId: id,
      status: action.status,
    });
  }

  await repository.updateAudit(id, {
    status: "executing",
  });

  let execution;
  try {
    execution = await definition.execute({
      serviceName: action.input?.serviceName || action.target,
      host: action.input?.host || "unknown",
      action,
    });
  } catch (error) {
    const failedResult = resultWithExecutionMetadata(
      {
        ok: false,
        status: 500,
        data: null,
        error: error.message || "Action execution failed",
      },
      action,
    );

    const failedAction = await repository.updateAudit(id, {
      status: "failed",
      result: failedResult,
    });

    const services = await refreshServices();
    return {
      action: failedAction,
      result: failedResult,
      output: null,
      services,
    };
  }

  const auditResult = resultWithExecutionMetadata(execution.auditResult, action);
  const finalStatus = auditResult.ok ? "completed" : "failed";
  const updatedAction = await repository.updateAudit(id, {
    status: finalStatus,
    result: auditResult,
  });
  const services = await refreshServices();

  return {
    action: updatedAction,
    result: auditResult,
    output: execution.output || null,
    services,
  };
}

router.post(
  "/",
  asyncRoute(async (req, res) => {
    const action = await createAction(req.body || {});

    res.status(201).json(actionResponse(action));
  }),
);

router.post(
  "/:id/approve",
  asyncRoute(async (req, res) => {
    const action = await approveAction(req.params.id, req.body?.approvedBy);

    res.json(actionResponse(action));
  }),
);

router.post(
  "/:id/execute",
  asyncRoute(async (req, res) => {
    const execution = await executeAction(req.params.id);

    res.json(
      actionResponse(execution.action, {
        result: execution.result,
        output: execution.output,
        services: execution.services,
      }),
    );
  }),
);

router.post(
  "/restart-service",
  asyncRoute(async (req, res) => {
    const { serviceName, requestedBy, approvedBy, reason, host } = req.body || {};
    const action = await createAction({
      actionType: "restart-service",
      serviceName,
      requestedBy,
      reason,
      host,
    });

    if (!approvedBy || !String(approvedBy).trim()) {
      return res.status(202).json(actionResponse(action));
    }

    const approvedAction = await approveAction(action.id, approvedBy);
    const execution = await executeAction(approvedAction.id);

    return res.json(
      actionResponse(execution.action, {
        result: execution.result,
        output: execution.output,
        services: execution.services,
      }),
    );
  }),
);

router.use((error, _req, res, next) => {
  if (!error.statusCode || !error.payload) {
    return next(error);
  }

  return res.status(error.statusCode).json(error.payload);
});

module.exports = router;
