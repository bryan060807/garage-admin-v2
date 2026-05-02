function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function cleanText(value) {
  return String(value || "").trim();
}

export function normalizeActionKey(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function formatActionTypeLabel(value) {
  const text = cleanText(value);

  if (!text) {
    return "Action";
  }

  return text
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => {
      const lowered = part.toLowerCase();

      if (lowered === "pm2") {
        return "PM2";
      }

      if (lowered === "http") {
        return "HTTP";
      }

      if (lowered === "tcp") {
        return "TCP";
      }

      if (lowered === "api") {
        return "API";
      }

      if (lowered === "ui") {
        return "UI";
      }

      return lowered.charAt(0).toUpperCase() + lowered.slice(1);
    })
    .join(" ");
}

const ACTION_RISK_LABELS = Object.freeze({
  safe: "Safe",
  caution: "Caution",
  dangerous: "Dangerous",
  unknown: "Unknown",
});

const ACTION_RISK_RULES = Object.freeze({
  "fetch-logs": {
    riskLevel: "safe",
    detail: "Read-only log retrieval.",
    expectedImpact: "Read-only retrieval. No service state change is expected.",
    rollbackNote: "No rollback is required for this read-only action.",
    requiresApproval: false,
  },
  "view-logs": {
    riskLevel: "safe",
    detail: "Read-only log inspection.",
    expectedImpact: "Read-only inspection. No service state change is expected.",
    rollbackNote: "No rollback is required for this read-only action.",
  },
  "health-check": {
    riskLevel: "safe",
    detail: "Read-only health probe.",
    expectedImpact: "Read-only probe. No service state change is expected.",
    rollbackNote: "No rollback is required for this read-only action.",
    requiresApproval: false,
  },
  "run-health-check": {
    riskLevel: "safe",
    detail: "Read-only health probe.",
    expectedImpact: "Read-only probe. No service state change is expected.",
    rollbackNote: "No rollback is required for this read-only action.",
  },
  "view-status": {
    riskLevel: "safe",
    detail: "Read-only status inspection.",
    expectedImpact: "Read-only inspection. No service state change is expected.",
    rollbackNote: "No rollback is required for this read-only action.",
  },
  "refresh-inventory": {
    riskLevel: "safe",
    detail: "Refreshes operator inventory data without mutating runtime state.",
    expectedImpact: "Refreshes inventory metadata. No service state change is expected.",
    rollbackNote: "No rollback is required for this metadata refresh.",
  },
  "copy-latest": {
    riskLevel: "safe",
    detail: "Copies the latest local result without changing service state.",
    expectedImpact: "Clipboard-only action. No service state change is expected.",
    rollbackNote: "No rollback is required for this local UI action.",
  },
  "clear-filter": {
    riskLevel: "safe",
    detail: "Clears local UI filters only.",
    expectedImpact: "Local UI state resets. No service state change is expected.",
    rollbackNote: "No rollback is required for this local UI action.",
  },
  "restart-service": {
    riskLevel: "caution",
    detail: "State-changing runtime restart.",
    expectedImpact: "Temporary service interruption while the process restarts.",
    rollbackNote: "No file or config changes are expected. If restart fails, inspect logs and service status.",
    requiresApproval: true,
  },
  "reload-config": {
    riskLevel: "caution",
    detail: "Reloads active configuration into the running service.",
    expectedImpact: "May briefly interrupt service while configuration is reloaded.",
    rollbackNote: "Restore previous config and reload again if behavior regresses.",
  },
  "rebuild-container": {
    riskLevel: "caution",
    detail: "Replaces the active container or image.",
    expectedImpact: "May replace runtime image/container and interrupt service.",
    rollbackNote: "Rollback requires previous image/container artifact or redeploying the prior version.",
  },
  "re-run-discovery": {
    riskLevel: "caution",
    detail: "Refreshes discovery state and may update active inventory.",
    expectedImpact: "May update discovered runtime metadata and briefly interrupt the current workflow.",
    rollbackNote: "No automatic rollback is defined.",
  },
  "restart-pm2-process": {
    riskLevel: "caution",
    detail: "Restarts a PM2-managed runtime process.",
    expectedImpact: "Temporary service interruption while the PM2 process restarts.",
    rollbackNote: "No file or config changes are expected. If restart fails, inspect logs and process status.",
  },
  "restart-systemd-user-service": {
    riskLevel: "caution",
    detail: "Restarts a systemd user service.",
    expectedImpact: "Temporary service interruption while the user service restarts.",
    rollbackNote: "No file or config changes are expected. If restart fails, inspect logs and service status.",
  },
  "clear-logs": {
    riskLevel: "dangerous",
    detail: "Deletes persisted logs.",
    expectedImpact: "Persistent change. Review target and rollback plan before approving.",
    rollbackNote: "No automatic rollback is defined.",
  },
  "delete-data": {
    riskLevel: "dangerous",
    detail: "Deletes persisted service data.",
    expectedImpact: "Persistent change. Review target and rollback plan before approving.",
    rollbackNote: "No automatic rollback is defined.",
  },
  "prune-docker": {
    riskLevel: "dangerous",
    detail: "Prunes Docker runtime artifacts.",
    expectedImpact: "Persistent change. Review target and rollback plan before approving.",
    rollbackNote: "No automatic rollback is defined.",
  },
  "prune-podman": {
    riskLevel: "dangerous",
    detail: "Prunes Podman runtime artifacts.",
    expectedImpact: "Persistent change. Review target and rollback plan before approving.",
    rollbackNote: "No automatic rollback is defined.",
  },
  "remove-container": {
    riskLevel: "dangerous",
    detail: "Removes a runtime container.",
    expectedImpact: "Persistent change. Review target and rollback plan before approving.",
    rollbackNote: "No automatic rollback is defined.",
  },
  "modify-config": {
    riskLevel: "dangerous",
    detail: "Modifies persistent configuration.",
    expectedImpact: "Persistent change. Review target and rollback plan before approving.",
    rollbackNote: "No automatic rollback is defined.",
  },
  "write-file": {
    riskLevel: "dangerous",
    detail: "Writes persistent file changes.",
    expectedImpact: "Persistent change. Review target and rollback plan before approving.",
    rollbackNote: "No automatic rollback is defined.",
  },
  "run-repair": {
    riskLevel: "dangerous",
    detail: "Runs a repair flow that may alter durable state.",
    expectedImpact: "Persistent change. Review target and rollback plan before approving.",
    rollbackNote: "No automatic rollback is defined.",
  },
  "database-migration": {
    riskLevel: "dangerous",
    detail: "Applies a database migration.",
    expectedImpact: "Persistent change. Review target and rollback plan before approving.",
    rollbackNote: "No automatic rollback is defined.",
  },
});

