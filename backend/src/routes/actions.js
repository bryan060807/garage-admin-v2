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

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function toPlainObject(value) {
  return isPlainObject(value) ? value : {};
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

function readNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeStringArray(value) {
  return Array.isArray(value) ? value.map((entry) => readText(entry)).filter(Boolean) : [];
}

function normalizeReviewPhase(value) {
  const phase = readText(value).toLowerCase();
  return phase === "requested" || phase === "approved" || phase === "executed" ? phase : "";
}

function buildCapturedAt(value) {
  const candidate = readText(value);

  if (!candidate) {
    return new Date().toISOString();
  }

  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function sanitizeCountMap(value) {
  const counts = toPlainObject(value);
  const normalized = {};

  Object.entries(counts).forEach(([key, rawValue]) => {
    const parsed = readNumber(rawValue);

    if (parsed !== null) {
      normalized[key] = parsed;
    }
  });

  return normalized;
}

function sanitizeInventorySourceBreakdown(value) {
  return (Array.isArray(value) ? value : [])
    .filter(isPlainObject)
    .map((source) => ({
      key: readText(source.key),
      sourceKey: readText(source.sourceKey, source.key),
      displayLabel: readText(source.displayLabel, source.key),
      bucket: readText(source.bucket, "unknown"),
      ageLabel: readText(source.ageLabel),
      checkedAt: readText(source.checkedAt),
      compactLabel: readText(source.compactLabel),
      title: readText(source.title),
    }));
}

function sanitizeRiskProfile(value, actionType) {
  const riskProfile = toPlainObject(value);

  return {
    actionType: readText(actionType, riskProfile.actionType),
    label: readText(riskProfile.label, "Unknown"),
    riskLevel: readText(riskProfile.riskLevel, "unknown"),
    detail: readText(riskProfile.detail),
    expectedImpact: readText(riskProfile.expectedImpact),
    rollbackNote: readText(riskProfile.rollbackNote),
    requiresApproval: riskProfile.requiresApproval === true,
  };
}

function sanitizeInventoryFreshness(value) {
  const freshness = toPlainObject(value);

  if (!Object.keys(freshness).length) {
    return null;
  }

  return {
    bucket: readText(freshness.bucket, "unknown"),
    label: readText(freshness.label, "Inventory freshness unknown"),
    ageMs: readNumber(freshness.ageMs),
    ageLabel: readText(freshness.ageLabel),
    ageHint: readText(freshness.ageHint),
    timestamp: readText(freshness.timestamp),
    timestampSource: readText(freshness.timestampSource),
    timestampSourceType: readText(freshness.timestampSourceType),
    timestampSourceName: readText(freshness.timestampSourceName),
    timestampField: readText(freshness.timestampField),
    provenanceText: readText(freshness.provenanceText),
    hint: readText(freshness.hint),
    sourceHint: readText(freshness.sourceHint),
    sourceHintTitle: readText(freshness.sourceHintTitle),
    sourceBreakdownSummary: readText(freshness.sourceBreakdownSummary),
    sourceBreakdownTitle: readText(freshness.sourceBreakdownTitle),
    sourceBreakdown: sanitizeInventorySourceBreakdown(freshness.sourceBreakdown),
    title: readText(freshness.title),
  };
}

function sanitizeServiceFreshness(value) {
  const freshness = toPlainObject(value);

  if (!Object.keys(freshness).length) {
    return null;
  }

  return {
    bucket: readText(freshness.bucket, "unknown"),
    label: readText(freshness.label, "unknown freshness"),
    ageMs: readNumber(freshness.ageMs),
    ageLabel: readText(freshness.ageLabel),
    timestamp: readText(freshness.timestamp),
    timestampSource: readText(freshness.timestampSource),
    timestampSourceType: readText(freshness.timestampSourceType),
    timestampSourceName: readText(freshness.timestampSourceName),
    timestampField: readText(freshness.timestampField),
  };
}

function sanitizeDependencyRollup(value) {
  const dependencyRollup = toPlainObject(value);

  if (!Object.keys(dependencyRollup).length) {
    return null;
  }

  return {
    declaredCount: readNumber(dependencyRollup.declaredCount) || 0,
    counts: sanitizeCountMap(dependencyRollup.counts),
    freshnessCounts: sanitizeCountMap(dependencyRollup.freshnessCounts),
    freshnessSummary: readText(dependencyRollup.freshnessSummary, "unknown"),
    items: (Array.isArray(dependencyRollup.items) ? dependencyRollup.items : [])
      .filter(isPlainObject)
      .map((item) => ({
        key: readText(item.key),
        serviceId: readText(item.serviceId),
        label: readText(item.label, item.serviceId, "Dependency"),
        status: readText(item.status, "unknown"),
        statusBucket: readText(item.statusBucket, "unknown"),
        rawStatus: readText(item.rawStatus),
        freshness: readText(item.freshness, "unknown"),
        freshnessLabel: readText(item.freshnessLabel, "unknown freshness"),
        freshnessTimestamp: readText(item.freshnessTimestamp),
        freshnessTimestampSource: readText(item.freshnessTimestampSource),
        diagnosisRelated: item.diagnosisRelated === true,
        diagnosisLabel: readText(item.diagnosisLabel),
        diagnosisFreshnessLabel: readText(item.diagnosisFreshnessLabel),
      })),
  };
}

function sanitizeGate(value) {
  const gate = toPlainObject(value);

  if (!Object.keys(gate).length) {
    return null;
  }

  return {
    policy: readText(gate.policy),
    message: readText(gate.message),
    requiresAcknowledgement: gate.requiresAcknowledgement === true,
    acknowledgementLabel: readText(gate.acknowledgementLabel),
    blockedUntilRefresh: gate.blockedUntilRefresh === true,
    refreshGuidance: readText(gate.refreshGuidance),
    freshnessAcknowledged: gate.freshnessAcknowledged === true,
    gateDisabledReason: readText(gate.gateDisabledReason),
  };
}

function sanitizeApprovalContext(value, actionType) {
  const approvalContext = toPlainObject(value);

  if (!Object.keys(approvalContext).length) {
    return null;
  }

  return {
    riskProfile: sanitizeRiskProfile(approvalContext.riskProfile, actionType),
    inventoryFreshness: sanitizeInventoryFreshness(approvalContext.inventoryFreshness),
    serviceFreshness: sanitizeServiceFreshness(approvalContext.serviceFreshness),
    dependencyRollup: sanitizeDependencyRollup(approvalContext.dependencyRollup),
    dependencyWarnings: normalizeStringArray(approvalContext.dependencyWarnings),
    gate: sanitizeGate(approvalContext.gate),
  };
}

function sanitizeActionReviewSnapshot(snapshot, overrides = {}) {
  const source = toPlainObject(snapshot);
  const actionType = readText(overrides.actionType, source.actionType);
  const phase = normalizeReviewPhase(overrides.phase || source.phase);

  if (!phase) {
    return null;
  }

  return {
    phase,
    capturedAt: buildCapturedAt(source.capturedAt),
    actionId: readText(overrides.actionId, source.actionId),
    actionType,
    actionName: readText(source.actionName, actionType),
    targetServiceId: readText(overrides.targetServiceId, source.targetServiceId, overrides.target),
    targetServiceName: readText(
      overrides.targetServiceName,
      source.targetServiceName,
      source.targetServiceId,
      overrides.targetServiceId,
      overrides.target,
    ),
    host: readText(overrides.host, source.host, "unknown"),
    runtimeManager: readText(source.runtimeManager),
    requestedBy: readText(overrides.requestedBy, source.requestedBy),
    approvedBy: readText(overrides.approvedBy, source.approvedBy),
    approvalContext: sanitizeApprovalContext(source.approvalContext, actionType),
  };
}

function mergeActionReviewSnapshots(currentReview, snapshot) {
  const actionReview = toPlainObject(currentReview);

  if (!snapshot || !snapshot.phase) {
    return actionReview;
  }

  return {
    ...actionReview,
    [snapshot.phase]: snapshot,
    latest: snapshot.phase,
  };
}

function mergeActionReviewIntoInput(input, snapshot, overrides = {}) {
  const currentInput = toPlainObject(input);
  const sanitizedSnapshot = sanitizeActionReviewSnapshot(snapshot, overrides);

  if (!sanitizedSnapshot) {
    return currentInput;
  }

  return {
    ...currentInput,
    actionReview: mergeActionReviewSnapshots(currentInput.actionReview, sanitizedSnapshot),
  };
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
  const auditInput = mergeActionReviewIntoInput(
    {
      serviceName: serviceName || null,
      host,
      reason: input.reason ? String(input.reason).trim() : "",
      risk: definition.risk || null,
      requiresApproval: definition.requiresApproval,
    },
    input.actionReviewSnapshot,
    {
      phase: "requested",
      actionType,
      target,
      targetServiceId: serviceName || target,
      targetServiceName: serviceName || target,
      host,
      requestedBy,
      approvedBy: definition.requiresApproval ? "" : requestedBy,
    },
  );

  return repository.createAudit({
    actionType,
    target,
    status,
    requestedBy,
    approvedBy: definition.requiresApproval ? null : requestedBy,
    input: auditInput,
    result: {},
  });
}

async function approveAction(id, approvedBy, actionReviewSnapshot = null) {
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

  const updatedInput = mergeActionReviewIntoInput(action.input, actionReviewSnapshot, {
    phase: "approved",
    actionType: action.actionType,
    actionId: action.id,
    target: action.target,
    targetServiceId: action.input?.serviceName || action.target,
    targetServiceName: action.input?.serviceName || action.target,
    host: action.input?.host || "unknown",
    requestedBy: action.requestedBy,
    approvedBy: approver,
  });

  return repository.updateAudit(id, {
    status: "approved",
    approvedBy: approver,
    input: updatedInput,
  });
}

async function executeAction(id, actionReviewSnapshot = null) {
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

  const updatedInput = mergeActionReviewIntoInput(action.input, actionReviewSnapshot, {
    phase: "executed",
    actionType: action.actionType,
    actionId: action.id,
    target: action.target,
    targetServiceId: action.input?.serviceName || action.target,
    targetServiceName: action.input?.serviceName || action.target,
    host: action.input?.host || "unknown",
    requestedBy: action.requestedBy,
    approvedBy: action.approvedBy || action.requestedBy,
  });
  const executingAction =
    (await repository.updateAudit(id, {
      status: "executing",
      input: updatedInput,
    })) || {
      ...action,
      status: "executing",
      input: updatedInput,
    };

  let execution;
  try {
    execution = await definition.execute({
      serviceName: executingAction.input?.serviceName || executingAction.target,
      host: executingAction.input?.host || "unknown",
      action: executingAction,
    });
  } catch (error) {
    const failedResult = resultWithExecutionMetadata(
      {
        ok: false,
        status: 500,
        data: null,
        error: error.message || "Action execution failed",
      },
      executingAction,
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

  const auditResult = resultWithExecutionMetadata(execution.auditResult, executingAction);
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
    const action = await approveAction(req.params.id, req.body?.approvedBy, req.body?.actionReviewSnapshot);

    res.json(actionResponse(action));
  }),
);

router.post(
  "/:id/execute",
  asyncRoute(async (req, res) => {
    const execution = await executeAction(req.params.id, req.body?.actionReviewSnapshot);

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
    const {
      serviceName,
      requestedBy,
      approvedBy,
      reason,
      host,
      actionReviewSnapshot,
      approvalActionReviewSnapshot,
      executionActionReviewSnapshot,
    } = req.body || {};
    const action = await createAction({
      actionType: "restart-service",
      serviceName,
      requestedBy,
      reason,
      host,
      actionReviewSnapshot,
    });

    if (!approvedBy || !String(approvedBy).trim()) {
      return res.status(202).json(actionResponse(action));
    }

    const approvedAction = await approveAction(
      action.id,
      approvedBy,
      approvalActionReviewSnapshot || actionReviewSnapshot || null,
    );
    const execution = await executeAction(
      approvedAction.id,
      executionActionReviewSnapshot || approvalActionReviewSnapshot || actionReviewSnapshot || null,
    );

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

router.__testables = {
  mergeActionReviewIntoInput,
  mergeActionReviewSnapshots,
  sanitizeActionReviewSnapshot,
};

module.exports = router;
