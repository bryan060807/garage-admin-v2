const express = require("express");
const assistantLookup = require("../lib/assistantLookup");

const router = express.Router();

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

function asyncRoute(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (error) {
      next(error);
    }
  };
}

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

function pushSuggestion(suggestions, value) {
  const suggestion = cleanText(value);

  if (!suggestion || suggestions.includes(suggestion)) {
    return;
  }

  suggestions.push(suggestion);
}

function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function truncateLogs(logs) {
  const lines = String(logs || "")
    .split("\n")
    .filter(Boolean);

  return lines.slice(-80);
}

function summarizeAudit(entries) {
  return entries
    .slice(0, 5)
    .map((entry) => `${entry.actionType} ${entry.status} ${entry.target}`)
    .join("; ");
}

function buildLegacySuggestions({ serviceName, logText, recentAudit, diagnosis }) {
  const normalizedLogs = String(logText || "").toLowerCase();
  const repeatedFailures = recentAudit.filter((entry) => entry.status === "failed").length >= 2;
  const suggestions = [];
  let proposedAction;
  const diagnosisSummary = [diagnosis?.primaryIssue, diagnosis?.likelyCause].filter(Boolean).join(" ").toLowerCase();
  const restartShouldWait = /(syntax|module|unauthorized|forbidden|route not found|unsupported action|address already in use)/.test(
    diagnosisSummary,
  );

  if (Array.isArray(diagnosis?.suggestedActions)) {
    diagnosis.suggestedActions.slice(0, 3).forEach((suggestion) => pushSuggestion(suggestions, suggestion));
  }

  if (repeatedFailures) {
    pushSuggestion(suggestions, "Repeated failures detected. Investigate logs before attempting a restart.");
  }

  if (
    serviceName &&
    !restartShouldWait &&
    (normalizedLogs.includes("error") ||
      normalizedLogs.includes("crash") ||
      normalizedLogs.includes("failed"))
  ) {
    pushSuggestion(suggestions, `Consider a controlled restart for ${serviceName} if the failure is persistent.`);
    proposedAction = {
      type: "restart-service",
      serviceName,
      reason: "Logs contain recent error or failure signals that may warrant a restart.",
    };
  }

  if (!suggestions.length) {
    pushSuggestion(suggestions, "Check recent logs for anomalies.");
    pushSuggestion(suggestions, "Verify service health before taking action.");
  } else if (!repeatedFailures) {
    pushSuggestion(suggestions, "Review current logs and health before approving any action.");
  }

  return {
    suggestions,
    proposedAction,
  };
}

function buildLegacyResponse({ message, serviceName, incident, logs, recentAudit, diagnosis }) {
  const logLines = truncateLogs(logs);
  const auditEntries = Array.isArray(recentAudit) ? recentAudit.slice(0, 5) : [];
  const incidentSummary = incident?.title
    ? `${incident.title} (${incident.status || "unknown"}${incident.severity ? `, ${incident.severity}` : ""})`
    : "None";
  const diagnosisSummary = diagnosis?.primaryIssue
    ? `${diagnosis.primaryIssue}${diagnosis.likelyCause ? ` (${diagnosis.likelyCause})` : ""}`
    : "None";
  const summaryParts = [
    `Service: ${serviceName || "None selected"}`,
    `Incident: ${incidentSummary}`,
    `Diagnosis: ${diagnosisSummary}`,
    `Next step: ${diagnosis?.suggestedNextStep || "None"}`,
    `Logs reviewed: ${logLines.length} lines`,
    `Recent audit: ${auditEntries.length ? summarizeAudit(auditEntries) : "None"}`,
    `Operator request: ${cleanText(message)}`,
  ];
  const { suggestions, proposedAction } = buildLegacySuggestions({
    serviceName,
    logText: logLines.join("\n"),
    recentAudit: auditEntries,
    diagnosis,
  });

  return {
    summary: summaryParts.join(" | "),
    suggestions,
    proposedAction: proposedAction || null,
  };
}

function detectIntent(message) {
  const text = cleanText(message).toLowerCase();

  if (!text) {
    return "default";
  }

  if ((text.includes("safe") || text.includes("safest")) && text.includes("next")) {
    return "safe-next-step";
  }

  if (text.includes("restart")) {
    return "restart-plan";
  }

  if (text.includes("dependency")) {
    return "dependency-path";
  }

  if (text.includes("log")) {
    return "logs";
  }

  if (text.includes("stale") || text.includes("unknown") || text.includes("freshness")) {
    return "stale";
  }

  if (
    text.includes("host") ||
    text.includes("owns") ||
    text.includes("ownership") ||
    text.includes("fedora") ||
    text.includes("windows")
  ) {
    return "host-ownership";
  }

  if (text.includes("summarize") || text.includes("summary")) {
    return "summarize-service";
  }

  if (text.includes("diagnosis") || text.includes("failure") || text.includes("error") || text.includes("explain")) {
    return "diagnosis";
  }

  return "default";
}

