import { formatActionTypeLabel, getActionRiskProfile } from "./actionRisk.js";

export const ASSISTANT_PLAN_CHIPS = Object.freeze([
  {
    id: "build-diagnosis-plan",
    label: "Diagnosis plan",
  },
  {
    id: "build-log-inspection-plan",
    label: "Log review",
  },
  {
    id: "build-health-verification-plan",
    label: "Health check",
  },
  {
    id: "build-restart-request-plan",
    label: "Restart request",
  },
  {
    id: "build-dependency-trace-plan",
    label: "Dependency trace",
  },
  {
    id: "build-stale-inventory-plan",
    label: "Stale inventory",
  },
  {
    id: "build-report-evidence-plan",
    label: "Report evidence",
  },
  {
    id: "build-file-evidence-plan",
    label: "File evidence",
  },
]);

const PLAN_GROUPS = Object.freeze({
  "build-diagnosis-plan": ["diagnose-failed-service", "summarize-recent-audit-history"],
  "build-log-inspection-plan": ["inspect-logs"],
  "build-health-verification-plan": ["verify-health"],
  "build-restart-request-plan": ["prepare-restart-request", "summarize-recent-audit-history"],
  "build-dependency-trace-plan": ["trace-dependency-failure"],
  "build-stale-inventory-plan": ["explain-stale-inventory", "refresh-inventory"],
  "build-report-evidence-plan": ["find-supporting-report-runbook"],
  "build-file-evidence-plan": ["inspect-safe-file-evidence"],
});

