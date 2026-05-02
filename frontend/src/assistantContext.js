const ASSISTANT_CONTEXT_VERSION = 1;

const FEDORA_OWNERSHIP = Object.freeze([
  "Postgres",
  "durable storage",
  "Cloudflare ingress and tunnel routing",
  "nginx and front-door routing where applicable",
  "admin-proxy",
  "aibry-admin",
  "node-agent",
  "backups",
  "rollback artifacts",
  "systemd and Podman infrastructure",
]);

const WINDOWS_OWNERSHIP = Object.freeze([
  "PM2-managed app runtimes",
  "Garage Admin V2",
]);

export const ASSISTANT_QUICK_PROMPTS = Object.freeze([
  "Explain current diagnosis",
  "Show safest next step",
  "Summarize selected service",
  "Explain dependency path",
  "What logs should I check?",
  "Prepare restart plan",
  "What is stale or unknown?",
  "What host owns this service?",
]);

export const ASSISTANT_PROMPT_SCAFFOLD = Object.freeze({
  version: 1,
  groundingRules: [
    "Use the provided assistantContext as the primary source of truth.",
    "Do not invent service status, logs, paths, actions, or dependencies.",
    "If a field is missing, say that it is unknown or unavailable.",
    "Use raw log summary only. Do not assume unseen raw log content.",
  ],
  operatorRules: [
    "Prefer read-only diagnostics before suggesting state-changing actions.",
    "Explain Fedora vs Windows ownership clearly and keep their responsibilities separate.",
    "Recommend status, health, freshness, and log checks before restart planning.",
    "Do not suggest unsupported cross-host actions.",
    "Do not suggest exposing bridge internals publicly.",
    "Do not ask the operator to paste secrets, tokens, passwords, or API keys.",
    "For risky actions, route the operator through the existing approval and freshness-gated workflow.",
    "Preserve structured errors and explain them clearly.",
  ],
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

function lowerLabel(value, fallback = "Unknown") {
  const text = cleanText(value);

  if (!text) {
    return fallback;
  }

  return text.charAt(0).toUpperCase() + text.slice(1);
}

function buildServiceIndex(services) {
  const index = new Map();

  normalizeObjects(services).forEach((service) => {
    const name = readText(service?.name, service?.serviceName, service?.id);

    if (name) {
      index.set(name.toLowerCase(), service);
    }
  });

  return index;
}

function simplifyInventorySource(source) {
  return {
    key: readText(source?.key, source?.sourceKey),
    displayLabel: readText(source?.displayLabel, source?.key, source?.sourceKey),
    bucket: readText(source?.bucket, "unknown"),
    ageLabel: readText(source?.ageLabel),
    checkedAt: source?.checkedAt || null,
    status: readText(source?.status),
    ok: typeof source?.ok === "boolean" ? source.ok : null,
  };
}

function summarizeSourceBuckets(sourceBreakdown) {
  return normalizeObjects(sourceBreakdown).reduce(
    (counts, source) => {
      const bucket = readText(source?.bucket, "unknown");

      if (bucket in counts) {
        counts[bucket] += 1;
      }

      return counts;
    },
    {
      fresh: 0,
      aging: 0,
      stale: 0,
      unknown: 0,
    },
  );
}

function buildInventoryContext(inventoryFreshness, services) {
  const freshness = toObject(inventoryFreshness);
  const sourceBreakdown = normalizeObjects(freshness.sourceBreakdown).map(simplifyInventorySource);

  return {
    totalServices: normalizeObjects(services).length,
    freshness: {
      bucket: readText(freshness.bucket, "unknown"),
      label: readText(freshness.label, "Inventory freshness unknown"),
      ageLabel: readText(freshness.ageLabel),
      ageHint: readText(freshness.ageHint),
      timestamp: freshness.timestamp || null,
      timestampSource: readText(freshness.timestampSource),
      provenanceText: readText(freshness.provenanceText),
      hint: readText(freshness.hint),
      sourceHint: readText(freshness.sourceHint),
    },
    sourceBreakdown,
    sourceCounts: summarizeSourceBuckets(sourceBreakdown),
    staleOrUnknownSources: sourceBreakdown.filter(
      (source) => source.bucket === "stale" || source.bucket === "unknown",
    ),
  };
}

function buildProvidesContext(service) {
  return normalizeObjects(service?.provides).map((provide, index) => ({
    key: `${cleanText(provide?.kind) || "provide"}-${index}`,
    kind: readText(provide?.kind, "unknown"),
    endpoint: readText(provide?.endpoint),
    healthEndpoint: readText(provide?.healthEndpoint),
    readinessEndpoint: readText(provide?.readinessEndpoint),
    publicHost: readText(provide?.publicHost),
    paths: normalizeStrings(provide?.paths),
    notes: readText(provide?.notes),
  }));
}

function buildDependenciesContext(service, services, dependencyRollup) {
  const serviceIndex = buildServiceIndex(services);
  const rollupItems = new Map(
    normalizeObjects(dependencyRollup?.items).map((item) => [cleanText(item?.serviceId).toLowerCase(), item]),
  );

  return normalizeObjects(service?.dependencies)
    .map((dependency, index) => {
      const serviceId = readText(dependency?.serviceId);
      const targetService = serviceId ? serviceIndex.get(serviceId.toLowerCase()) || null : null;
      const rollupItem = serviceId ? rollupItems.get(serviceId.toLowerCase()) || null : null;
      const endpoint = readText(dependency?.endpoint, rollupItem?.endpoint);

      if (!serviceId && !endpoint) {
        return null;
      }

      return {
        key: `${serviceId || endpoint || "dependency"}-${index}`,
        serviceId,
        displayName: readText(targetService?.displayName, targetService?.name, serviceId),
        host: readText(targetService?.host, "unknown"),
        manager: readText(targetService?.manager, targetService?.inventory?.manager, targetService?.runtime?.manager),
        endpoint,
        reason: readText(dependency?.reason, dependency?.relationship),
        confidence: readText(dependency?.confidence),
        source: readText(dependency?.source),
        status: readText(rollupItem?.status, "unknown"),
        statusBucket: readText(rollupItem?.statusBucket, "unknown"),
        freshness: readText(rollupItem?.freshness, "unknown"),
        freshnessLabel: readText(rollupItem?.freshnessLabel),
        freshnessTimestamp: rollupItem?.freshnessTimestamp || null,
        diagnosisRelated: rollupItem?.diagnosisRelated === true,
        diagnosisLabel: readText(rollupItem?.diagnosisLabel),
        diagnosisFreshnessLabel: readText(rollupItem?.diagnosisFreshnessLabel),
      };
    })
    .filter(Boolean);
}

function buildDependencySummary(dependencyRollup) {
  const rollup = toObject(dependencyRollup);
  const counts = toObject(rollup.counts);
  const attentionCount =
    Number(counts.warning || 0) + Number(counts.failed || 0) + Number(counts.unknown || 0);

  return {
    declaredCount: Number(rollup.declaredCount || 0),
    attentionCount,
    healthyCount: Number(counts.healthy || 0),
    warningCount: Number(counts.warning || 0),
    failedCount: Number(counts.failed || 0),
    unknownCount: Number(counts.unknown || 0),
    freshnessSummary: readText(rollup.freshnessSummary, "unknown"),
  };
}

function buildDiagnosisContext(diagnosis) {
  const issue = toObject(diagnosis);

  return {
    detected: issue.detected === true,
    primaryIssue: readText(issue.primaryIssue),
    likelyCause: readText(issue.likelyCause),
    mostRelevantError: readText(issue.mostRelevantError),
    errorType: readText(issue.errorType),
    severity: readText(issue.severity, "info"),
    riskLevel: readText(issue.riskLevel, "unknown"),
    confidence: readText(issue.confidence, "unknown"),
    source: readText(issue.source, "none"),
    suggestedNextStep: readText(issue.suggestedNextStep),
    suggestedActions: normalizeStrings(issue.suggestedActions).slice(0, 4),
    timestamp: issue.timestamp || null,
    affectedService: readText(issue.affectedService),
    relatedServiceId: readText(issue.relatedServiceId),
    relatedServiceName: readText(issue.relatedServiceName),
    relatedServiceHost: readText(issue.relatedServiceHost, "unknown"),
    relatedServiceManager: readText(issue.relatedServiceManager),
    relatedEndpoint: readText(issue.relatedEndpoint),
    correlationReason: readText(issue.correlationReason),
    correlationConfidence: readText(issue.correlationConfidence),
  };
}

function buildLogEventsContext(events) {
  const items = normalizeObjects(events).slice(0, 4).map((event, index) => ({
    key: cleanText(event?.id) || `log-event-${index}`,
    severity: readText(event?.severity, "unknown"),
    confidence: readText(event?.confidence, "unknown"),
    errorType: readText(event?.errorType),
    detectedError: readText(event?.detectedError, event?.primaryIssue),
    mostRelevantError: readText(event?.mostRelevantError),
    affectedService: readText(event?.affectedService),
    relatedServiceId: readText(event?.relatedServiceId),
    relatedServiceHost: readText(event?.relatedServiceHost, "unknown"),
    relatedEndpoint: readText(event?.relatedEndpoint),
    correlationReason: readText(event?.correlationReason),
    correlationConfidence: readText(event?.correlationConfidence),
    timestamp: event?.timestamp || null,
  }));

  return {
    count: normalizeObjects(events).length,
    items,
  };
}

function buildLogSummary(logSummary) {
  const summary = toObject(logSummary);

  return {
    hasLogs: summary.hasLogs === true,
    fetchedAt: summary.logsFetchedAt || null,
    lineCount: Number(summary.lineCount || 0),
    visibleLineCount: Number(summary.visibleLineCount || 0),
    filtered: summary.filtered === true,
    alertOnly: summary.alertOnly === true,
    alertCount: Number(summary.alertCount || 0),
    criticalCount: Number(summary.criticalCount || 0),
    errorCount: Number(summary.errorCount || 0),
    warningCount: Number(summary.warningCount || 0),
    summary: readText(summary.summary, "No log alerts in current output."),
  };
}

function buildCapabilityContext(capabilities) {
  const items = toObject(capabilities);
  const simplify = (capability) => ({
    supported: capability?.supported === true,
    executor: readText(capability?.executor),
    mode: readText(capability?.mode),
    reason: readText(capability?.reason),
    setupHint: readText(capability?.setupHint),
  });

  return {
    logs: simplify(items.logs),
    health: simplify(items.health),
    restart: simplify(items.restart),
  };
}

function buildApprovalContext(approvalContext, restartRiskProfile) {
  const approval = toObject(approvalContext);
  const gate = toObject(approval.gate);
  const riskProfile = toObject(restartRiskProfile);
  let gateStatus = "available";

  if (approval.unsupported === true || gate.policy === "unsupported") {
    gateStatus = "unsupported";
  } else if (gate.blockedUntilRefresh === true) {
    gateStatus = "blocked-until-refresh";
  } else if (gate.requiresAcknowledgement === true) {
    gateStatus = "acknowledgement-required";
  }

  return {
    supported: gateStatus !== "unsupported",
    gateStatus,
    riskLevel: readText(riskProfile.riskLevel, "unknown"),
    riskLabel: readText(riskProfile.label, "Unknown"),
    riskDetail: readText(riskProfile.detail),
    requiresApproval: riskProfile.requiresApproval === true,
    dependencyWarnings: normalizeStrings(approval.dependencyWarnings),
    gate: {
      policy: readText(gate.policy, "existing-approval"),
      message: readText(gate.message),
      acknowledgementLabel: readText(gate.acknowledgementLabel),
      refreshGuidance: readText(gate.refreshGuidance),
      requiresAcknowledgement: gate.requiresAcknowledgement === true,
      blockedUntilRefresh: gate.blockedUntilRefresh === true,
    },
  };
}

function buildLatestActionContext(latestAction) {
  const action = toObject(latestAction);
  const summary = readText(action.summary);
  const actionType = readText(action.type);
  const status = readText(action.status);

  if (!summary && !actionType && !status) {
    return null;
  }

  return {
    type: actionType,
    status,
    summary,
    createdAt: action.createdAt || null,
    riskLabel: readText(action.riskLabel),
    riskLevel: readText(action.riskLevel),
    verificationSummary: readText(action.verificationSummary),
  };
}

function buildIncidentContext(selectedIncident) {
  const incident = toObject(selectedIncident);
  const title = readText(incident.title);

  if (!title) {
    return null;
  }

  return {
    id: readText(incident.id),
    title,
    status: readText(incident.status),
    severity: readText(incident.severity),
    serviceName: readText(incident.serviceName),
  };
}

function buildOwnershipContext(host) {
  const normalizedHost = readText(host, "unknown").toLowerCase();
  let currentHostLabel = "Unknown owner";
  let currentHostSummary =
    "Host ownership is unknown. Treat host-specific actions as unsupported until service ownership is confirmed.";

  if (normalizedHost === "fedora") {
    currentHostLabel = "Fedora control plane";
    currentHostSummary =
      "Fedora owns the infrastructure and control-plane layer for this service. Keep diagnostics and action planning aligned with Fedora responsibilities.";
  } else if (normalizedHost === "windows") {
    currentHostLabel = "Windows runtime";
    currentHostSummary =
      "Windows owns the app runtime and operator surface for this service. PM2-managed runtime actions stay on Windows while control-plane dependencies remain on Fedora.";
  }

  return {
    host: normalizedHost || "unknown",
    currentHostLabel,
    currentHostSummary,
    fedoraOwns: [...FEDORA_OWNERSHIP],
    windowsOwns: [...WINDOWS_OWNERSHIP],
  };
}

function buildPanelFacts(context) {
  const facts = [];

  if (context.service.name) {
    facts.push({
      key: "owner",
      label: "Owner",
      value: context.ownership.currentHostLabel,
      tone: context.service.host,
    });
  }

  facts.push({
    key: "freshness",
    label: "Inventory",
    value: context.inventory.freshness.label,
    tone: context.inventory.freshness.bucket,
  });

  if (context.relationships.dependencySummary.declaredCount) {
    facts.push({
      key: "dependencies",
      label: "Dependencies",
      value: context.relationships.dependencySummary.attentionCount
        ? `${pluralize(context.relationships.dependencySummary.attentionCount, "warning")}`
        : `${pluralize(context.relationships.dependencySummary.declaredCount, "declared dependency", "declared dependencies")}`,
      tone: context.relationships.dependencySummary.attentionCount ? "warning" : "neutral",
    });
  }

  if (context.diagnosis.detected) {
    facts.push({
      key: "diagnosis",
      label: "Diagnosis",
      value: lowerLabel(context.diagnosis.severity),
      tone: context.diagnosis.severity,
    });
  }

  if (context.latestAction?.status) {
    facts.push({
      key: "action",
      label: "Latest action",
      value: context.latestAction.status,
      tone: context.latestAction.status,
    });
  }

  return facts.slice(0, 5);
}

function buildInventoryMessage(context) {
  const sources = context.inventory.staleOrUnknownSources;

  if (sources.length === 1) {
    const source = sources[0];
    return source.bucket === "unknown"
      ? `${source.displayLabel} inventory timestamp is unknown.`
      : `${source.displayLabel} inventory is stale.`;
  }

  if (sources.length > 1) {
    return `${pluralize(sources.length, "inventory source")} ${sources.length === 1 ? "is" : "are"} stale or unknown.`;
  }

  if (context.inventory.freshness.bucket === "aging") {
    return "Inventory context is aging.";
  }

  if (context.inventory.freshness.bucket === "fresh") {
    return "Inventory context is fresh.";
  }

  return "Inventory freshness is unknown.";
}

function buildDependencyMessage(context) {
  const dependencySummary = context.relationships.dependencySummary;

  if (!dependencySummary.declaredCount) {
    return "No declared dependencies are mapped for this service.";
  }

  if (dependencySummary.attentionCount) {
    return `I see ${pluralize(
      dependencySummary.attentionCount,
      "dependency warning",
    )} and ${pluralize(dependencySummary.declaredCount, "declared dependency", "declared dependencies")}.`;
  }

  return `${pluralize(dependencySummary.declaredCount, "declared dependency")} mapped with ${dependencySummary.freshnessSummary} status freshness.`;
}

function buildDiagnosisMessage(context) {
  const diagnosis = context.diagnosis;

  if (!diagnosis.detected) {
    return "No active diagnosis is detected from the current UI state.";
  }

  const relatedService = readText(diagnosis.relatedServiceName, diagnosis.relatedServiceId);

  if (relatedService) {
    return `Latest diagnosis: ${diagnosis.primaryIssue || diagnosis.mostRelevantError || "issue detected"}. Related service: ${relatedService}.`;
  }

  return `Latest diagnosis: ${diagnosis.primaryIssue || diagnosis.mostRelevantError || "issue detected"}.`;
}

function buildPromptMessage(context) {
  const prompts = [
    "explain the failure",
    "show the safest next step",
    "inspect dependencies",
    "review log checks",
  ];

  if (context.capabilities.restart.supported) {
    prompts.push("prepare an approval-routed restart plan");
  }

  return `You can ask me to ${prompts.join(", ")}.`;
}

function buildOpeningMessage(context) {
  if (!context.service.name) {
    return "Select a service to ground the assistant in service status, diagnosis, dependencies, freshness, and approval state.";
  }

  const serviceLabel = context.service.displayName || context.service.name;
  const parts = [
    `${serviceLabel} is selected.`,
    buildInventoryMessage(context),
    buildDependencyMessage(context),
    buildDiagnosisMessage(context),
    buildPromptMessage(context),
  ];

  return parts.filter(Boolean).join(" ");
}

export function buildAssistantContext({
  selectedService = "",
  selectedServiceRecord = null,
  services = [],
  diagnosis = null,
  diagnosisLogEvents = [],
  logSummary = null,
  inventoryFreshness = null,
  dependencyRollup = null,
  approvalContext = null,
  restartRiskProfile = null,
  latestAction = null,
  capabilities = null,
  selectedIncident = null,
} = {}) {
  const serviceRecord = toObject(selectedServiceRecord);
  const serviceName = readText(selectedService, serviceRecord.name);
  const serviceDisplayName = readText(serviceRecord.displayName, serviceName);
  const serviceHost = readText(serviceRecord.host, "unknown").toLowerCase();
  const ownership = buildOwnershipContext(serviceHost);
  const context = {
    version: ASSISTANT_CONTEXT_VERSION,
    generatedAt: new Date().toISOString(),
    selectedService: serviceName || null,
    service: {
      name: serviceName,
      displayName: serviceDisplayName,
      host: serviceHost || "unknown",
      manager: readText(serviceRecord.manager, serviceRecord.inventory?.manager, serviceRecord.runtime?.manager),
      processName: readText(serviceRecord.processName, serviceRecord.runtime?.processName, serviceRecord.inventory?.processName),
      type: readText(serviceRecord.classification?.type, serviceRecord.serviceTypeLabel),
      severity: readText(serviceRecord.classification?.severity, "unknown"),
      status: readText(serviceRecord.status, "unknown"),
      runtimeSummary: readText(serviceRecord.runtimeSummary),
      localPort:
        Number.isFinite(Number(serviceRecord.inventory?.localPort)) ? Number(serviceRecord.inventory.localPort) : null,
      localUrl: readText(serviceRecord.inventory?.localUrl, serviceRecord.health?.localUrl),
      localHealthUrl: readText(serviceRecord.inventory?.localHealthUrl, serviceRecord.health?.url),
      localReadinessUrl: readText(serviceRecord.inventory?.localReadinessUrl, serviceRecord.health?.readinessUrl),
      publicUrl: readText(serviceRecord.inventory?.publicUrl, serviceRecord.health?.publicUrl),
      notes: normalizeStrings(
        Array.isArray(serviceRecord.inventory?.notes) ? serviceRecord.inventory.notes : [serviceRecord.inventory?.notes],
      ).slice(0, 3),
    },
    ownership,
    inventory: buildInventoryContext(inventoryFreshness, services),
    relationships: {
      provides: buildProvidesContext(serviceRecord),
      dependencies: buildDependenciesContext(serviceRecord, services, dependencyRollup),
      dependencySummary: buildDependencySummary(dependencyRollup),
    },
    diagnosis: buildDiagnosisContext(diagnosis),
    extractedLogEvents: buildLogEventsContext(diagnosisLogEvents),
    rawLogSummary: buildLogSummary(logSummary),
    capabilities: buildCapabilityContext(capabilities),
    approval: buildApprovalContext(approvalContext, restartRiskProfile),
    latestAction: buildLatestActionContext(latestAction),
    incident: buildIncidentContext(selectedIncident),
    quickPrompts: [...ASSISTANT_QUICK_PROMPTS],
  };

  context.openingMessage = buildOpeningMessage(context);
  context.panelFacts = buildPanelFacts(context);

  return context;
}

export function buildAssistantRequestPayload({ message = "", context = null } = {}) {
  return {
    message: cleanText(message),
    serviceName: cleanText(context?.service?.name) || null,
    incident: context?.incident || null,
    assistantContext: context,
    promptScaffold: ASSISTANT_PROMPT_SCAFFOLD,
  };
}