function normalizeLookupRequest(value) {
  if (!isObject(value)) {
    return null;
  }

  const type = cleanText(value.type).toLowerCase();

  if (!type) {
    return null;
  }

  return {
    type,
    query: cleanText(value.query),
    path: cleanText(value.path),
    reportId: cleanText(value.reportId),
    service: cleanText(value.service),
    filter: cleanText(value.filter),
    searchContent: value.searchContent === true,
    maxBytes: value.maxBytes,
    lines: value.lines,
    limit: value.limit,
    rootLabels: Array.isArray(value.rootLabels)
      ? value.rootLabels.map((entry) => cleanText(entry)).filter(Boolean)
      : [],
  };
}

function extractLookupMessageArgument(message, prefix) {
  const text = cleanText(message);
  const normalizedPrefix = cleanText(prefix).toLowerCase();

  if (!text.toLowerCase().startsWith(normalizedPrefix)) {
    return "";
  }

  return cleanText(text.slice(normalizedPrefix.length).replace(/^[:\s-]+/, ""));
}

function inferLookupRequestFromMessage(message, assistantContext) {
  const context = toObject(assistantContext);
  const serviceName = getServiceName(context);
  const normalizedMessage = cleanText(message).toLowerCase();

  if (normalizedMessage.startsWith("find report")) {
    return {
      type: "reports",
      query: extractLookupMessageArgument(message, "find report"),
    };
  }

  if (normalizedMessage.startsWith("search files")) {
    return {
      type: "search-files",
      query: extractLookupMessageArgument(message, "search files") || serviceName,
      searchContent: true,
      limit: 12,
    };
  }

  if (normalizedMessage.startsWith("open safe file preview")) {
    return {
      type: "read-file",
      path: extractLookupMessageArgument(message, "open safe file preview"),
      maxBytes: 12 * 1024,
    };
  }

  if (normalizedMessage.startsWith("query logs")) {
    return {
      type: "logs-query",
      service: serviceName,
      filter: extractLookupMessageArgument(message, "query logs"),
      lines: 40,
    };
  }

  if (normalizedMessage.startsWith("explain this report")) {
    return {
      type: "explain-report",
      query: extractLookupMessageArgument(message, "explain this report"),
    };
  }

  return null;
}

function buildLookupPayload(type, result, extra = {}) {
  return {
    type,
    count: Number(result?.count || 0),
    query: cleanText(result?.query || extra.query),
    filter: cleanText(result?.filter || extra.filter),
    blocked: result?.blocked === true,
    resultCapReached: result?.resultCapReached === true,
    scanCapReached: result?.scanCapReached === true,
    allowlistedRoots: Array.isArray(result?.allowlistedRoots) ? result.allowlistedRoots : [],
    items: normalizeObjects(result?.items),
  };
}

function buildLookupFailureResponse(type, result, extra = {}) {
  const suggestions = [];

  if (type === "read-file") {
    pushSuggestion(suggestions, "Use a report or file result from the allowlisted lookup cards instead of guessing a path.");
  }

  if (type === "logs-query") {
    pushSuggestion(suggestions, "For Fedora services, keep log review on the existing safe bridge/admin path rather than direct filesystem access.");
  }

  if (!suggestions.length) {
    pushSuggestion(suggestions, "Stay inside the allowlisted Windows repo/docs roots and the existing safe Fedora APIs.");
  }

  return {
    summary: result?.error || "The assistant lookup request failed.",
    suggestions,
    proposedAction: null,
    lookup: buildLookupPayload(type, result, extra),
  };
}

function buildLookupOriginSentence(item) {
  const hostContext = cleanText(item?.hostContext).toLowerCase();

  if (hostContext === "fedora") {
    return "For Fedora service logs, use the existing admin/node-agent log path rather than direct filesystem access.";
  }

  if (hostContext === "cross-host" || hostContext === "docs") {
    return "This is cross-host documentation, not direct Fedora filesystem access.";
  }

  return "This appears to be a Windows project file, not a Fedora control-plane file.";
}

function buildLookupSelectionSummary(item) {
  const title = readText(item?.title, item?.relativePath, item?.serviceName, "selected item");

  return `${title}. ${buildLookupOriginSentence(item)}`;
}

