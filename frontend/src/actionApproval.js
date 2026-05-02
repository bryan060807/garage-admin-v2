import { formatActionTypeLabel, getActionRiskProfile } from "./actionRisk.js";
import { buildDependencyHealthRollup, classifyDependencyFreshness, describeInventoryFreshness } from "./dependencyHealth.js";

function readText(...values) {
  for (const value of values) {
    const text = String(value || "").trim();

    if (text) {
      return text;
    }
  }

  return "";
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeCollection(value) {
  return Array.isArray(value) ? value : [];
}

function readNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeStringArray(value) {
  return normalizeCollection(value).map((entry) => readText(entry)).filter(Boolean);
}

function resolveActionService(actionMetadata, explicitService) {
  if (explicitService) {
    return explicitService;
  }

  return (
    actionMetadata?.service ||
    actionMetadata?.action?.service ||
    actionMetadata?.targetService ||
    actionMetadata?.action?.targetService ||
    null
  );
}

function resolveActionServices(services) {
  return Array.isArray(services) ? services : [];
}

function normalizeActionReviewPhase(value) {
  const phase = readText(value).toLowerCase();
  return phase === "requested" || phase === "approved" || phase === "executed" ? phase : "";
}

function resolveActionId(actionMetadata) {
  return readText(actionMetadata?.id, actionMetadata?.actionId, actionMetadata?.action?.id, actionMetadata?.action?.actionId);
}

function resolveActionName(actionType, actionMetadata) {
  const explicitName = readText(actionMetadata?.actionName, actionMetadata?.name, actionMetadata?.label);

  if (explicitName) {
    return explicitName;
  }

  return formatActionTypeLabel(actionType);
}

function resolveServiceId(actionMetadata, service) {
  return readText(
    service?.name,
    service?.id,
    actionMetadata?.input?.serviceName,
    actionMetadata?.serviceName,
    actionMetadata?.targetService,
    actionMetadata?.target,
  );
}

function resolveServiceName(actionMetadata, service) {
  return readText(service?.displayName, service?.name, service?.id, resolveServiceId(actionMetadata, service));
}

function resolveHostLabel(actionMetadata, service) {
  return readText(
    service?.host,
    service?.inventory?.host,
    service?.runtime?.host,
    actionMetadata?.host,
    actionMetadata?.input?.host,
    "unknown",
  );
}

function resolveRuntimeManager(actionMetadata, service) {
  return readText(
    service?.manager,
    service?.inventory?.manager,
    service?.runtime?.manager,
    actionMetadata?.manager,
    actionMetadata?.input?.manager,
  );
}

function sanitizeRiskProfile(riskProfile, actionType) {
  if (!riskProfile || !isObject(riskProfile)) {
    return null;
  }

  return {
    actionType: readText(riskProfile.actionType, actionType),
    label: readText(riskProfile.label, "Unknown"),
    riskLevel: readText(riskProfile.riskLevel, "unknown"),
    detail: readText(riskProfile.detail),
    expectedImpact: readText(riskProfile.expectedImpact),
    rollbackNote: readText(riskProfile.rollbackNote),
    requiresApproval: riskProfile.requiresApproval === true,
  };
}

function sanitizeInventorySourceBreakdown(value) {
  return normalizeCollection(value)
    .filter(isObject)
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

function sanitizeInventoryFreshness(freshness) {
  if (!freshness || !isObject(freshness)) {
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

function sanitizeServiceFreshness(freshness) {
  if (!freshness || !isObject(freshness)) {
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

function sanitizeCountMap(counts) {
  if (!counts || !isObject(counts)) {
    return {};
  }

  const normalized = {};

  Object.entries(counts).forEach(([key, value]) => {
    const parsed = readNumber(value);

    if (parsed !== null) {
      normalized[key] = parsed;
    }
  });

  return normalized;
}

function sanitizeDependencyRollup(dependencyRollup) {
  if (!dependencyRollup || !isObject(dependencyRollup)) {
    return null;
  }

  return {
    declaredCount: readNumber(dependencyRollup.declaredCount) || 0,
    counts: sanitizeCountMap(dependencyRollup.counts),
    freshnessCounts: sanitizeCountMap(dependencyRollup.freshnessCounts),
    freshnessSummary: readText(dependencyRollup.freshnessSummary, "unknown"),
    items: normalizeCollection(dependencyRollup.items)
      .filter(isObject)
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

function sanitizeGate(gate, freshnessAcknowledged = false, gateDisabledReason = "") {
  if (!gate || !isObject(gate)) {
    return null;
  }

  return {
    policy: readText(gate.policy),
    message: readText(gate.message),
    requiresAcknowledgement: gate.requiresAcknowledgement === true,
    acknowledgementLabel: readText(gate.acknowledgementLabel),
    blockedUntilRefresh: gate.blockedUntilRefresh === true,
    refreshGuidance: readText(gate.refreshGuidance),
    freshnessAcknowledged: freshnessAcknowledged === true,
    gateDisabledReason: readText(gateDisabledReason),
  };
}

function buildCapturedAt(now) {
  const value = Number.isFinite(now) ? now : Date.now();
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? new Date().toISOString() : timestamp.toISOString();
}

export function formatApprovalFreshnessSummary(freshness, labelOverride = "") {
  if (!freshness || !isObject(freshness)) {
    return "";
  }

  const label = readText(labelOverride, freshness.label, freshness.bucket === "unknown" ? "Unknown freshness" : "");

  if (!label) {
    return "";
  }

  return freshness.ageLabel ? `${label} · checked ${freshness.ageLabel} ago` : label;
}

function buildDependencyWarnings(dependencyRollup) {
  if (!dependencyRollup || !isObject(dependencyRollup)) {
    return [];
  }

  const warnings = [];
  const staleOrUnknownDependencies = normalizeCollection(dependencyRollup.items).filter(
    (item) => item?.freshness === "stale" || item?.freshness === "unknown",
  );

  if (!staleOrUnknownDependencies.length) {
    return warnings;
  }

  warnings.push("Dependency context may be stale.");

  staleOrUnknownDependencies.forEach((item) => {
    const label = readText(item?.label, item?.serviceId, "Dependency");

    if (item?.freshness === "stale") {
      warnings.push(`${label} status may be stale.`);
      return;
    }

    warnings.push(`${label} status age unknown.`);
  });

  return warnings;
}

function resolveUnsupportedFlag(actionMetadata, riskContext) {
  if (typeof riskContext?.supported === "boolean") {
    return riskContext.supported === false;
  }

  const supported = [
    actionMetadata?.supported,
    actionMetadata?.input?.supported,
    actionMetadata?.action?.supported,
    actionMetadata?.action?.input?.supported,
  ].find((value) => typeof value === "boolean");

  return supported === false;
}

function buildGatePolicy(riskProfile, inventoryFreshness, unsupported) {
  const staleOrUnknownInventory = inventoryFreshness?.bucket === "stale" || inventoryFreshness?.bucket === "unknown";

  if (unsupported) {
    return {
      policy: "unsupported",
      message: "Unsupported actions remain blocked regardless of freshness.",
      requiresAcknowledgement: false,
      blockedUntilRefresh: true,
      acknowledgementLabel: "",
      refreshGuidance: "This action is unavailable for the selected service.",
    };
  }

  if (riskProfile.riskLevel === "safe") {
    return {
      policy: "none",
      message: "",
      requiresAcknowledgement: false,
      blockedUntilRefresh: false,
      acknowledgementLabel: "",
      refreshGuidance: "",
    };
  }

  if (riskProfile.riskLevel === "dangerous" && staleOrUnknownInventory) {
    return {
      policy: "refresh-required",
      message: "Approval is blocked until inventory is refreshed because the current context is stale or unknown.",
      requiresAcknowledgement: false,
      blockedUntilRefresh: true,
      acknowledgementLabel: "",
      refreshGuidance:
        inventoryFreshness?.bucket === "unknown"
          ? "Inventory timestamp unavailable. Refresh inventory before acting."
          : "Refresh inventory before approving this action.",
    };
  }

  if (riskProfile.riskLevel === "caution" && staleOrUnknownInventory) {
    return {
      policy: "acknowledge-stale-context",
      message: "Stale or unknown inventory context requires explicit acknowledgement before approval.",
      requiresAcknowledgement: true,
      blockedUntilRefresh: false,
      acknowledgementLabel: "I understand this action is using stale or unknown inventory context.",
      refreshGuidance:
        inventoryFreshness?.bucket === "unknown"
          ? "Inventory timestamp unavailable. Refresh inventory before acting."
          : "Refresh inventory before approving this action.",
    };
  }

  return {
    policy: "existing-approval",
    message: "",
    requiresAcknowledgement: false,
    blockedUntilRefresh: false,
    acknowledgementLabel: "",
    refreshGuidance: "",
  };
}

export function buildActionApprovalContext({
  actionType,
  actionMetadata = {},
  service = null,
  services = [],
  inventorySnapshot = null,
  inventoryFreshness = null,
  dependencyRollup = null,
  riskContext = {},
  now = Date.now(),
} = {}) {
  const resolvedService = resolveActionService(actionMetadata, service);
  const resolvedServices = resolveActionServices(services);
  const riskProfile = getActionRiskProfile(actionType, actionMetadata, riskContext);
  const resolvedInventoryFreshness =
    inventoryFreshness ||
    describeInventoryFreshness(inventorySnapshot, {
      services: resolvedServices,
      now,
    });
  const serviceFreshness = resolvedService ? classifyDependencyFreshness(resolvedService, { now }) : null;
  const resolvedDependencyRollup =
    dependencyRollup || (resolvedService ? buildDependencyHealthRollup(resolvedService, resolvedServices, null, { now }) : null);
  const dependencyWarnings = buildDependencyWarnings(resolvedDependencyRollup);
  const unsupported = resolveUnsupportedFlag(actionMetadata, riskContext);
  const gate = buildGatePolicy(riskProfile, resolvedInventoryFreshness, unsupported);

  return {
    riskProfile,
    inventoryFreshness: resolvedInventoryFreshness,
    serviceFreshness,
    dependencyRollup: resolvedDependencyRollup,
    dependencyWarnings,
    unsupported,
    gate,
  };
}

export function evaluateApprovalFreshnessGate(approvalContext, acknowledged = false) {
  if (!approvalContext || !isObject(approvalContext)) {
    return {
      allowed: false,
      reason: "Approval context unavailable.",
    };
  }

  if (approvalContext.gate.policy === "unsupported") {
    return {
      allowed: false,
      reason: approvalContext.gate.message || "Unsupported actions remain blocked regardless of freshness.",
    };
  }

  if (approvalContext.gate.blockedUntilRefresh) {
    return {
      allowed: false,
      reason: approvalContext.gate.refreshGuidance || approvalContext.gate.message || "Refresh inventory before approving this action.",
    };
  }

  if (approvalContext.gate.requiresAcknowledgement && !acknowledged) {
    return {
      allowed: false,
      reason: approvalContext.gate.acknowledgementLabel || "Acknowledge stale or unknown inventory context before approval.",
    };
  }

  return {
    allowed: true,
    reason: "",
  };
}

export function buildActionReviewSnapshot({
  phase = "requested",
  actionType,
  actionMetadata = {},
  service = null,
  approvalContext = null,
  services = [],
  inventorySnapshot = null,
  inventoryFreshness = null,
  dependencyRollup = null,
  riskContext = {},
  requestedBy = "",
  approvedBy = "",
  freshnessAcknowledged = false,
  gateDisabledReason = "",
  now = Date.now(),
} = {}) {
  const normalizedPhase = normalizeActionReviewPhase(phase) || "requested";
  const resolvedActionType = readText(
    actionType,
    actionMetadata?.actionType,
    actionMetadata?.action?.actionType,
    actionMetadata?.type,
  );
  const resolvedApprovalContext =
    approvalContext ||
    buildActionApprovalContext({
      actionType: resolvedActionType,
      actionMetadata,
      service,
      services,
      inventorySnapshot,
      inventoryFreshness,
      dependencyRollup,
      riskContext,
      now,
    });
  const resolvedRiskProfile =
    resolvedApprovalContext?.riskProfile || getActionRiskProfile(resolvedActionType, actionMetadata, riskContext);

  return {
    phase: normalizedPhase,
    capturedAt: buildCapturedAt(now),
    actionId: resolveActionId(actionMetadata),
    actionType: readText(resolvedRiskProfile?.actionType, resolvedActionType),
    actionName: resolveActionName(resolvedActionType, actionMetadata),
    targetServiceId: resolveServiceId(actionMetadata, service),
    targetServiceName: resolveServiceName(actionMetadata, service),
    host: resolveHostLabel(actionMetadata, service),
    runtimeManager: resolveRuntimeManager(actionMetadata, service),
    requestedBy: readText(requestedBy, actionMetadata?.requestedBy, actionMetadata?.action?.requestedBy),
    approvedBy: readText(approvedBy, actionMetadata?.approvedBy, actionMetadata?.action?.approvedBy),
    approvalContext: {
      riskProfile: sanitizeRiskProfile(resolvedRiskProfile, resolvedActionType),
      inventoryFreshness: sanitizeInventoryFreshness(resolvedApprovalContext?.inventoryFreshness),
      serviceFreshness: sanitizeServiceFreshness(resolvedApprovalContext?.serviceFreshness),
      dependencyRollup: sanitizeDependencyRollup(resolvedApprovalContext?.dependencyRollup),
      dependencyWarnings: normalizeStringArray(resolvedApprovalContext?.dependencyWarnings),
      gate: sanitizeGate(resolvedApprovalContext?.gate, freshnessAcknowledged, gateDisabledReason),
    },
  };
}

export function buildActionApprovalContextFromReviewSnapshot(snapshot) {
  if (!snapshot || !isObject(snapshot)) {
    return null;
  }

  const approvalContext = isObject(snapshot.approvalContext) ? snapshot.approvalContext : null;

  if (!approvalContext) {
    return null;
  }

  return {
    riskProfile: isObject(approvalContext.riskProfile) ? approvalContext.riskProfile : null,
    inventoryFreshness: isObject(approvalContext.inventoryFreshness) ? approvalContext.inventoryFreshness : null,
    serviceFreshness: isObject(approvalContext.serviceFreshness) ? approvalContext.serviceFreshness : null,
    dependencyRollup: isObject(approvalContext.dependencyRollup) ? approvalContext.dependencyRollup : null,
    dependencyWarnings: normalizeStringArray(approvalContext.dependencyWarnings),
    gate: isObject(approvalContext.gate) ? approvalContext.gate : null,
  };
}

export function selectActionReviewSnapshot(actionReview, preferredPhase = "") {
  if (!actionReview || !isObject(actionReview)) {
    return null;
  }

  if (isObject(actionReview.approvalContext)) {
    return actionReview;
  }

  const phases = [
    normalizeActionReviewPhase(preferredPhase),
    normalizeActionReviewPhase(actionReview.latest),
    "executed",
    "approved",
    "requested",
  ].filter(Boolean);

  for (const phase of phases) {
    if (isObject(actionReview[phase])) {
      return actionReview[phase];
    }
  }

  return null;
}
