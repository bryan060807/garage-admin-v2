const express = require("express");

const router = express.Router();

function asyncRoute(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (error) {
      next(error);
    }
  };
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

function pushSuggestion(suggestions, value) {
  const suggestion = String(value || "").trim();

  if (!suggestion || suggestions.includes(suggestion)) {
    return;
  }

  suggestions.push(suggestion);
}

function buildSuggestions({ serviceName, logText, recentAudit, diagnosis }) {
  const normalizedLogs = logText.toLowerCase();
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

router.post(
  "/plan",
  asyncRoute(async (req, res) => {
    const { message, serviceName, incident, logs, recentAudit, diagnosis } = req.body || {};

    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: "message is required" });
    }

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
      `Operator request: ${String(message).trim()}`,
    ];

    const { suggestions, proposedAction } = buildSuggestions({
      serviceName,
      logText: logLines.join("\n"),
      recentAudit: auditEntries,
      diagnosis,
    });

    res.json({
      ok: true,
      summary: summaryParts.join(" | "),
      suggestions,
      proposedAction: proposedAction || null,
    });
  }),
);

module.exports = router;