async function buildLookupResponse(message, assistantContext, lookupRequest) {
  const normalizedRequest =
    normalizeLookupRequest(lookupRequest) || inferLookupRequestFromMessage(message, assistantContext);

  if (!normalizedRequest) {
    return null;
  }

  if (normalizedRequest.type === "reports") {
    const result = await assistantLookup.listReports({
      query: normalizedRequest.query,
    });

    if (!result.ok) {
      return buildLookupFailureResponse("reports", result, {
        query: normalizedRequest.query,
      });
    }

    const items = normalizeObjects(result.items);
    const suggestions = [];
    let summary = "No assistant reports are currently registered.";

    if (items.length === 1) {
      summary = `I found the ${items[0].title}.`;
    } else if (items.length > 1) {
      summary = `I found ${items.length} matching reports; here are the safest matches from the registry.`;
    } else if (normalizedRequest.query) {
      summary = `I did not find a registered report matching "${normalizedRequest.query}".`;
    }

    if (items.length) {
      pushSuggestion(suggestions, "Open a safe preview for a selected report.");
      pushSuggestion(suggestions, "Explain a selected report to connect it back to the current operator context.");
    } else {
      pushSuggestion(suggestions, "Try a broader report name such as Garage Admin, control-plane, TrackMaster, or ChordMaster.");
    }

    return {
      summary,
      suggestions,
      proposedAction: null,
      lookup: buildLookupPayload("reports", result, {
        query: normalizedRequest.query,
      }),
    };
  }

  if (normalizedRequest.type === "search-files") {
    const result = await assistantLookup.searchFiles({
      query: normalizedRequest.query,
      rootLabels: normalizedRequest.rootLabels,
      searchContent: normalizedRequest.searchContent,
      limit: normalizedRequest.limit,
    });

    if (!result.ok) {
      return buildLookupFailureResponse("search-files", result, {
        query: normalizedRequest.query,
      });
    }

    const suggestions = [];
    let summary;

    if (Number(result.count || 0) === 0) {
      summary = `I did not find matching files for "${normalizedRequest.query}" inside the allowlisted roots.`;
      pushSuggestion(suggestions, "Try a broader filename or keyword.");
      pushSuggestion(suggestions, "Use report lookup if you are looking for a named runbook or status document.");
    } else {
      const capNote =
        result.resultCapReached || result.scanCapReached
          ? " Result caps were applied to keep the scan bounded."
          : "";
      summary = `I found ${result.count} matching files; here are previews.${capNote}`;
      pushSuggestion(suggestions, "Open a safe preview for a specific file match.");
      pushSuggestion(suggestions, "If a result belongs to another Windows repo, treat it as local documentation rather than Fedora filesystem access.");
    }

    return {
      summary,
      suggestions,
      proposedAction: null,
      lookup: buildLookupPayload("search-files", result, {
        query: normalizedRequest.query,
      }),
    };
  }

  if (normalizedRequest.type === "read-file") {
    const result = await assistantLookup.readFilePreview({
      path: normalizedRequest.path,
      reportId: normalizedRequest.reportId,
      maxBytes: normalizedRequest.maxBytes,
    });

    if (!result.ok) {
      return buildLookupFailureResponse("read-file", result);
    }

    const item = normalizeObjects(result.items)[0] || null;
    const suggestions = [];
    let summary = "I opened a safe file preview.";

    if (item) {
      summary = `I opened a safe preview for ${buildLookupSelectionSummary(item)}${item.truncated ? " The preview is truncated." : ""}`;
    }

    pushSuggestion(suggestions, "Search nearby files if you need a narrower source.");

    if (item?.reportId) {
      pushSuggestion(suggestions, "Explain this report if you want a grounded summary before acting.");
    }

    return {
      summary,
      suggestions,
      proposedAction: null,
      lookup: buildLookupPayload("read-file", result),
    };
  }

  if (normalizedRequest.type === "logs-query") {
    const context = toObject(assistantContext);
    const serviceName = readText(normalizedRequest.service, getServiceName(context));

    if (!serviceName) {
      return {
        summary: "Select a service first so log lookup can stay grounded in the current host-aware context.",
        suggestions: ["Select a service, then query logs through the safe Windows PM2 or Fedora bridge path."],
        proposedAction: null,
        lookup: {
          type: "logs-query",
          count: 0,
          query: "",
          filter: cleanText(normalizedRequest.filter),
          blocked: true,
          resultCapReached: false,
          scanCapReached: false,
          allowlistedRoots: [],
          items: [],
        },
      };
    }

    const result = await assistantLookup.queryLogs({
      service: serviceName,
      lines: normalizedRequest.lines,
      filter: normalizedRequest.filter,
    });

    if (!result.ok) {
      return buildLookupFailureResponse("logs-query", result, {
        filter: normalizedRequest.filter,
      });
    }

    const item = normalizeObjects(result.items)[0] || null;
    const suggestions = [];
    let summary = `I fetched a capped read-only log preview for ${serviceName}.`;

    if (item?.hostContext === "fedora") {
      summary =
        `I fetched a capped read-only log preview for ${serviceName}. ` +
        "For Fedora service logs, use the existing admin/node-agent log path rather than direct filesystem access.";
    } else if (item?.hostContext === "windows") {
      summary = `I fetched a capped read-only Windows PM2 log preview for ${serviceName}.`;
    }

    if (cleanText(normalizedRequest.filter)) {
      summary += ` Filter: ${cleanText(normalizedRequest.filter)}.`;
    }

    if (item?.truncated) {
      summary += " The line cap was applied.";
    }

    pushSuggestion(suggestions, "Compare this output to the diagnosis card and the raw log summary before planning any restart.");
    pushSuggestion(suggestions, "Keep log review read-only and host-aware.");

    return {
      summary,
      suggestions,
      proposedAction: null,
      lookup: buildLookupPayload("logs-query", result, {
        filter: normalizedRequest.filter,
      }),
    };
  }

  if (normalizedRequest.type === "explain-report") {
    let reportResult = null;

    if (normalizedRequest.reportId) {
      reportResult = await assistantLookup.getReportDetail(normalizedRequest.reportId);
    } else {
      reportResult = await assistantLookup.listReports({
        query: normalizedRequest.query,
      });
    }

    if (!reportResult.ok) {
      return buildLookupFailureResponse("explain-report", reportResult, {
        query: normalizedRequest.query,
      });
    }

    const reportItems = reportResult.item ? [reportResult.item] : normalizeObjects(reportResult.items);
    const reportItem = reportItems[0] || null;

    if (!reportItem) {
      return {
        summary: `I did not find a report to explain${normalizedRequest.query ? ` for "${normalizedRequest.query}"` : ""}.`,
        suggestions: ["Find report first, then explain a specific runbook or status document."],
        proposedAction: null,
        lookup: buildLookupPayload("explain-report", {
          count: 0,
          items: [],
          query: normalizedRequest.query,
          allowlistedRoots: reportResult.allowlistedRoots,
        }),
      };
    }

    const previewResult = reportItem.reportId
      ? await assistantLookup.readFilePreview({
          reportId: reportItem.reportId,
          maxBytes: 8 * 1024,
        })
      : null;
    const lookupPayload =
      previewResult && previewResult.ok
        ? buildLookupPayload("explain-report", previewResult)
        : buildLookupPayload("explain-report", {
            count: 1,
            items: [reportItem],
            allowlistedRoots: reportResult.allowlistedRoots,
          });
    const suggestions = [];
    let summary = `I found the ${reportItem.title}. ${reportItem.snippet || ""}`.trim();

    summary = `${summary} ${buildLookupOriginSentence(reportItem)}`.trim();

    if (previewResult && !previewResult.ok) {
      summary += ` ${previewResult.error}`;
    }

    pushSuggestion(suggestions, "Use the safe preview card to inspect the document without leaving the chat panel.");
    pushSuggestion(suggestions, "Treat cross-host docs as documentation of Fedora/Windows ownership, not live Fedora filesystem access.");

    return {
      summary,
      suggestions,
      proposedAction: null,
      lookup: lookupPayload,
    };
  }

  return null;
}