function cleanText(value) {
  return String(value || "").trim();
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function toObject(value) {
  return isObject(value) ? value : {};
}

function normalizeObjects(value) {
  return Array.isArray(value) ? value.filter((entry) => isObject(entry)) : [];
}

function normalizeStrings(value) {
  return Array.isArray(value)
    ? Array.from(new Set(value.map((entry) => cleanText(entry)).filter(Boolean)))
    : [];
}

function readText(...values) {
  for (const value of values) {
    const text = cleanText(value);

    if (text) {
      return text;
    }
  }

  return "";
}

function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function truncateText(value, maxLength = 180) {
  const text = cleanText(value);

  if (!text || text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function formatLookupKindLabel(value) {
  return cleanText(value)
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatRiskBadge(riskProfile) {
  return {
    level: readText(riskProfile?.riskLevel, "unknown"),
    label: readText(riskProfile?.label, "Unknown"),
    detail: readText(riskProfile?.detail),
    expectedImpact: readText(riskProfile?.expectedImpact),
    rollbackNote: readText(riskProfile?.rollbackNote),
    requiresApproval: riskProfile?.requiresApproval === true,
  };
}

function formatTimestamp(value) {
  const text = cleanText(value);

  if (!text) {
    return "";
  }

  const parsed = Date.parse(text);

  if (!Number.isFinite(parsed)) {
    return text;
  }

  return new Date(parsed).toISOString();
}

function formatHostOwnership(host) {
  const normalizedHost = cleanText(host).toLowerCase();

  if (normalizedHost === "fedora") {
    return {
      key: "fedora",
      label: "Fedora control-plane",
    };
  }

  if (normalizedHost === "windows") {
    return {
      key: "windows",
      label: "Windows runtime/operator",
    };
  }

  if (normalizedHost === "cross-host" || normalizedHost === "docs") {
    return {
      key: "cross-host",
      label: "Cross-host docs",
    };
  }

  return {
    key: "unknown",
    label: "Unknown",
  };
}

function buildInventoryFreshnessStatus(assistantContext) {
  const freshness = toObject(assistantContext?.inventory?.freshness);
  const bucket = readText(freshness.bucket, "unknown");

  return {
    appearance: "freshness",
    tone: bucket,
    label: readText(freshness.label, bucket === "unknown" ? "Unknown freshness" : "Inventory freshness"),
    detail: readText(freshness.provenanceText, freshness.ageHint, freshness.hint),
  };
}

function buildRestartFreshnessStatus(assistantContext, restartApprovalContext) {
  const gate = toObject(restartApprovalContext?.gate);
  const policy = readText(gate.policy, assistantContext?.approval?.gate?.policy);

  if (policy === "unsupported") {
    return {
      appearance: "risk",
      tone: "dangerous",
      label: "Unsupported",
      detail: readText(gate.refreshGuidance, gate.message, "Restart is unavailable for this service."),
    };
  }

  if (policy === "refresh-required") {
    return {
      appearance: "risk",
      tone: "dangerous",
      label: "Refresh required",
      detail: readText(gate.refreshGuidance, gate.message, "Refresh inventory before requesting approval."),
    };
  }

  if (policy === "acknowledge-stale-context") {
    return {
      appearance: "risk",
      tone: "caution",
      label: "Acknowledge stale context",
      detail: readText(
        gate.acknowledgementLabel,
        gate.refreshGuidance,
        gate.message,
        "Approval requires explicit acknowledgement of stale inventory context.",
      ),
    };
  }

  return buildInventoryFreshnessStatus(assistantContext);
}

function buildTargetService(assistantContext, fallbackServiceName = "") {
  const service = toObject(assistantContext?.service);
  const serviceName = readText(service.name, fallbackServiceName);

  if (!serviceName) {
    return null;
  }

  return {
    id: serviceName,
    name: readText(service.displayName, serviceName),
  };
}

function summarizeStaleSources(assistantContext) {
  const staleSources = normalizeObjects(assistantContext?.inventory?.staleOrUnknownSources);

  if (!staleSources.length) {
    return "";
  }

  return staleSources
    .map((source) => `${source.displayLabel || source.key || "Unknown source"} (${readText(source.bucket, "unknown")})`)
    .join(", ");
}

function pickFocusDependency(assistantContext) {
  const diagnosis = toObject(assistantContext?.diagnosis);
  const dependencies = normalizeObjects(assistantContext?.relationships?.dependencies);
  const relatedServiceId = readText(diagnosis.relatedServiceId).toLowerCase();

  if (relatedServiceId) {
    const relatedDependency = dependencies.find(
      (dependency) => cleanText(dependency.serviceId).toLowerCase() === relatedServiceId,
    );

    if (relatedDependency) {
      return relatedDependency;
    }
  }

  return (
    dependencies.find((dependency) => readText(dependency.statusBucket, "unknown") !== "healthy") ||
    dependencies[0] ||
    null
  );
}

function getLookupSafetyLabel(item) {
  const status = cleanText(item?.safetyStatus).toLowerCase();

  if (status === "blocked") {
    return "Blocked";
  }

  if (status === "warning") {
    return "Guarded";
  }

  return "Safe";
}

function buildLookupEvidence(item) {
  if (!isObject(item)) {
    return null;
  }

  const kind = cleanText(item.kind).toLowerCase();
  let summary = readText(item.blockedReason);

  if (!summary && kind === "log-preview") {
    summary = readText(item.snippet, item.sourceLabel, "Capped read-only log preview.");
  } else if (!summary && kind === "report") {
    summary = readText(item.snippet, item.sourceLabel, "Registered report metadata.");
  } else if (!summary && kind === "file-preview") {
    summary = item.truncated
      ? "Safe preview available. Preview truncated by the safety cap."
      : "Safe preview available from the allowlisted path.";
  } else if (!summary && kind === "file") {
    summary = readText(item.snippet, item.sourceLabel, "Allowlisted file lookup result.");
  }

  return {
    key: readText(item.id, item.path, item.reportId, item.serviceName, item.title, "lookup-evidence"),
    kind: formatLookupKindLabel(item.kind || "lookup"),
    title: readText(item.title, item.relativePath, item.serviceName, "Lookup evidence"),
    summary: truncateText(summary || "Lookup evidence is available but the summary is limited by safety caps."),
    sourceLabel: readText(item.sourceLabel),
    safetyLabel: getLookupSafetyLabel(item),
    hostOwnership: formatHostOwnership(item.hostContext),
  };
}

function buildLogSummaryEvidence(assistantContext) {
  const serviceLabel = readText(assistantContext?.service?.displayName, assistantContext?.service?.name, "Selected service");
  const logSummary = toObject(assistantContext?.rawLogSummary);
  const fetchedAt = formatTimestamp(logSummary.fetchedAt);
  const parts = [readText(logSummary.summary, "No log summary available.")];

  if (logSummary.visibleLineCount) {
    parts.push(`${pluralize(Number(logSummary.visibleLineCount || 0), "visible line")}`);
  }

  if (fetchedAt) {
    parts.push(`fetched ${fetchedAt}`);
  }

  return {
    key: `log-summary:${cleanText(assistantContext?.service?.name) || "none"}`,
    kind: "Log Summary",
    title: `${serviceLabel} log summary`,
    summary: parts.join(" | "),
    sourceLabel: "Current assistant context",
    safetyLabel: "Safe",
    hostOwnership: formatHostOwnership(assistantContext?.service?.host),
  };
}

function buildDependencyEvidence(assistantContext) {
  const dependency = pickFocusDependency(assistantContext);

  if (!dependency) {
    return null;
  }

  const label = readText(dependency.displayName, dependency.serviceId, "Dependency");
  const parts = [
    label,
    dependency.host ? `${formatHostOwnership(dependency.host).label}` : "",
    dependency.endpoint ? `via ${dependency.endpoint}` : "",
    dependency.status ? `status ${dependency.status}` : "",
    dependency.freshnessLabel ? dependency.freshnessLabel : dependency.freshness ? `freshness ${dependency.freshness}` : "",
    dependency.diagnosisLabel ? dependency.diagnosisLabel : "",
  ].filter(Boolean);

  return {
    key: `dependency:${cleanText(dependency.serviceId || dependency.endpoint || label)}`,
    kind: "Dependency",
    title: label,
    summary: truncateText(parts.join(" | ")),
    sourceLabel: "Declared dependency mapping",
    safetyLabel: "Safe",
    hostOwnership: formatHostOwnership(dependency.host),
  };
}

function buildDiagnosisEvidence(assistantContext) {
  const diagnosis = toObject(assistantContext?.diagnosis);

  if (diagnosis.detected !== true) {
    return null;
  }

  const summary = truncateText(
    [diagnosis.primaryIssue, diagnosis.likelyCause, diagnosis.mostRelevantError].filter(Boolean).join(" | "),
  );

  return {
    key: `diagnosis:${cleanText(assistantContext?.service?.name) || "none"}`,
    kind: "Diagnosis",
    title: readText(diagnosis.primaryIssue, "Current diagnosis"),
    summary: summary || "Diagnosis detected in the current UI context.",
    sourceLabel: "Current assistant context",
    safetyLabel: "Safe",
    hostOwnership: formatHostOwnership(
      readText(diagnosis.relatedServiceHost, assistantContext?.service?.host, "unknown"),
    ),
  };
}

function buildAuditSnapshot(entries) {
  const items = normalizeObjects(entries);

  return {
    count: items.length,
    pendingCount: items.filter((entry) => readText(entry.status) === "pending").length,
    approvedCount: items.filter((entry) => readText(entry.status) === "approved").length,
    executingCount: items.filter((entry) => readText(entry.status) === "executing").length,
    failedCount: items.filter((entry) => readText(entry.status) === "failed").length,
    completedCount: items.filter((entry) => readText(entry.status) === "completed").length,
    latestEntry: items[0] || null,
    items: items.slice(0, 3),
  };
}

function buildAuditEvidence(entry, serviceHost = "") {
  if (!isObject(entry)) {
    return null;
  }

  const actionType = readText(entry.actionType, entry.action?.actionType);
  const status = readText(entry.status, "unknown");
  const createdAt = formatTimestamp(readText(entry.createdAt, entry.action?.createdAt));
  const requestedBy = readText(entry.requestedBy, entry.action?.requestedBy);
  const summary = [
    `${formatActionTypeLabel(actionType || "action")} ${status}`,
    createdAt ? `created ${createdAt}` : "",
    requestedBy ? `requested by ${requestedBy}` : "",
  ]
    .filter(Boolean)
    .join(" | ");

  return {
    key: `audit:${cleanText(entry.id || actionType || status || createdAt)}`,
    kind: "Audit",
    title: readText(entry.target, entry.action?.target, "Recent audit entry"),
    summary: summary || "Recent audit entry is available.",
    sourceLabel: "Recent audit",
    safetyLabel: "Safe",
    hostOwnership: formatHostOwnership(serviceHost),
  };
}

function buildServiceSelectionStep() {
  return "Select a service first so the plan can use grounded host ownership, diagnosis, freshness, dependency, and approval context.";
}

function buildSharedBlockedNote(planLabel) {
  return `${planLabel} stays read-only in chat. Chat cannot execute restarts, approvals, repairs, writes, deletes, or unsupported cross-host access.`;
}

function pickLookupItem(kindMatchers, selectedLookupItem, lookupItems) {
  const selectedKind = cleanText(selectedLookupItem?.kind).toLowerCase();

  if (selectedLookupItem && kindMatchers.some((matcher) => matcher(selectedKind, selectedLookupItem))) {
    return selectedLookupItem;
  }

  return (
    normalizeObjects(lookupItems).find((item) =>
      kindMatchers.some((matcher) => matcher(cleanText(item.kind).toLowerCase(), item)),
    ) || null
  );
}

function buildDiagnosisPlan({
  assistantContext,
  selectedLookupItem,
  lookupItems,
}) {
  const targetService = buildTargetService(assistantContext);
  const serviceLabel = readText(targetService?.name, "selected service");
  const diagnosis = toObject(assistantContext?.diagnosis);
  const dependencySummary = toObject(assistantContext?.relationships?.dependencySummary);
  const risk = formatRiskBadge(getActionRiskProfile("view-status"));
  const evidence = [];
  const lookupEvidence = buildLookupEvidence(selectedLookupItem);
  const diagnosisEvidence = buildDiagnosisEvidence(assistantContext);
  const logEvidence = buildLogSummaryEvidence(assistantContext);
  const dependencyEvidence = buildDependencyEvidence(assistantContext);

  if (diagnosisEvidence) {
    evidence.push(diagnosisEvidence);
  }

  if (dependencyEvidence) {
    evidence.push(dependencyEvidence);
  }

  if (logEvidence) {
    evidence.push(logEvidence);
  }

  if (lookupEvidence) {
    evidence.push(lookupEvidence);
  }

  let currentEvidenceSummary =
    "No service is selected, so the diagnosis plan cannot confirm host ownership, service status, log context, or dependency state.";

  if (targetService) {
    const parts = [];

    if (diagnosis.detected === true) {
      parts.push(readText(diagnosis.primaryIssue, diagnosis.mostRelevantError, "Diagnosis indicates an issue."));
      parts.push(readText(diagnosis.likelyCause, diagnosis.correlationReason));
    } else {
      parts.push("No active diagnosis is detected from the current UI state.");
    }

    if (dependencySummary.attentionCount) {
      parts.push(
        `${pluralize(Number(dependencySummary.attentionCount || 0), "dependency warning")} across ${pluralize(Number(dependencySummary.declaredCount || 0), "declared dependency", "declared dependencies")}.`,
      );
    }

    parts.push(readText(assistantContext?.rawLogSummary?.summary));
    currentEvidenceSummary = parts.filter(Boolean).join(" ");
  }

  const readOnlySteps = targetService
    ? [
        `Confirm ${serviceLabel} ownership, status, and runtime details before assuming the failure sits on Windows or Fedora.`,
        diagnosis.detected === true
          ? `Review the grounded diagnosis for ${serviceLabel} and compare it to the current log summary.`
          : `Use the current log summary and service details to confirm whether ${serviceLabel} is actually failing or just missing evidence.`,
        dependencySummary.declaredCount
          ? "Compare the selected service to its declared dependencies before planning any restart."
          : "No declared dependencies are mapped, so treat dependency cause as unknown until you refresh or gather more evidence.",
        "Keep diagnosis read-only until the current host and dependency boundary are clear.",
      ]
    : [buildServiceSelectionStep()];

  const approvalSteps =
    targetService && assistantContext?.capabilities?.restart?.supported === true
      ? [
          "If read-only checks still point to a restart, switch to the restart request plan and route it through the existing approval workflow.",
        ]
      : [];

  return {
    id: `assistant-plan:diagnose-failed-service:${targetService?.id || "none"}`,
    title: targetService ? `Diagnose ${serviceLabel}` : "Diagnose selected service",
    planType: "diagnose failed service",
    targetService,
    hostOwnership: formatHostOwnership(assistantContext?.service?.host),
    risk,
    freshnessGateStatus: buildInventoryFreshnessStatus(assistantContext),
    currentEvidenceSummary: currentEvidenceSummary || "Diagnosis evidence is currently unknown.",
    readOnlySteps,
    approvalSteps,
    expectedImpact: readText(risk.expectedImpact, "Read-only inspection of current UI evidence."),
    rollbackNote: "",
    blockedNote: buildSharedBlockedNote("Diagnosis"),
    supportingEvidence: evidence.slice(0, 4),
    nextRecommendedAction: targetService
      ? {
          id: "query-logs",
          label: "Run safe log query",
          serviceName:
            readText(diagnosis.relatedServiceId) && cleanText(diagnosis.relatedServiceId) !== cleanText(targetService.id)
              ? diagnosis.relatedServiceId
              : targetService.id,
        }
      : null,
  };
}

function buildLogInspectionPlan({
  assistantContext,
  selectedLookupItem,
  lookupItems,
}) {
  const targetService = buildTargetService(assistantContext, readText(selectedLookupItem?.serviceName));
  const serviceLabel = readText(targetService?.name, selectedLookupItem?.serviceName, "selected service");
  const diagnosis = toObject(assistantContext?.diagnosis);
  const logSummary = toObject(assistantContext?.rawLogSummary);
  const risk = formatRiskBadge(getActionRiskProfile("fetch-logs"));
  const logLookupItem = pickLookupItem(
    [(kind) => kind === "log-preview"],
    selectedLookupItem,
    lookupItems,
  );
  const evidence = [buildLogSummaryEvidence(assistantContext), buildLookupEvidence(logLookupItem)].filter(Boolean);

  let currentEvidenceSummary =
    "No service is selected, so log inspection cannot stay grounded in a host-aware service target.";

  if (targetService) {
    const parts = [
      readText(logSummary.summary, "No log summary is currently visible."),
      logSummary.filtered ? "The current log summary is already filtered." : "",
      logLookupItem ? readText(logLookupItem.snippet) : "",
    ].filter(Boolean);

    currentEvidenceSummary = parts.join(" ");
  }

  const readOnlySteps = targetService
    ? [
        `Use Query Logs to fetch a capped read-only preview for ${serviceLabel}.`,
        diagnosis.detected === true && readText(diagnosis.errorType)
          ? `Filter for ${diagnosis.errorType} or the current diagnosis keywords before broadening the search.`
          : "Filter for the primary error text or the most recent warning before broadening the search.",
        readText(diagnosis.relatedServiceId)
          ? `Inspect ${readText(diagnosis.relatedServiceName, diagnosis.relatedServiceId)} separately if the diagnosis points to a dependency-owned failure.`
          : "Compare the log summary to the latest diagnosis and dependency state before changing service state.",
      ]
    : [buildServiceSelectionStep()];

  const approvalSteps =
    targetService && assistantContext?.capabilities?.restart?.supported === true
      ? [
          "If logs, health checks, and dependency review all point to a restart, open Service Actions and use the restart approval workflow there.",
        ]
      : [];

  return {
    id: `assistant-plan:inspect-logs:${targetService?.id || "none"}`,
    title: targetService ? `Inspect logs for ${serviceLabel}` : "Inspect service logs",
    planType: "inspect logs",
    targetService,
    hostOwnership: formatHostOwnership(readText(logLookupItem?.hostContext, assistantContext?.service?.host, "unknown")),
    risk,
    freshnessGateStatus: buildInventoryFreshnessStatus(assistantContext),
    currentEvidenceSummary: currentEvidenceSummary || "Log evidence is currently unknown.",
    readOnlySteps,
    approvalSteps,
    expectedImpact: readText(risk.expectedImpact),
    rollbackNote: "",
    blockedNote: "Plan cards never dump raw private logs. Chat only uses capped previews and sanitized summaries.",
    supportingEvidence: evidence.slice(0, 3),
    nextRecommendedAction: targetService
      ? {
          id: "query-logs",
          label: "Run safe log query",
          serviceName: readText(logLookupItem?.serviceName, targetService.id),
        }
      : null,
  };
}

function buildHealthVerificationPlan({
  assistantContext,
  healthOutput,
  healthMeta,
}) {
  const targetService = buildTargetService(assistantContext);
  const serviceLabel = readText(targetService?.name, "selected service");
  const risk = formatRiskBadge(getActionRiskProfile("health-check"));
  const healthStatus = healthOutput
    ? healthOutput.ok === true
      ? "Latest visible health output reports ok."
      : readText(healthOutput.error, healthOutput.status, "Latest visible health output needs attention.")
    : "No visible health output is currently available.";
  const currentEvidenceSummary = targetService
    ? [
        healthStatus,
        readText(assistantContext?.service?.localHealthUrl) ? `Local health URL: ${assistantContext.service.localHealthUrl}.` : "",
        readText(assistantContext?.service?.publicUrl) ? `Public URL: ${assistantContext.service.publicUrl}.` : "",
        formatTimestamp(readText(healthMeta?.receivedAt))
          ? `Latest visible result received ${formatTimestamp(readText(healthMeta?.receivedAt))}.`
          : "",
      ]
        .filter(Boolean)
        .join(" ")
    : "No service is selected, so health verification cannot target a grounded endpoint.";

  const readOnlySteps = targetService
    ? [
        `Confirm the mapped health endpoints for ${serviceLabel} before treating a probe failure as a runtime failure.`,
        assistantContext?.capabilities?.health?.supported === true
          ? "Run the existing read-only health check from Service Actions and compare the result to the current diagnosis."
          : "Health-check support is unknown or unavailable, so rely on mapped endpoints, logs, and dependency state before escalating.",
        "If health is not ok, compare the result to dependency freshness and recent logs before considering a restart request.",
      ]
    : [buildServiceSelectionStep()];

  const approvalSteps =
    targetService && assistantContext?.capabilities?.restart?.supported === true
      ? [
          "Only prepare a restart request after health checks, logs, and dependency status all support the same conclusion.",
        ]
      : [];

  const evidence = [buildDiagnosisEvidence(assistantContext), buildLogSummaryEvidence(assistantContext)].filter(Boolean);

  return {
    id: `assistant-plan:verify-health:${targetService?.id || "none"}`,
    title: targetService ? `Verify health for ${serviceLabel}` : "Verify service health",
    planType: "verify health",
    targetService,
    hostOwnership: formatHostOwnership(assistantContext?.service?.host),
    risk,
    freshnessGateStatus: buildInventoryFreshnessStatus(assistantContext),
    currentEvidenceSummary,
    readOnlySteps,
    approvalSteps,
    expectedImpact: readText(risk.expectedImpact),
    rollbackNote: "",
    blockedNote: buildSharedBlockedNote("Health verification"),
    supportingEvidence: evidence.slice(0, 3),
    nextRecommendedAction: targetService
      ? {
          id: "open-service-actions",
          label: "Open Service Actions",
          serviceName: targetService.id,
        }
      : null,
  };
}

function buildRestartRequestPlan({
  assistantContext,
  restartApprovalContext,
  restartRiskProfile,
  auditEntries,
  selectedLookupItem,
}) {
  const targetService = buildTargetService(assistantContext);
  const serviceLabel = readText(targetService?.name, "selected service");
  const diagnosis = toObject(assistantContext?.diagnosis);
  const approval = toObject(assistantContext?.approval);
  const auditSnapshot = buildAuditSnapshot(auditEntries);
  const risk = formatRiskBadge(
    restartRiskProfile ||
      getActionRiskProfile("restart-service", {}, {
        host: assistantContext?.service?.host,
        manager: assistantContext?.service?.manager,
      }),
  );
  const supportingEvidence = [
    buildDiagnosisEvidence(assistantContext),
    buildLogSummaryEvidence(assistantContext),
    buildDependencyEvidence(assistantContext),
    buildAuditEvidence(auditSnapshot.latestEntry, assistantContext?.service?.host),
    buildLookupEvidence(selectedLookupItem),
  ].filter(Boolean);

  let currentEvidenceSummary =
    "No service is selected, so a restart request cannot be grounded in host ownership, approval policy, or service-specific evidence.";

  if (targetService) {
    const parts = [
      diagnosis.detected === true
        ? readText(diagnosis.primaryIssue, diagnosis.mostRelevantError, "Diagnosis indicates an issue.")
        : "No active diagnosis is detected from the current UI state.",
      readText(assistantContext?.rawLogSummary?.summary),
      auditSnapshot.latestEntry
        ? `Latest audit status: ${readText(auditSnapshot.latestEntry.status, "unknown")} ${formatActionTypeLabel(readText(auditSnapshot.latestEntry.actionType, "action"))}.`
        : "No recent audit entry is scoped to this service.",
      approval.gate?.message || approval.gate?.refreshGuidance || "",
    ].filter(Boolean);

    currentEvidenceSummary = parts.join(" ");
  }

  const readOnlySteps = targetService
    ? [
        `Review diagnosis, health, dependency, and capped log evidence for ${serviceLabel} before requesting a restart.`,
        auditSnapshot.latestEntry
          ? "Compare the latest audit history to the current symptoms so you do not repeat a failed action without new evidence."
          : "Review recent audit history if available before opening a new restart request.",
        "Prefer Refresh Inventory first when approval gating is stale, unknown, or blocked.",
      ]
    : [buildServiceSelectionStep()];

  const approvalSteps = [];

  if (targetService) {
    if (approval.gateStatus === "unsupported") {
      approvalSteps.push("Do not submit a restart request from chat because restart support is unavailable for this service.");
    } else {
      approvalSteps.push(
        "Open the existing Service Actions approval workflow and prepare the restart request there; chat cannot approve or execute it directly.",
      );

      if (readText(restartApprovalContext?.gate?.acknowledgementLabel, approval.gate?.acknowledgementLabel)) {
        approvalSteps.push(
          `Acknowledge the current freshness warning: ${readText(restartApprovalContext?.gate?.acknowledgementLabel, approval.gate?.acknowledgementLabel)}`,
        );
      }

      if (restartApprovalContext?.gate?.blockedUntilRefresh === true || approval.gateStatus === "blocked-until-refresh") {
        approvalSteps.push(
          readText(
            restartApprovalContext?.gate?.refreshGuidance,
            approval.gate?.refreshGuidance,
            "Refresh inventory before approval because the current context is stale or unknown.",
          ),
        );
      }
    }
  }

  return {
    id: `assistant-plan:prepare-restart-request:${targetService?.id || "none"}`,
    title: targetService ? `Prepare restart request for ${serviceLabel}` : "Prepare restart request",
    planType: "prepare restart request",
    targetService,
    hostOwnership: formatHostOwnership(assistantContext?.service?.host),
    risk,
    freshnessGateStatus: buildRestartFreshnessStatus(assistantContext, restartApprovalContext),
    currentEvidenceSummary: currentEvidenceSummary || "Restart evidence is currently unknown.",
    readOnlySteps,
    approvalSteps,
    expectedImpact: readText(risk.expectedImpact),
    rollbackNote: readText(risk.rollbackNote),
    blockedNote:
      "Chat cannot restart or approve anything directly. If restart is supported, prepare it through the existing Service Actions approval workflow.",
    supportingEvidence: supportingEvidence.slice(0, 5),
    nextRecommendedAction: targetService
      ? {
          id:
            restartApprovalContext?.gate?.blockedUntilRefresh === true || approval.gateStatus === "blocked-until-refresh"
              ? "refresh-inventory"
              : "open-service-actions",
          label:
            restartApprovalContext?.gate?.blockedUntilRefresh === true || approval.gateStatus === "blocked-until-refresh"
              ? "Refresh inventory first"
              : "Open Service Actions workflow",
          serviceName: targetService.id,
        }
      : null,
  };
}

function buildStaleInventoryPlan({
  assistantContext,
  restartApprovalContext,
}) {
  const targetService = buildTargetService(assistantContext);
  const risk = formatRiskBadge(getActionRiskProfile("view-status"));
  const staleSources = summarizeStaleSources(assistantContext);
  const approval = toObject(restartApprovalContext?.gate);
  const currentEvidenceSummary = [
    readText(assistantContext?.inventory?.freshness?.label, "Inventory freshness is unknown."),
    staleSources ? `Sources needing attention: ${staleSources}.` : "No stale source breakdown is available.",
    readText(approval.refreshGuidance, approval.message),
  ]
    .filter(Boolean)
    .join(" ");

  return {
    id: `assistant-plan:explain-stale-inventory:${targetService?.id || "none"}`,
    title: targetService ? `Explain stale inventory for ${targetService.name}` : "Explain stale inventory",
    planType: "explain stale inventory",
    targetService,
    hostOwnership: formatHostOwnership(assistantContext?.service?.host),
    risk,
    freshnessGateStatus: buildRestartFreshnessStatus(assistantContext, restartApprovalContext),
    currentEvidenceSummary,
    readOnlySteps: [
      targetService
        ? `Check which freshness sources are stale or unknown before trusting ${targetService.name} service status.`
        : buildServiceSelectionStep(),
      "Treat stale dependency or control-plane sources as an evidence warning, not as proof that the service is healthy or unhealthy.",
      "Refresh inventory before using stale or unknown context to justify an approval-gated change.",
    ],
    approvalSteps:
      readText(approval.refreshGuidance, approval.message) && targetService
        ? [readText(approval.refreshGuidance, approval.message)]
        : [],
    expectedImpact: readText(risk.expectedImpact),
    rollbackNote: "",
    blockedNote: "Chat cannot bypass freshness gates or mark stale inventory as approved context.",
    supportingEvidence: [buildDependencyEvidence(assistantContext)].filter(Boolean),
    nextRecommendedAction: {
      id: "refresh-inventory",
      label: "Refresh inventory first",
    },
  };
}

function buildRefreshInventoryPlan({ assistantContext }) {
  const targetService = buildTargetService(assistantContext);
  const risk = formatRiskBadge(getActionRiskProfile("refresh-inventory"));
  const staleSources = summarizeStaleSources(assistantContext);

  return {
    id: `assistant-plan:refresh-inventory:${targetService?.id || "none"}`,
    title: "Refresh inventory",
    planType: "refresh inventory",
    targetService,
    hostOwnership: formatHostOwnership(assistantContext?.service?.host),
    risk,
    freshnessGateStatus: buildInventoryFreshnessStatus(assistantContext),
    currentEvidenceSummary: staleSources
      ? `Inventory refresh is recommended because these sources are stale or unknown: ${staleSources}.`
      : "Use Refresh Inventory when service, dependency, or approval freshness is unknown.",
    readOnlySteps: [
      "Refresh inventory before relying on stale timestamps, dependency warnings, or approval gating.",
      "After refresh completes, re-check service status, dependency state, and any approval banner before planning a restart.",
      "If the same source remains stale after refresh, treat that gap as unresolved evidence rather than guessing.",
    ],
    approvalSteps: [],
    expectedImpact: readText(risk.expectedImpact),
    rollbackNote: "",
    blockedNote: "",
    supportingEvidence: [],
    nextRecommendedAction: {
      id: "refresh-inventory",
      label: "Refresh inventory",
    },
  };
}

function buildDependencyTracePlan({
  assistantContext,
  selectedLookupItem,
}) {
  const targetService = buildTargetService(assistantContext);
  const diagnosis = toObject(assistantContext?.diagnosis);
  const dependencySummary = toObject(assistantContext?.relationships?.dependencySummary);
  const focusDependency = pickFocusDependency(assistantContext);
  const dependencyLabel = readText(
    diagnosis.relatedServiceName,
    diagnosis.relatedServiceId,
    focusDependency?.displayName,
    focusDependency?.serviceId,
    "",
  );
  const relatedHost = readText(diagnosis.relatedServiceHost, focusDependency?.host, assistantContext?.service?.host, "unknown");
  const risk = formatRiskBadge(getActionRiskProfile("view-status"));
  const evidence = [
    buildDependencyEvidence(assistantContext),
    buildDiagnosisEvidence(assistantContext),
    buildLookupEvidence(selectedLookupItem),
  ].filter(Boolean);

  let currentEvidenceSummary =
    "No service is selected, so dependency tracing cannot confirm which host or service boundary owns the failure.";

  if (targetService) {
    if (dependencyLabel) {
      currentEvidenceSummary =
        `${targetService.name} depends on ${dependencyLabel}. ` +
        [
          readText(diagnosis.correlationReason),
          focusDependency?.endpoint ? `Endpoint: ${focusDependency.endpoint}.` : readText(diagnosis.relatedEndpoint) ? `Endpoint: ${diagnosis.relatedEndpoint}.` : "",
          dependencySummary.declaredCount
            ? `${pluralize(Number(dependencySummary.declaredCount || 0), "declared dependency", "declared dependencies")} with ${readText(dependencySummary.freshnessSummary, "unknown")} freshness.`
            : "No declared dependencies are mapped.",
        ]
          .filter(Boolean)
          .join(" ");
    } else {
      currentEvidenceSummary =
        `${targetService.name} has no grounded dependency target from the current diagnosis. ` +
        (dependencySummary.declaredCount ? "Declared dependencies exist, but none are clearly tied to the current issue." : "No declared dependencies are mapped.");
    }
  }

  const readOnlySteps = targetService
    ? [
        dependencyLabel
          ? `Trace the current issue from ${targetService.name} to ${dependencyLabel} before assuming the failure is local to one host.`
          : "Refresh or expand evidence before assigning the issue to a dependency-owned service.",
        focusDependency?.endpoint
          ? `Verify the mapped dependency endpoint ${focusDependency.endpoint} and keep Fedora/Windows ownership separate while investigating.`
          : "Compare the selected service to its declared dependency mapping and runtime ownership before acting.",
        "Use read-only logs, health output, and freshness checks on the related service before planning any restart request.",
      ]
    : [buildServiceSelectionStep()];

  const approvalSteps =
    targetService && assistantContext?.capabilities?.restart?.supported === true
      ? [
          "If the dependency path is healthy and the selected service still needs a restart, route that request through Service Actions instead of chat.",
        ]
      : [];

  return {
    id: `assistant-plan:trace-dependency-failure:${targetService?.id || "none"}`,
    title: targetService ? `Trace dependency failure for ${targetService.name}` : "Trace dependency failure",
    planType: "trace dependency failure",
    targetService,
    hostOwnership: formatHostOwnership(relatedHost),
    risk,
    freshnessGateStatus: buildInventoryFreshnessStatus(assistantContext),
    currentEvidenceSummary,
    readOnlySteps,
    approvalSteps,
    expectedImpact: readText(risk.expectedImpact),
    rollbackNote: "",
    blockedNote: "Do not assume direct cross-host filesystem access exists. Use the current safe Windows and Fedora operator surfaces only.",
    supportingEvidence: evidence.slice(0, 4),
    nextRecommendedAction:
      targetService && readText(diagnosis.relatedServiceId, focusDependency?.serviceId)
        ? {
            id: "query-logs",
            label: "Run safe log query",
            serviceName: readText(diagnosis.relatedServiceId, focusDependency?.serviceId),
          }
        : targetService
          ? {
              id: "refresh-inventory",
              label: "Refresh inventory first",
            }
          : null,
  };
}

function buildAuditSummaryPlan({
  assistantContext,
  auditEntries,
}) {
  const targetService = buildTargetService(assistantContext);
  const risk = formatRiskBadge(getActionRiskProfile("view-status"));
  const auditSnapshot = buildAuditSnapshot(auditEntries);
  const latestEntry = auditSnapshot.latestEntry;
  const currentEvidenceSummary = auditSnapshot.count
    ? [
        `${pluralize(auditSnapshot.count, "recent audit entry")} in scope.`,
        auditSnapshot.failedCount ? `${pluralize(auditSnapshot.failedCount, "failed action")}.` : "",
        auditSnapshot.pendingCount ? `${pluralize(auditSnapshot.pendingCount, "pending approval")}.` : "",
        latestEntry
          ? `Latest: ${formatActionTypeLabel(readText(latestEntry.actionType, "action"))} ${readText(latestEntry.status, "unknown")}.`
          : "",
      ]
        .filter(Boolean)
        .join(" ")
    : targetService
      ? `No recent audit history is currently visible for ${targetService.name}.`
      : "No service is selected, so audit history is not scoped to a grounded service target.";

  const evidence = auditSnapshot.items
    .map((entry) => buildAuditEvidence(entry, assistantContext?.service?.host))
    .filter(Boolean);

  const readOnlySteps = targetService
    ? [
        "Review the latest action status before creating a duplicate request for the same service.",
        auditSnapshot.failedCount
          ? "Use the last failed result as context for new read-only checks before asking for another change."
          : "Compare the latest audit timeline to the current symptoms before escalating.",
        "Keep audit review informational; it should guide operator judgment, not bypass approvals.",
      ]
    : [buildServiceSelectionStep()];

  const approvalSteps =
    auditSnapshot.pendingCount || auditSnapshot.approvedCount || auditSnapshot.executingCount
      ? [
          "If a pending, approved, or executing action already exists, continue through the existing workflow instead of creating a second request from chat.",
        ]
      : [];

  return {
    id: `assistant-plan:summarize-recent-audit-history:${targetService?.id || "none"}`,
    title: targetService ? `Summarize recent audit for ${targetService.name}` : "Summarize recent audit history",
    planType: "summarize recent audit history",
    targetService,
    hostOwnership: formatHostOwnership(assistantContext?.service?.host),
    risk,
    freshnessGateStatus: buildInventoryFreshnessStatus(assistantContext),
    currentEvidenceSummary,
    readOnlySteps,
    approvalSteps,
    expectedImpact: readText(risk.expectedImpact),
    rollbackNote: "",
    blockedNote: "Chat can summarize audit history, but it cannot approve, execute, or modify audit entries.",
    supportingEvidence: evidence,
    nextRecommendedAction: targetService
      ? {
          id: "open-service-actions",
          label: "Open Service Actions workflow",
          serviceName: targetService.id,
        }
      : null,
  };
}

function buildReportEvidencePlan({
  assistantContext,
  selectedLookupItem,
  lookupItems,
}) {
  const targetService = buildTargetService(assistantContext, readText(selectedLookupItem?.serviceName));
  const reportItem = pickLookupItem(
    [
      (kind, item) => kind === "report",
      (_kind, item) => Boolean(item?.reportId),
    ],
    selectedLookupItem,
    lookupItems,
  );
  const reportEvidence = buildLookupEvidence(reportItem);
  const risk = formatRiskBadge(getActionRiskProfile("view-status"));
  const currentEvidenceSummary = reportItem
    ? `Supporting report evidence is available for ${readText(reportItem.title, "the selected report")}. ${truncateText(readText(reportItem.snippet, reportItem.blockedReason, reportItem.sourceLabel))}`
    : targetService
      ? `No supporting report or runbook is currently selected for ${targetService.name}.`
      : "No supporting report or runbook is currently selected.";

  return {
    id: `assistant-plan:find-supporting-report-runbook:${targetService?.id || "none"}`,
    title: targetService ? `Find report evidence for ${targetService.name}` : "Find supporting report or runbook",
    planType: "find supporting report/runbook",
    targetService,
    hostOwnership: reportItem ? formatHostOwnership(reportItem.hostContext) : formatHostOwnership("docs"),
    risk,
    freshnessGateStatus: buildInventoryFreshnessStatus(assistantContext),
    currentEvidenceSummary,
    readOnlySteps: [
      "Use report lookup to find a named runbook, status document, or report that matches the selected service or dependency.",
      reportItem
        ? "Open the safe preview and confirm the document still matches the current host ownership and service scope."
        : "Preview only allowlisted report files; do not assume unregistered documents are available in chat.",
      "Treat documentation as supporting evidence, not as proof of current runtime state.",
    ],
    approvalSteps:
      targetService && assistantContext?.capabilities?.restart?.supported === true
        ? ["If the runbook recommends a restart, still route the actual request through Service Actions and approval gating."]
        : [],
    expectedImpact: readText(risk.expectedImpact),
    rollbackNote: "",
    blockedNote: "Chat only previews registered reports and allowlisted files. It does not expose unsupported document roots or live Fedora filesystems.",
    supportingEvidence: reportEvidence ? [reportEvidence] : [],
    nextRecommendedAction: reportItem
      ? {
          id: "open-report-preview",
          label: "Open safe report preview",
          item: reportItem,
        }
      : {
          id: "find-report",
          label: "Find supporting report",
          query: readText(targetService?.name, assistantContext?.diagnosis?.relatedServiceName, assistantContext?.service?.name),
        },
  };
}

function buildFileEvidencePlan({
  assistantContext,
  selectedLookupItem,
  lookupItems,
}) {
  const targetService = buildTargetService(assistantContext, readText(selectedLookupItem?.serviceName));
  const fileItem = pickLookupItem(
    [
      (kind) => kind === "file" || kind === "file-preview",
    ],
    selectedLookupItem,
    lookupItems,
  );
  const fileEvidence = buildLookupEvidence(fileItem);
  const risk = formatRiskBadge(getActionRiskProfile("view-status"));
  const currentEvidenceSummary = fileItem
    ? [
        `Safe file evidence is available for ${readText(fileItem.relativePath, fileItem.title, "the selected file")}.`,
        fileItem.blockedReason ? fileItem.blockedReason : "",
        fileItem.truncated === true ? "Preview is truncated by the safety cap." : "",
      ]
        .filter(Boolean)
        .join(" ")
    : targetService
      ? `No safe file evidence is currently selected for ${targetService.name}.`
      : "No safe file evidence is currently selected.";

  return {
    id: `assistant-plan:inspect-safe-file-evidence:${targetService?.id || "none"}`,
    title: targetService ? `Inspect file evidence for ${targetService.name}` : "Inspect safe file evidence",
    planType: "inspect safe file evidence",
    targetService,
    hostOwnership: fileItem ? formatHostOwnership(fileItem.hostContext) : formatHostOwnership("unknown"),
    risk,
    freshnessGateStatus: buildInventoryFreshnessStatus(assistantContext),
    currentEvidenceSummary,
    readOnlySteps: [
      "Use safe file lookup to inspect allowlisted repo or documentation paths only.",
      fileItem
        ? "Compare the selected file path, root, and host label to the current service context before treating it as operational evidence."
        : "Search for a file by service name, dependency name, or known report keyword before previewing it.",
      "Do not use blocked env files, secrets, raw private logs, or binaries as evidence.",
    ],
    approvalSteps:
      targetService && assistantContext?.capabilities?.restart?.supported === true
        ? ["If file evidence points toward a restart or config issue, use it as supporting context only and route any change through Service Actions."]
        : [],
    expectedImpact: readText(risk.expectedImpact),
    rollbackNote: "",
    blockedNote: "Env files, secrets, key material, dumps, binaries, and raw private logs remain blocked from chat preview.",
    supportingEvidence: fileEvidence ? [fileEvidence] : [],
    nextRecommendedAction: fileItem
      ? {
          id: "open-safe-file-preview",
          label: "Open safe file preview",
          item: fileItem,
        }
      : {
          id: "search-files",
          label: "Search safe files",
          query: readText(targetService?.name, assistantContext?.diagnosis?.relatedServiceName, assistantContext?.service?.name),
        },
  };
}

function buildPlanCard(planType, options) {
  if (planType === "diagnose-failed-service") {
    return buildDiagnosisPlan(options);
  }

  if (planType === "inspect-logs") {
    return buildLogInspectionPlan(options);
  }

  if (planType === "verify-health") {
    return buildHealthVerificationPlan(options);
  }

  if (planType === "refresh-inventory") {
    return buildRefreshInventoryPlan(options);
  }

  if (planType === "prepare-restart-request") {
    return buildRestartRequestPlan(options);
  }

  if (planType === "explain-stale-inventory") {
    return buildStaleInventoryPlan(options);
  }

  if (planType === "trace-dependency-failure") {
    return buildDependencyTracePlan(options);
  }

  if (planType === "summarize-recent-audit-history") {
    return buildAuditSummaryPlan(options);
  }

  if (planType === "find-supporting-report-runbook") {
    return buildReportEvidencePlan(options);
  }

  if (planType === "inspect-safe-file-evidence") {
    return buildFileEvidencePlan(options);
  }

  return null;
}

export function buildAssistantPlanCards({
  activePlanChipId = "",
  assistantContext = null,
  restartApprovalContext = null,
  restartRiskProfile = null,
  auditEntries = [],
  lookupItems = [],
  selectedLookupItem = null,
  healthOutput = null,
  healthMeta = null,
} = {}) {
  const planTypes = PLAN_GROUPS[cleanText(activePlanChipId)] || [];
  const context = toObject(assistantContext);
  const options = {
    assistantContext: context,
    restartApprovalContext: toObject(restartApprovalContext),
    restartRiskProfile,
    auditEntries,
    lookupItems: normalizeObjects(lookupItems),
    selectedLookupItem: isObject(selectedLookupItem) ? selectedLookupItem : null,
    healthOutput: isObject(healthOutput) ? healthOutput : healthOutput,
    healthMeta: toObject(healthMeta),
  };

  return planTypes
    .map((planType) => buildPlanCard(planType, options))
    .filter(Boolean)
    .map((card) => ({
      ...card,
      supportingEvidence: normalizeObjects(card.supportingEvidence),
      readOnlySteps: normalizeStrings(card.readOnlySteps),
      approvalSteps: normalizeStrings(card.approvalSteps),
      currentEvidenceSummary: truncateText(card.currentEvidenceSummary, 320),
    }));
}