const SAFE_RISK_TOKENS = new Set(["safe", "low", "readonly", "read-only", "routine", "info"]);
const CAUTION_RISK_TOKENS = new Set(["caution", "medium", "moderate", "warning", "state-changing", "stateful"]);
const DANGEROUS_RISK_TOKENS = new Set(["dangerous", "high", "critical", "destructive", "persistent", "severe"]);

const SAFE_ACTION_PATTERNS = [/^fetch-/, /^view-/, /health/, /status/, /^refresh-inventory$/, /^copy-latest$/, /^clear-filter$/];
const CAUTION_ACTION_PATTERNS = [/^restart-/, /^reload-/, /^rebuild-/, /discovery$/];
const DANGEROUS_ACTION_PATTERNS = [/clear-logs/, /delete/, /prune/, /remove/, /modify/, /write/, /repair/, /migration/, /^migrate-/];

function collectMetadataSources(metadata) {
  if (!isObject(metadata)) {
    return [];
  }

  const sources = [];
  const queue = [metadata];

  while (queue.length) {
    const candidate = queue.shift();

    if (!isObject(candidate) || sources.includes(candidate)) {
      continue;
    }

    sources.push(candidate);

    ["input", "result", "action", "capability", "definition", "meta", "metadata", "data"].forEach((key) => {
      if (isObject(candidate[key])) {
        queue.push(candidate[key]);
      }
    });
  }

  return sources;
}

function readMetadataString(metadata, keys) {
  for (const source of collectMetadataSources(metadata)) {
    for (const key of keys) {
      const text = cleanText(source[key]);

      if (text) {
        return text;
      }
    }
  }

  return "";
}

function readMetadataBoolean(metadata, keys) {
  for (const source of collectMetadataSources(metadata)) {
    for (const key of keys) {
      if (typeof source[key] === "boolean") {
        return source[key];
      }
    }
  }

  return null;
}

export function normalizeActionRiskLevel(value) {
  const normalized = normalizeActionKey(value).replace(/-risk$/, "");

  if (!normalized) {
    return "unknown";
  }

  if (SAFE_RISK_TOKENS.has(normalized)) {
    return "safe";
  }

  if (CAUTION_RISK_TOKENS.has(normalized)) {
    return "caution";
  }

  if (DANGEROUS_RISK_TOKENS.has(normalized)) {
    return "dangerous";
  }

  return "unknown";
}