function formatHostLabel(host) {
  const normalizedHost = cleanText(host).toLowerCase();

  if (normalizedHost === "fedora") {
    return "Fedora control plane";
  }

  if (normalizedHost === "windows") {
    return "Windows runtime";
  }

  return "unknown host";
}

function getServiceLabel(context) {
  return readText(context?.service?.displayName, context?.service?.name, "selected service");
}

function getServiceName(context) {
  return readText(context?.service?.name);
}

function getRelationshipLabel(relationship) {
  return readText(relationship?.displayName, relationship?.serviceId, relationship?.label, "related service");
}

function getSourceAttentionList(context) {
  return normalizeObjects(context?.inventory?.staleOrUnknownSources);
}

function getDependencySummary(context) {
  return toObject(context?.relationships?.dependencySummary);
}

function getDiagnosisContext(context) {
  return toObject(context?.diagnosis);
}

function getApprovalContext(context) {
  return toObject(context?.approval);
}

function getInventoryFreshness(context) {
  return toObject(context?.inventory?.freshness);
}

function getLatestAction(context) {
  return toObject(context?.latestAction);
}

function formatInventorySentence(context) {
  const freshness = getInventoryFreshness(context);
  const sources = getSourceAttentionList(context);
  const label = readText(freshness.label, "Inventory freshness unknown");
  const ageHint = readText(freshness.ageHint);

  if (sources.length) {
    const sourceText = sources.map((source) => `${source.displayLabel} ${source.bucket}`).join(", ");
    return `${label}${ageHint ? ` (${ageHint})` : ""}. Affected sources: ${sourceText}.`;
  }

  return `${label}${ageHint ? ` (${ageHint})` : ""}.`;
}

function formatDependencySentence(context) {
  const dependencySummary = getDependencySummary(context);

  if (!Number(dependencySummary.declaredCount || 0)) {
    return "No declared dependencies are mapped in the current inventory.";
  }

  if (Number(dependencySummary.attentionCount || 0) > 0) {
    return `${pluralize(Number(dependencySummary.attentionCount || 0), "dependency warning")} across ${pluralize(
      Number(dependencySummary.declaredCount || 0),
      "declared dependency",
      "declared dependencies",
    )}.`;
  }

  return `${pluralize(Number(dependencySummary.declaredCount || 0), "declared dependency", "declared dependencies")} with ${
    dependencySummary.freshnessSummary || "unknown"
  } freshness.`;
}

