import { getActionRiskProfile } from "./actionRisk.js";
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