function inferActionRiskLevel(actionType, metadata) {
  const normalizedActionType = normalizeActionKey(actionType);
  const explicitRiskLevel = normalizeActionRiskLevel(
    readMetadataString(metadata, ["riskLevel", "risk", "actionRiskLevel", "actionRisk", "riskLabel", "risk_label"]),
  );

  if (explicitRiskLevel !== "unknown") {
    return explicitRiskLevel;
  }

  if (ACTION_RISK_RULES[normalizedActionType]?.riskLevel) {
    return ACTION_RISK_RULES[normalizedActionType].riskLevel;
  }

  if (DANGEROUS_ACTION_PATTERNS.some((pattern) => pattern.test(normalizedActionType))) {
    return "dangerous";
  }

  if (CAUTION_ACTION_PATTERNS.some((pattern) => pattern.test(normalizedActionType))) {
    return "caution";
  }

  if (SAFE_ACTION_PATTERNS.some((pattern) => pattern.test(normalizedActionType))) {
    return "safe";
  }

  if (readMetadataBoolean(metadata, ["requiresApproval", "approvalRequired"]) === true) {
    return "caution";
  }

  return "unknown";
}

function resolveActionRequiresApproval(actionType, metadata) {
  const explicitValue = readMetadataBoolean(metadata, ["requiresApproval", "approvalRequired"]);

  if (explicitValue !== null) {
    return explicitValue;
  }

  const normalizedActionType = normalizeActionKey(actionType);
  return ACTION_RISK_RULES[normalizedActionType]?.requiresApproval === true;
}

function defaultRiskDetail(riskLevel, requiresApproval) {
  if (riskLevel === "safe") {
    return "Read-only action.";
  }

  if (riskLevel === "caution") {
    return requiresApproval ? "Approval-gated state change." : "State-changing action.";
  }

  if (riskLevel === "dangerous") {
    return "Persistent or destructive action.";
  }

  return "Review target, impact, and rollback before running.";
}

function defaultExpectedImpact(riskLevel) {
  if (riskLevel === "safe") {
    return "Read-only action. No service state change is expected.";
  }

  if (riskLevel === "caution") {
    return "May interrupt service or change active runtime state.";
  }

  if (riskLevel === "dangerous") {
    return "Persistent change. Review target and rollback plan before approving.";
  }

  return "Impact is not fully described. Review the target and execution path before continuing.";
}

function defaultRollbackNote(riskLevel) {
  if (riskLevel === "safe") {
    return "No rollback is required for this read-only action.";
  }

  if (riskLevel === "caution") {
    return "Validate service health after execution and restore the prior runtime state if behavior regresses.";
  }

  if (riskLevel === "dangerous") {
    return "No automatic rollback is defined.";
  }

  return "No automatic rollback is defined.";
}

function getRestartExpectedImpact(context) {
  if (context.supported === false) {
    return "Restart is not supported for this service from this executor.";
  }

  const host = normalizeActionKey(context.host || context.service?.host);
  const manager = normalizeActionKey(
    context.manager || context.service?.manager || context.service?.inventory?.manager || context.service?.runtime?.manager,
  );

  if (host === "fedora") {
    return "Temporary interruption of the Fedora control-plane service while it restarts.";
  }

  if (manager === "pm2") {
    return "Temporary interruption while the Windows-hosted PM2 process restarts.";
  }

  return "Temporary service interruption while the process restarts.";
}

export function getActionRiskProfile(actionType, metadata = {}, context = {}) {
  const normalizedActionType = normalizeActionKey(actionType);
  const rule = ACTION_RISK_RULES[normalizedActionType] || null;
  const riskLevel = inferActionRiskLevel(actionType, metadata);
  const requiresApproval = resolveActionRequiresApproval(actionType, metadata);
  const label = ACTION_RISK_LABELS[riskLevel] || ACTION_RISK_LABELS.unknown;
  const detail = rule?.detail || defaultRiskDetail(riskLevel, requiresApproval);
  const expectedImpact =
    normalizedActionType === "restart-service"
      ? getRestartExpectedImpact(context)
      : rule?.expectedImpact || defaultExpectedImpact(riskLevel);
  const rollbackNote = rule?.rollbackNote || defaultRollbackNote(riskLevel);

  return {
    actionType: normalizedActionType,
    label,
    riskLevel,
    detail,
    expectedImpact,
    rollbackNote,
    requiresApproval,
  };
}

export function shouldShowActionApprovalPreview(actionType, metadata = {}, context = {}) {
  const profile = getActionRiskProfile(actionType, metadata, context);
  return profile.requiresApproval || profile.riskLevel === "caution" || profile.riskLevel === "dangerous";
}