function formatDiagnosisSentence(context) {
  const diagnosis = getDiagnosisContext(context);

  if (diagnosis.detected !== true) {
    return "No active diagnosis is detected from the current UI state.";
  }

  const issue = readText(diagnosis.primaryIssue, diagnosis.mostRelevantError, "issue detected");
  const relatedService = readText(diagnosis.relatedServiceName, diagnosis.relatedServiceId);

  if (relatedService) {
    return `Diagnosis: ${issue}. Related service: ${relatedService}${diagnosis.relatedServiceHost ? ` on ${formatHostLabel(diagnosis.relatedServiceHost)}` : ""}.`;
  }

  return `Diagnosis: ${issue}.`;
}

function formatLatestActionSentence(context) {
  const latestAction = getLatestAction(context);
  const summary = readText(latestAction.summary);

  if (!summary) {
    return "No recent action summary is available for the selected service.";
  }

  const parts = [summary];

  if (latestAction.verificationSummary) {
    parts.push(latestAction.verificationSummary);
  }

  return `Latest action: ${parts.join(" ")}`;
}

function formatReadOnlyLogSupport(context) {
  const logsCapability = toObject(context?.capabilities?.logs);
  const serviceLabel = getServiceLabel(context);

  if (logsCapability.supported !== true) {
    return `Fetch Logs is not currently supported for ${serviceLabel} in Garage Admin V2.`;
  }

  if (logsCapability.executor === "windows-local") {
    return `Fetch Logs is available and reads Windows PM2 logs for ${serviceLabel}.`;
  }

  if (logsCapability.executor || cleanText(context?.service?.host).toLowerCase() === "fedora") {
    return `Fetch Logs is available through the Fedora-aware path for ${serviceLabel}.`;
  }

  return `Fetch Logs is available for ${serviceLabel}.`;
}

function formatReadOnlyHealthSupport(context) {
  const healthCapability = toObject(context?.capabilities?.health);
  const serviceLabel = getServiceLabel(context);

  if (healthCapability.supported !== true) {
    return `Run Health Check is not currently supported for ${serviceLabel} in Garage Admin V2.`;
  }

  if (healthCapability.mode === "bridge-health") {
    return `Run Health Check is available through the Fedora bridge for ${serviceLabel}.`;
  }

  if (healthCapability.mode === "http") {
    return `Run Health Check is available against the mapped health endpoint for ${serviceLabel}.`;
  }

  if (healthCapability.mode === "local-url") {
    return `Run Health Check is available against the mapped local URL for ${serviceLabel}.`;
  }

  if (healthCapability.mode === "tcp") {
    return `Run Health Check is available as a local TCP reachability check for ${serviceLabel}.`;
  }

  return `Run Health Check is available for ${serviceLabel}.`;
}

function buildReadOnlySuggestions(context, suggestions, options = {}) {
  const serviceLabel = getServiceLabel(context);
  const relatedService = readText(context?.diagnosis?.relatedServiceName, context?.diagnosis?.relatedServiceId);
  const inventoryFreshness = getInventoryFreshness(context);
  const sourceAttentionCount = getSourceAttentionList(context).length;

  if (inventoryFreshness.bucket === "stale" || inventoryFreshness.bucket === "unknown" || sourceAttentionCount > 0) {
    pushSuggestion(suggestions, "Refresh inventory before relying on risky or approval-gated action advice.");
  }

  if (context?.capabilities?.logs?.supported === true) {
    pushSuggestion(suggestions, `Use Fetch Logs for ${serviceLabel} to confirm the latest read-only output.`);
  }

  if (context?.capabilities?.health?.supported === true) {
    pushSuggestion(suggestions, `Run Health Check for ${serviceLabel} before considering a restart.`);
  }

  if (relatedService && options.includeRelated !== false) {
    pushSuggestion(
      suggestions,
      `Inspect related service ${relatedService}${context?.diagnosis?.relatedServiceHost ? ` on ${formatHostLabel(context.diagnosis.relatedServiceHost)}` : ""} because the diagnosis correlates there.`,
    );
  }
}

function buildHostOwnershipResponse(context) {
  const serviceLabel = getServiceLabel(context);
  const host = cleanText(context?.service?.host).toLowerCase();
  const suggestions = [];
  let summary = `${serviceLabel} host ownership is not clearly mapped. Do not assume Windows or Fedora actions until the inventory confirms ownership.`;

  if (host === "fedora") {
    summary =
      `${serviceLabel} is a Fedora control-plane service. Fedora owns ${FEDORA_OWNERSHIP.join(", ")}. ` +
      `Windows owns ${WINDOWS_OWNERSHIP.join(", ")}. I will keep diagnostics host-aware and avoid suggesting unsupported Windows PM2 actions for this service.`;
  } else if (host === "windows") {
    summary =
      `${serviceLabel} is a Windows runtime service. Windows owns ${WINDOWS_OWNERSHIP.join(", ")}. ` +
      `Fedora still owns ${FEDORA_OWNERSHIP.join(", ")}. I will not blur PM2 runtime work on Windows with Fedora control-plane responsibilities.`;
  }

  buildReadOnlySuggestions(context, suggestions);
  pushSuggestion(suggestions, "Keep control-plane internals internal; do not expose bridge-only paths publicly.");

  return {
    summary,
    suggestions,
    proposedAction: null,
  };
}

function buildDiagnosisResponse(context) {
  const diagnosis = getDiagnosisContext(context);
  const suggestions = [];
  const serviceLabel = getServiceLabel(context);
  let summary = `${serviceLabel} does not have an active diagnosis in the current UI state. ${formatInventorySentence(context)} ${formatReadOnlyLogSupport(context)}`;

  if (diagnosis.detected === true) {
    const issue = readText(diagnosis.primaryIssue, diagnosis.mostRelevantError, "issue detected");
    const likelyCause = readText(diagnosis.likelyCause);
    const relatedService = readText(diagnosis.relatedServiceName, diagnosis.relatedServiceId);
    const parts = [`Diagnosis for ${serviceLabel}: ${issue}.`];

    if (likelyCause) {
      parts.push(`Likely cause: ${likelyCause}.`);
    }

    if (relatedService) {
      parts.push(
        `The strongest correlation points to ${relatedService}${diagnosis.relatedServiceHost ? ` on ${formatHostLabel(diagnosis.relatedServiceHost)}` : ""}${diagnosis.correlationReason ? ` via ${diagnosis.correlationReason}` : ""}.`,
      );
    }

    parts.push(formatInventorySentence(context));
    summary = parts.join(" ");
  }

  buildReadOnlySuggestions(context, suggestions);
  pushSuggestion(suggestions, "Use extracted log events and the raw log summary together before planning a restart.");

  return {
    summary,
    suggestions,
    proposedAction: null,
  };
}

function buildSafeNextStepResponse(context) {
  const suggestions = [];
  const inventoryFreshness = getInventoryFreshness(context);
  const diagnosis = getDiagnosisContext(context);
  const approval = getApprovalContext(context);
  const sourceAttentionCount = getSourceAttentionList(context).length;
  let summary;

  if (
    inventoryFreshness.bucket === "stale" ||
    inventoryFreshness.bucket === "unknown" ||
    sourceAttentionCount > 0 ||
    approval.gate?.blockedUntilRefresh
  ) {
    summary = `Safest next step: refresh inventory first. ${formatInventorySentence(context)} Risky actions should wait for fresh context.`;
  } else if (context?.capabilities?.logs?.supported === true) {
    summary = `Safest next step: use Fetch Logs for ${getServiceLabel(context)} and compare the latest output to the extracted events and diagnosis.`;
  } else if (context?.capabilities?.health?.supported === true) {
    summary = `Safest next step: run Health Check for ${getServiceLabel(context)} before considering any restart planning.`;
  } else if (diagnosis.relatedServiceId) {
    summary = `Safest next step: inspect related service ${readText(
      diagnosis.relatedServiceName,
      diagnosis.relatedServiceId,
    )}${diagnosis.relatedServiceHost ? ` on ${formatHostLabel(diagnosis.relatedServiceHost)}` : ""} because the current diagnosis correlates there.`;
  } else {
    summary = `Safest next step: keep this read-only, review the current diagnosis and log summary, and refresh inventory if any timestamps are stale or unknown.`;
  }

  buildReadOnlySuggestions(context, suggestions);

  return {
    summary,
    suggestions,
    proposedAction: null,
  };
}

function buildServiceSummaryResponse(context) {
  const service = toObject(context?.service);
  const incident = toObject(context?.incident);
  const parts = [
    `${getServiceLabel(context)} runs on ${formatHostLabel(service.host)}${service.manager ? ` under ${service.manager}` : ""}.`,
    `Status: ${service.status || "unknown"}${service.severity ? ` with ${service.severity} severity` : ""}.`,
    service.type ? `Type: ${service.type}.` : "",
    service.runtimeSummary ? `Runtime: ${service.runtimeSummary}.` : "",
    service.localHealthUrl ? `Local health: ${service.localHealthUrl}.` : service.localUrl ? `Local URL: ${service.localUrl}.` : "",
    service.publicUrl ? `Public URL: ${service.publicUrl}.` : "",
    formatDependencySentence(context),
    formatInventorySentence(context),
    incident.title ? `Selected incident: ${incident.title}${incident.status ? ` (${incident.status})` : ""}.` : "",
    formatLatestActionSentence(context),
  ].filter(Boolean);
  const suggestions = [];

  buildReadOnlySuggestions(context, suggestions);

  return {
    summary: parts.join(" "),
    suggestions,
    proposedAction: null,
  };
}

function buildDependencyPathResponse(context) {
  const dependencies = normalizeObjects(context?.relationships?.dependencies);
  const diagnosis = getDiagnosisContext(context);
  const suggestions = [];

  if (!dependencies.length) {
    buildReadOnlySuggestions(context, suggestions, { includeRelated: false });

    return {
      summary: `No declared dependency path is mapped for ${getServiceLabel(context)} in the current inventory.`,
      suggestions,
      proposedAction: null,
    };
  }

  const relatedServiceId = cleanText(diagnosis.relatedServiceId).toLowerCase();
  const relatedDependency =
    dependencies.find((dependency) => cleanText(dependency.serviceId).toLowerCase() === relatedServiceId) || dependencies[0];
  const dependencyLabel = getRelationshipLabel(relatedDependency);
  const endpoint = readText(relatedDependency.endpoint);
  const reason = readText(relatedDependency.reason);
  const status = readText(relatedDependency.status, "unknown");
  const freshness = readText(relatedDependency.freshnessLabel, relatedDependency.freshness, "unknown");

  buildReadOnlySuggestions(context, suggestions);

  return {
    summary:
      `${getServiceLabel(context)} depends on ${dependencyLabel}${relatedDependency.host ? ` on ${formatHostLabel(relatedDependency.host)}` : ""}. ` +
      `${endpoint ? `Mapped endpoint: ${endpoint}. ` : ""}` +
      `${reason ? `Relationship: ${reason}. ` : ""}` +
      `Current dependency status: ${status}. Freshness: ${freshness}.`,
    suggestions,
    proposedAction: null,
  };
}

function buildLogsResponse(context) {
  const rawLogSummary = toObject(context?.rawLogSummary);
  const extractedLogEvents = toObject(context?.extractedLogEvents);
  const diagnosis = getDiagnosisContext(context);
  const suggestions = [];
  const parts = [formatReadOnlyLogSupport(context)];

  if (rawLogSummary.hasLogs) {
    parts.push(
      `Current raw log summary: ${rawLogSummary.summary || "No log alerts in current output."}${rawLogSummary.lineCount ? ` across ${rawLogSummary.lineCount} lines` : ""}${rawLogSummary.fetchedAt ? `, fetched at ${rawLogSummary.fetchedAt}` : ""}.`,
    );
  } else {
    parts.push("No raw logs are currently loaded for the selected service.");
  }

  if (Number(extractedLogEvents.count || 0) > 0) {
    parts.push(`${pluralize(Number(extractedLogEvents.count || 0), "extracted log event")} currently match the selected service context.`);
  }

  if (diagnosis.detected === true && diagnosis.mostRelevantError) {
    parts.push(`Most relevant error: ${diagnosis.mostRelevantError}.`);
  }

  parts.push(formatReadOnlyHealthSupport(context));

  buildReadOnlySuggestions(context, suggestions);
  pushSuggestion(suggestions, "Keep log review read-only and compare it to freshness and dependency context before restart planning.");

  return {
    summary: parts.join(" "),
    suggestions,
    proposedAction: null,
  };
}

function buildRestartPlanResponse(context) {
  const serviceName = getServiceName(context);
  const serviceLabel = getServiceLabel(context);
  const approval = getApprovalContext(context);
  const diagnosis = getDiagnosisContext(context);
  const inventoryFreshness = getInventoryFreshness(context);
  const sourceAttentionCount = getSourceAttentionList(context).length;
  const suggestions = [];
  let proposedAction = null;
  const parts = [
    "Restart planning should stay behind the existing approval workflow and start with read-only diagnostics.",
    formatReadOnlyLogSupport(context),
    formatReadOnlyHealthSupport(context),
  ];

  if (context?.capabilities?.restart?.supported !== true || approval.supported === false || approval.gateStatus === "unsupported") {
    parts.push(
      `${serviceLabel} does not have a supported restart path from this chat surface. I will not suggest unsupported cross-host restart behavior.`,
    );
    buildReadOnlySuggestions(context, suggestions);

    return {
      summary: parts.join(" "),
      suggestions,
      proposedAction: null,
    };
  }

  if (
    inventoryFreshness.bucket === "stale" ||
    inventoryFreshness.bucket === "unknown" ||
    sourceAttentionCount > 0 ||
    approval.gate?.blockedUntilRefresh === true
  ) {
    parts.push(`${formatInventorySentence(context)} Refresh inventory before preparing a restart.`);
    buildReadOnlySuggestions(context, suggestions);
    pushSuggestion(suggestions, "After refresh, re-check diagnosis and dependency freshness before opening the restart approval flow.");

    return {
      summary: parts.join(" "),
      suggestions,
      proposedAction: null,
    };
  }

  if (approval.gate?.requiresAcknowledgement === true) {
    parts.push("Inventory context requires stale-context acknowledgement in the approval workflow before restart approval.");
  }

  parts.push(
    "If diagnostics still point to the selected service after read-only checks, prepare the restart in the Actions panel where approval and freshness gates continue to apply.",
  );

  if (approval.riskLabel) {
    parts.push(`Current restart risk level: ${approval.riskLabel}.`);
  }

  buildReadOnlySuggestions(context, suggestions);
  pushSuggestion(suggestions, "Use the Actions panel rather than chat to prepare the approval-bound restart.");

  if (serviceName) {
    const reason = diagnosis.primaryIssue
      ? `Operator requested a restart plan after reviewing diagnosis: ${diagnosis.primaryIssue}.`
      : `Operator requested a restart plan for ${serviceLabel} after read-only review.`;

    proposedAction = {
      type: "restart-service",
      serviceName,
      reason,
    };
  }

  return {
    summary: parts.join(" "),
    suggestions,
    proposedAction,
  };
}

function buildStalenessResponse(context) {
  const approval = getApprovalContext(context);
  const suggestions = [];
  const parts = [formatInventorySentence(context), formatDependencySentence(context)];

  if (normalizeStrings(approval.dependencyWarnings).length) {
    parts.push(`Dependency freshness warnings: ${normalizeStrings(approval.dependencyWarnings).join(" ")}`);
  }

  if (approval.gate?.blockedUntilRefresh === true) {
    parts.push("Approval-gated restart planning is blocked until inventory is refreshed.");
  } else if (approval.gate?.requiresAcknowledgement === true) {
    parts.push("Approval-gated restart planning requires stale-context acknowledgement.");
  }

  buildReadOnlySuggestions(context, suggestions);
  pushSuggestion(suggestions, "Treat unknown timestamps as unknown context, not healthy context.");

  return {
    summary: parts.join(" "),
    suggestions,
    proposedAction: null,
  };
}

function buildDefaultResponse(context) {
  const suggestions = [];
  const summary = [
    `${getServiceLabel(context)} is selected on ${formatHostLabel(context?.service?.host)}.`,
    formatInventorySentence(context),
    formatDependencySentence(context),
    formatDiagnosisSentence(context),
    formatLatestActionSentence(context),
  ].join(" ");

  buildReadOnlySuggestions(context, suggestions);
  pushSuggestion(suggestions, "Ask for diagnosis, logs, dependency path, stale context, or restart planning when you need a more specific answer.");

  return {
    summary,
    suggestions,
    proposedAction: null,
  };
}

async function buildGroundedResponse(message, assistantContext, lookupRequest) {
  const lookupResponse = await buildLookupResponse(message, assistantContext, lookupRequest);

  if (lookupResponse) {
    return lookupResponse;
  }

  const context = toObject(assistantContext);

  if (!getServiceName(context)) {
    return {
      summary:
        "No service is selected. Select a service first so the assistant can ground diagnosis, dependencies, freshness, logs, and approval state in the current UI context.",
      suggestions: ["Select a service, then ask about diagnosis, next steps, dependencies, logs, or host ownership."],
      proposedAction: null,
    };
  }

  const intent = detectIntent(message);

  if (intent === "host-ownership") {
    return buildHostOwnershipResponse(context);
  }

  if (intent === "diagnosis") {
    return buildDiagnosisResponse(context);
  }

  if (intent === "safe-next-step") {
    return buildSafeNextStepResponse(context);
  }

  if (intent === "summarize-service") {
    return buildServiceSummaryResponse(context);
  }

  if (intent === "dependency-path") {
    return buildDependencyPathResponse(context);
  }

  if (intent === "logs") {
    return buildLogsResponse(context);
  }

  if (intent === "restart-plan") {
    return buildRestartPlanResponse(context);
  }

  if (intent === "stale") {
    return buildStalenessResponse(context);
  }

  return buildDefaultResponse(context);
}

router.post(
  "/plan",
  asyncRoute(async (req, res) => {
    const { message, serviceName, incident, logs, recentAudit, diagnosis, assistantContext, lookupRequest } = req.body || {};

    if (!message || !cleanText(message)) {
      return res.status(400).json({ error: "message is required" });
    }

    if (isObject(assistantContext)) {
      const response = await buildGroundedResponse(message, assistantContext, lookupRequest);

      return res.json({
        ok: true,
        summary: response.summary,
        suggestions: response.suggestions,
        proposedAction: response.proposedAction || null,
        lookup: response.lookup || null,
      });
    }

    const legacyResponse = buildLegacyResponse({
      message,
      serviceName,
      incident,
      logs,
      recentAudit,
      diagnosis,
    });

    res.json({
      ok: true,
      summary: legacyResponse.summary,
      suggestions: legacyResponse.suggestions,
      proposedAction: legacyResponse.proposedAction,
    });
  }),
);

module.exports = router;
