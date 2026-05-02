import assert from "node:assert/strict";
import { createRequire } from "node:module";

import {
  buildActionApprovalContext,
  buildActionApprovalContextFromReviewSnapshot,
  buildActionReviewSnapshot,
  evaluateApprovalFreshnessGate,
  selectActionReviewSnapshot,
} from "../src/actionApproval.js";
import { buildAssistantContext, buildAssistantRequestPayload } from "../src/assistantContext.js";
import {
  formatAssistantContextForTone,
  formatAssistantMessageForTone,
  formatAssistantPlanCardForTone,
  formatAssistantText,
  loadAssistantTone,
  saveAssistantTone,
} from "../src/assistantPersonality.js";
import { buildAssistantPlanCards } from "../src/assistantPlans.js";
import { getActionRiskProfile, shouldShowActionApprovalPreview } from "../src/actionRisk.js";
import {
  buildDependencyHealthRollup,
  classifyDependencyFreshness,
  classifyInventoryFreshness,
  describeInventoryFreshness,
} from "../src/dependencyHealth.js";
import { extractServiceDiagnosis, extractServiceLogEvents } from "../src/diagnostics.js";

const require = createRequire(import.meta.url);
const actionsRouter = require("../../backend/src/routes/actions.js");
const chatRouter = require("../../backend/src/routes/chat.js");
const { mergeActionReviewIntoInput, sanitizeActionReviewSnapshot } = actionsRouter.__testables;
const { buildGroundedResponse, classifyAssistantIntent } = chatRouter.__testables;

const FRESHNESS_NOW = Date.parse("2026-05-01T12:00:00Z");

function indexInventorySources(sourceBreakdown) {
  return Object.fromEntries((Array.isArray(sourceBreakdown) ? sourceBreakdown : []).map((source) => [source.key, source]));
}

function buildServiceInventory() {
  return [
    {
      name: "garage-admin-v2",
      displayName: "Garage Admin V2",
      host: "windows",
      manager: "pm2",
      processName: "garage-admin-v2",
      inventory: {
        host: "windows",
        manager: "pm2",
        processName: "garage-admin-v2",
        localPort: 4010,
        localUrl: "http://127.0.0.1:4010",
        localHealthUrl: "http://127.0.0.1:4010/health",
      },
      provides: [
        {
          kind: "http",
          endpoint: "http://127.0.0.1:4010",
          healthEndpoint: "http://127.0.0.1:4010/health",
        },
      ],
      dependencies: [
        {
          serviceId: "admin-proxy",
          relationship: "control-plane-path",
          endpoint: "http://127.0.0.1:4000/admin/health",
          required: true,
          confidence: "authoritative",
        },
      ],
    },
    {
      name: "trackmaster-api",
      displayName: "TrackMaster API",
      host: "windows",
      manager: "pm2",
      processName: "trackmaster-api",
      inventory: {
        host: "windows",
        manager: "pm2",
        processName: "trackmaster-api",
        localPort: 3004,
        localUrl: "http://127.0.0.1:3004",
        localHealthUrl: "http://127.0.0.1:3004/api/health",
        publicUrl: "https://trackmaster.aibry.shop/api",
      },
      provides: [
        {
          kind: "http",
          endpoint: "http://127.0.0.1:3004",
          healthEndpoint: "http://127.0.0.1:3004/api/health",
          readinessEndpoint: "http://127.0.0.1:3004/api/readiness",
          publicHost: "trackmaster-api.aibry.shop",
          paths: ["/api"],
        },
      ],
    },
    {
      name: "trackmaster-ui",
      displayName: "TrackMaster UI",
      host: "windows",
      manager: "pm2",
      processName: "trackmaster-ui",
      inventory: {
        host: "windows",
        manager: "pm2",
        processName: "trackmaster-ui",
        localPort: 3000,
        localUrl: "http://127.0.0.1:3000",
        localHealthUrl: "http://127.0.0.1:3000/",
        publicUrl: "https://trackmaster.aibry.shop",
      },
      provides: [
        {
          kind: "static-ui",
          endpoint: "http://127.0.0.1:3000",
          publicHost: "trackmaster.aibry.shop",
          paths: ["/"],
        },
      ],
      dependencies: [
        {
          serviceId: "trackmaster-api",
          relationship: "calls-api",
          endpoint: "http://127.0.0.1:3004/api/health",
          required: true,
          confidence: "authoritative",
        },
      ],
    },
    {
      name: "trackmaster-comparator",
      displayName: "TrackMaster Comparator",
      host: "windows",
      manager: "pm2",
      processName: "trackmaster-comparator",
      inventory: {
        host: "windows",
        manager: "pm2",
        processName: "trackmaster-comparator",
        localPort: 8081,
        localUrl: "http://127.0.0.1:8081",
        publicUrl: "https://comparator.aibry.shop",
      },
    },
    {
      name: "aibry-admin",
      displayName: "AIBRY Admin",
      host: "fedora",
      manager: "systemd",
      inventory: {
        host: "fedora",
        publicUrl: "https://admin.aibry.shop/bridge",
      },
      provides: [
        {
          kind: "fedora-bridge",
          notes: "Fedora-hosted bridge service.",
        },
      ],
    },
    {
      name: "admin-proxy",
      displayName: "Admin Proxy",
      host: "fedora",
      manager: "systemd",
      inventory: {
        host: "fedora",
        publicUrl: "https://admin.aibry.shop/admin",
      },
      provides: [
        {
          kind: "control-plane",
          endpoint: "http://127.0.0.1:4000",
          healthEndpoint: "http://127.0.0.1:4000/admin/health",
          paths: ["/admin/health", "/admin/services", "/admin/service-discovery", "/admin/status"],
        },
      ],
    },
    {
      name: "node-agent",
      displayName: "Node Agent",
      host: "fedora",
      manager: "systemd",
      inventory: {
        host: "fedora",
        publicUrl: "https://admin.aibry.shop/agent",
      },
      provides: [
        {
          kind: "control-plane",
          paths: ["/admin/node/health"],
        },
      ],
    },
  ];
}

function buildContext(overrides = {}) {
  return {
    selectedService: "trackmaster-api",
    serviceName: "trackmaster-api",
    service: {
      host: "windows",
      health: {
        checks: {},
      },
      inventory: {
        host: "windows",
        manager: "pm2",
        processName: "trackmaster-api",
        localPort: 3004,
        localUrl: "http://127.0.0.1:3004",
        localHealthUrl: "http://127.0.0.1:3004/api/health",
      },
    },
    host: "windows",
    manager: "pm2",
    processName: "trackmaster-api",
    localPort: 3004,
    localUrl: "http://127.0.0.1:3004",
    localHealthUrl: "http://127.0.0.1:3004/api/health",
    publicUrl: "https://trackmaster.aibry.shop/api",
    status: "online",
    logsFetchedAt: "2026-04-30T12:00:00Z",
    recentAudit: [],
    services: buildServiceInventory(),
    ...overrides,
  };
}

function buildTrackmasterUiContext(overrides = {}) {
  return buildContext({
    selectedService: "trackmaster-ui",
    serviceName: "trackmaster-ui",
    service: {
      host: "windows",
      health: {
        checks: {},
      },
      inventory: {
        host: "windows",
        manager: "pm2",
        processName: "trackmaster-ui",
        localPort: 3000,
        localUrl: "http://127.0.0.1:3000",
        localHealthUrl: "http://127.0.0.1:3000/",
      },
    },
    host: "windows",
    manager: "pm2",
    processName: "trackmaster-ui",
    localPort: 3000,
    localUrl: "http://127.0.0.1:3000",
    localHealthUrl: "http://127.0.0.1:3000/",
    publicUrl: "https://trackmaster.aibry.shop",
    ...overrides,
  });
}

function buildGarageAdminContext(overrides = {}) {
  return buildContext({
    selectedService: "garage-admin-v2",
    serviceName: "garage-admin-v2",
    service: {
      host: "windows",
      health: {
        checks: {},
      },
      inventory: {
        host: "windows",
        manager: "pm2",
        processName: "garage-admin-v2",
        localPort: 4010,
        localUrl: "http://127.0.0.1:4010",
        localHealthUrl: "http://127.0.0.1:4010/health",
      },
    },
    host: "windows",
    manager: "pm2",
    processName: "garage-admin-v2",
    localPort: 4010,
    localUrl: "http://127.0.0.1:4010",
    localHealthUrl: "http://127.0.0.1:4010/health",
    publicUrl: "",
    ...overrides,
  });
}

function patchService(services, serviceId, patch) {
  return services.map((service) => {
    if (service.name !== serviceId) {
      return service;
    }

    return {
      ...service,
      ...patch,
      inventory: patch.inventory ? { ...(service.inventory || {}), ...patch.inventory } : service.inventory,
      health: patch.health ? { ...(service.health || {}), ...patch.health } : service.health,
      runtime: patch.runtime ? { ...(service.runtime || {}), ...patch.runtime } : service.runtime,
    };
  });
}

function findService(services, serviceId) {
  return services.find((service) => service.name === serviceId) || null;
}

function buildDependencyRollupInventory() {
  return patchService(
    patchService(buildServiceInventory(), "trackmaster-api", {
      status: "online",
      runtime: {
        checkedAt: "2026-05-01T11:59:30Z",
      },
    }),
    "admin-proxy",
    {
      status: "running",
      runtime: {
        checkedAt: "2026-05-01T11:58:45Z",
      },
    },
  );
}

function buildApprovalInventorySnapshot(overrides = {}) {
  return {
    checkedAt: "2026-05-01T11:59:20Z",
    sources: {
      windowsPm2: {
        checkedAt: "2026-05-01T11:59:10Z",
      },
      fedoraBridge: {
        checkedAt: "2026-05-01T11:55:00Z",
      },
    },
    ...overrides,
  };
}

const cases = [
  {
    name: "SyntaxError with file and line",
    context: buildContext({
      logs: [
        "2026-04-30T12:00:00Z SyntaxError: Unexpected token '}'",
        "    at C:\\apps\\trackmaster-api\\src\\server.js:59:12",
      ].join("\n"),
    }),
    verify(diagnosis, events) {
      assert.equal(diagnosis.detected, true);
      assert.equal(diagnosis.errorType, "SyntaxError");
      assert.equal(diagnosis.filePath, "C:\\apps\\trackmaster-api\\src\\server.js");
      assert.equal(diagnosis.lineNumber, 59);
      assert.ok(diagnosis.suggestedCommand.includes("node --check"));
      assert.equal(events[0].errorType, "SyntaxError");
    },
  },
  {
    name: "TypeError stack trace",
    context: buildContext({
      logs: [
        "2026-04-30T12:05:00Z TypeError: Cannot read properties of undefined (reading 'map')",
        "    at C:\\apps\\trackmaster-api\\src\\routes\\songs.js:27:18",
      ].join("\n"),
    }),
    verify(diagnosis, events) {
      assert.equal(diagnosis.detected, true);
      assert.equal(diagnosis.errorType, "TypeError");
      assert.equal(diagnosis.lineNumber, 27);
      assert.ok(diagnosis.filePath.endsWith("\\songs.js"));
      assert.equal(events[0].errorType, "TypeError");
    },
  },
  {
    name: "EADDRINUSE",
    context: buildContext({
      logs: "2026-04-30T12:06:00Z Error: listen EADDRINUSE: address already in use 127.0.0.1:3004",
    }),
    verify(diagnosis, events) {
      assert.equal(diagnosis.detected, true);
      assert.equal(diagnosis.errorType, "EADDRINUSE");
      assert.ok(diagnosis.suggestedCommand.includes("Get-NetTCPConnection"));
      assert.equal(events[0].errorType, "EADDRINUSE");
    },
  },
  {
    name: "ECONNREFUSED external dependency",
    context: buildTrackmasterUiContext({
      logs: "2026-04-30T12:07:00Z Error: connect ECONNREFUSED 127.0.0.1:5432",
    }),
    verify(diagnosis, events) {
      assert.equal(diagnosis.detected, true);
      assert.equal(diagnosis.errorType, "ECONNREFUSED");
      assert.ok(diagnosis.suggestedCommand.includes("Test-NetConnection"));
      assert.equal(events[0].errorType, "ECONNREFUSED");
      assert.equal(diagnosis.relatedServiceId || "", "");
    },
  },
  {
    name: "ECONNREFUSED 127.0.0.1:3004 correlates to trackmaster-api",
    context: buildTrackmasterUiContext({
      logs: "2026-04-30T12:07:30Z Error: connect ECONNREFUSED 127.0.0.1:3004",
    }),
    verify(diagnosis, events) {
      assert.equal(diagnosis.relatedServiceId, "trackmaster-api");
      assert.equal(diagnosis.relatedServiceHost, "windows");
      assert.equal(diagnosis.relatedServiceManager, "pm2");
      assert.ok(diagnosis.relatedEndpoint.includes("127.0.0.1:3004"));
      assert.equal(diagnosis.correlationConfidence, "high");
      assert.equal(diagnosis.correlationReason, "Matched declared dependency");
      assert.equal(events[0].relatedServiceId, "trackmaster-api");
      assert.ok(events[0].relatedEndpoint.includes("127.0.0.1:3004"));
      assert.equal(events[0].correlationConfidence, "high");
      assert.equal(events[0].correlationReason, "Matched declared dependency");
    },
  },
  {
    name: "trackmaster-api health endpoint match correlates via provided health endpoint",
    context: buildTrackmasterUiContext({
      logs: "2026-04-30T12:07:40Z Upstream check failed for http://127.0.0.1:3004/api/health HTTP 502 Bad Gateway",
    }),
    verify(diagnosis, events) {
      assert.equal(diagnosis.relatedServiceId, "trackmaster-api");
      assert.equal(diagnosis.correlationConfidence, "high");
      assert.equal(diagnosis.correlationReason, "Matched provided health endpoint");
      assert.ok(diagnosis.relatedEndpoint.includes("127.0.0.1:3004/api/health"));
      assert.equal(events[0].relatedServiceId, "trackmaster-api");
      assert.ok(events[0].relatedEndpoint.includes("127.0.0.1:3004/api/health"));
      assert.equal(events[0].correlationConfidence, "high");
      assert.equal(events[0].correlationReason, "Matched provided health endpoint");
    },
  },
  {
    name: "systemd exited failed line",
    context: buildContext({
      selectedService: "aibry-admin",
      serviceName: "aibry-admin",
      service: {
        host: "fedora",
        health: {
          checks: {},
        },
        inventory: {
          host: "fedora",
          manager: "systemd",
        },
      },
      host: "fedora",
      manager: "systemd",
      processName: "",
      localPort: null,
      localUrl: "",
      localHealthUrl: "",
      publicUrl: "",
      status: "failed",
      logs: "Apr 30 12:08:00 fedora systemd[1]: aibry-admin.service: Main process exited, code=exited, status=1/FAILURE",
    }),
    verify(diagnosis, events) {
      assert.equal(diagnosis.detected, true);
      assert.equal(diagnosis.primaryIssue, "Service exited during startup");
      assert.ok(diagnosis.suggestedCommand.startsWith("journalctl -u"));
      assert.equal(events[0].primaryIssue, "Service exited during startup");
    },
  },
  {
    name: "127.0.0.1:3000 correlates to trackmaster-ui",
    context: buildContext({
      logs: "2026-04-30T12:08:45Z Upstream check failed for http://127.0.0.1:3000/ HTTP 502 Bad Gateway",
    }),
    verify(diagnosis, events) {
      assert.equal(diagnosis.relatedServiceId, "trackmaster-ui");
      assert.ok(diagnosis.relatedEndpoint.includes("127.0.0.1:3000"));
      assert.equal(diagnosis.correlationConfidence, "high");
      assert.equal(diagnosis.correlationReason, "Port/name fallback");
      assert.equal(events[0].relatedServiceId, "trackmaster-ui");
      assert.ok(events[0].relatedEndpoint.includes("127.0.0.1:3000"));
      assert.equal(events[0].correlationConfidence, "high");
      assert.equal(events[0].correlationReason, "Port/name fallback");
    },
  },
  {
    name: "public host trackmaster.aibry.shop correlates to trackmaster-ui",
    context: buildContext({
      logs: "2026-04-30T12:08:47Z Upstream returned HTTP 502 for https://trackmaster.aibry.shop/",
    }),
    verify(diagnosis, events) {
      assert.equal(diagnosis.relatedServiceId, "trackmaster-ui");
      assert.equal(diagnosis.correlationConfidence, "high");
      assert.equal(diagnosis.correlationReason, "Matched public host");
      assert.equal(diagnosis.relatedEndpoint, "trackmaster.aibry.shop");
      assert.equal(events[0].relatedServiceId, "trackmaster-ui");
      assert.equal(events[0].relatedEndpoint, "trackmaster.aibry.shop");
      assert.equal(events[0].correlationConfidence, "high");
      assert.equal(events[0].correlationReason, "Matched public host");
    },
  },
  {
    name: "selected service does not falsely correlate to itself",
    context: buildContext({
      logs: "2026-04-30T12:08:50Z Error: connect ECONNREFUSED 127.0.0.1:3004",
    }),
    verify(diagnosis, events) {
      assert.equal(diagnosis.relatedServiceId || "", "");
      assert.equal(diagnosis.correlationReason || "", "");
      assert.equal(diagnosis.correlationConfidence || "", "");
      assert.equal(events[0].relatedServiceId || "", "");
      assert.equal(events[0].correlationReason || "", "");
      assert.equal(events[0].correlationConfidence || "", "");
    },
  },
  {
    name: "generic HTTP 502 without endpoint does not invent an upstream",
    context: buildContext({
      logs: "2026-04-30T12:09:00Z GET /api/health HTTP 502 Bad Gateway",
    }),
    verify(diagnosis, events) {
      assert.equal(diagnosis.detected, true);
      assert.equal(diagnosis.errorType, "502 Upstream unavailable");
      assert.equal(diagnosis.source, "logs");
      assert.ok(diagnosis.suggestedCommand.includes("Invoke-WebRequest"));
      assert.equal(events[0].errorType, "502 Upstream unavailable");
      assert.equal(diagnosis.relatedServiceId || "", "");
      assert.equal(diagnosis.correlationReason || "", "");
      assert.equal(diagnosis.correlationConfidence || "", "");
      assert.equal(events[0].relatedServiceId || "", "");
      assert.equal(events[0].correlationReason || "", "");
      assert.equal(events[0].correlationConfidence || "", "");
    },
  },
  {
    name: "declared dependency mention correlates correctly",
    context: buildTrackmasterUiContext({
      logs: "2026-04-30T12:09:15Z Error contacting trackmaster-api: connection refused",
    }),
    verify(diagnosis, events) {
      assert.equal(diagnosis.relatedServiceId, "trackmaster-api");
      assert.equal(diagnosis.correlationConfidence, "high");
      assert.equal(diagnosis.correlationReason, "Matched declared dependency");
      assert.equal(events[0].relatedServiceId, "trackmaster-api");
      assert.equal(events[0].correlationReason, "Matched declared dependency");
    },
  },
  {
    name: "service/process name match correlates correctly",
    context: buildContext({
      logs: "2026-04-30T12:09:16Z Render dependency trackmaster-ui returned HTTP 502",
    }),
    verify(diagnosis, events) {
      assert.equal(diagnosis.relatedServiceId, "trackmaster-ui");
      assert.equal(diagnosis.correlationConfidence, "high");
      assert.equal(diagnosis.correlationReason, "Port/name fallback");
      assert.equal(events[0].relatedServiceId, "trackmaster-ui");
      assert.equal(events[0].correlationConfidence, "high");
      assert.equal(events[0].correlationReason, "Port/name fallback");
    },
  },
  {
    name: "control-plane admin path correlates to admin-proxy",
    context: buildGarageAdminContext({
      logs: "2026-04-30T12:09:20Z GET /admin/health HTTP 502 Bad Gateway",
    }),
    verify(diagnosis, events) {
      assert.equal(diagnosis.relatedServiceId, "admin-proxy");
      assert.equal(diagnosis.relatedServiceHost, "fedora");
      assert.equal(diagnosis.correlationReason, "Matched declared dependency");
      assert.equal(events[0].relatedServiceId, "admin-proxy");
      assert.equal(events[0].correlationReason, "Matched declared dependency");
    },
  },
  {
    name: "control-plane node path correlates to node-agent when metadata is explicit",
    context: buildGarageAdminContext({
      logs: "2026-04-30T12:09:25Z Probe failed for /admin/node/health HTTP 502 Bad Gateway",
    }),
    verify(diagnosis, events) {
      assert.equal(diagnosis.relatedServiceId, "node-agent");
      assert.equal(diagnosis.relatedServiceHost, "fedora");
      assert.equal(diagnosis.correlationReason, "Matched provided path");
      assert.equal(events[0].relatedServiceId, "node-agent");
      assert.equal(events[0].correlationConfidence, "high");
      assert.equal(events[0].correlationReason, "Matched provided path");
    },
  },
  {
    name: "benign log with no error",
    context: buildContext({
      logs: [
        "2026-04-30T12:10:00Z [trackmaster-api] listening on 3004",
        "2026-04-30T12:10:02Z [trackmaster-api] healthy",
      ].join("\n"),
    }),
    verify(diagnosis, events) {
      assert.equal(diagnosis.detected, false);
      assert.equal(diagnosis.source, "none");
      assert.equal(diagnosis.severity, "info");
      assert.equal(events.length, 0);
    },
  },
];

const results = [];

for (const testCase of cases) {
  const diagnosis = extractServiceDiagnosis(testCase.context);
  const events = extractServiceLogEvents(testCase.context);

  testCase.verify(diagnosis, events);
  results.push({
    name: testCase.name,
    detected: diagnosis.detected,
    primaryIssue: diagnosis.primaryIssue || "none",
    logEventCount: events.length,
  });
}

const actionRiskCases = [
  {
    name: "fetch-logs maps to safe",
    profile: getActionRiskProfile("fetch-logs"),
    verify(profile) {
      assert.equal(profile.riskLevel, "safe");
      assert.equal(profile.label, "Safe");
      assert.equal(profile.requiresApproval, false);
    },
  },
  {
    name: "health-check maps to safe",
    profile: getActionRiskProfile("health-check"),
    verify(profile) {
      assert.equal(profile.riskLevel, "safe");
      assert.equal(profile.label, "Safe");
      assert.equal(profile.requiresApproval, false);
    },
  },
  {
    name: "restart-service maps to caution and requires approval",
    profile: getActionRiskProfile("restart-service", { input: { requiresApproval: true, risk: "medium" } }),
    verify(profile) {
      assert.equal(profile.riskLevel, "caution");
      assert.equal(profile.label, "Caution");
      assert.equal(profile.requiresApproval, true);
    },
  },
  {
    name: "delete-prune-write-repair style actions map to dangerous",
    profile: {
      deleteData: getActionRiskProfile("delete-data"),
      pruneDocker: getActionRiskProfile("prune-docker"),
      writeFile: getActionRiskProfile("write-file"),
      runRepair: getActionRiskProfile("run-repair"),
    },
    verify(profile) {
      assert.equal(profile.deleteData.riskLevel, "dangerous");
      assert.equal(profile.pruneDocker.riskLevel, "dangerous");
      assert.equal(profile.writeFile.riskLevel, "dangerous");
      assert.equal(profile.runRepair.riskLevel, "dangerous");
    },
  },
  {
    name: "backend low-medium-high risk metadata normalizes correctly",
    profile: {
      low: getActionRiskProfile("fetch-logs", { input: { risk: "low" } }),
      medium: getActionRiskProfile("restart-service", { input: { risk: "medium", requiresApproval: true } }),
      high: getActionRiskProfile("write-file", { input: { risk: "high" } }),
    },
    verify(profile) {
      assert.equal(profile.low.riskLevel, "safe");
      assert.equal(profile.medium.riskLevel, "caution");
      assert.equal(profile.high.riskLevel, "dangerous");
    },
  },
  {
    name: "unsupported restart stays blocked in approval copy",
    profile: getActionRiskProfile(
      "restart-service",
      { input: { requiresApproval: true, risk: "medium" } },
      { service: { host: "windows", manager: "pm2" }, supported: false },
    ),
    verify(profile) {
      assert.equal(profile.riskLevel, "caution");
      assert.equal(profile.expectedImpact, "Restart is not supported for this service from this executor.");
    },
  },
  {
    name: "approval preview helper includes impact and rollback for caution-dangerous actions",
    profile: {
      caution: getActionRiskProfile("restart-service", { input: { requiresApproval: true } }),
      dangerous: getActionRiskProfile("write-file", { input: { risk: "high" } }),
      showCaution: shouldShowActionApprovalPreview("restart-service", { input: { requiresApproval: true } }),
      showDangerous: shouldShowActionApprovalPreview("write-file", { input: { risk: "high" } }),
    },
    verify(profile) {
      assert.ok(profile.caution.expectedImpact.length > 0);
      assert.ok(profile.caution.rollbackNote.length > 0);
      assert.ok(profile.dangerous.expectedImpact.length > 0);
      assert.ok(profile.dangerous.rollbackNote.length > 0);
      assert.equal(profile.showCaution, true);
      assert.equal(profile.showDangerous, true);
    },
  },
];

for (const testCase of actionRiskCases) {
  testCase.verify(testCase.profile);
  results.push({
    name: testCase.name,
    actionRisk: testCase.profile?.riskLevel || "multi",
    actionApprovalPreview:
      typeof testCase.profile?.requiresApproval === "boolean" ? String(testCase.profile.requiresApproval) : "mixed",
  });
}

const approvalFreshnessServices = patchService(
  patchService(buildServiceInventory(), "trackmaster-ui", {
    lastCheckedAt: "2026-05-01T11:59:30Z",
    status: "online",
  }),
  "trackmaster-api",
  {
    lastCheckedAt: "2026-05-01T11:59:25Z",
    status: "online",
  },
);
const staleDependencyApprovalServices = patchService(approvalFreshnessServices, "trackmaster-api", {
  lastCheckedAt: "2026-05-01T11:45:00Z",
});

const approvalFreshnessCases = [
  {
    name: "safe action has no freshness gate",
    context: buildActionApprovalContext({
      actionType: "fetch-logs",
      actionMetadata: { input: { risk: "low", requiresApproval: false } },
      service: findService(approvalFreshnessServices, "trackmaster-api"),
      services: approvalFreshnessServices,
      inventorySnapshot: buildApprovalInventorySnapshot({
        checkedAt: "2026-05-01T11:59:30Z",
      }),
      riskContext: { supported: true },
      now: FRESHNESS_NOW,
    }),
    verify(context) {
      assert.equal(context.gate.policy, "none");
      assert.equal(evaluateApprovalFreshnessGate(context).allowed, true);
    },
  },
  {
    name: "caution action with fresh inventory proceeds through existing approval",
    context: buildActionApprovalContext({
      actionType: "restart-service",
      actionMetadata: { input: { risk: "medium", requiresApproval: true } },
      service: findService(approvalFreshnessServices, "trackmaster-api"),
      services: approvalFreshnessServices,
      inventorySnapshot: buildApprovalInventorySnapshot({
        checkedAt: "2026-05-01T11:59:35Z",
      }),
      riskContext: { supported: true },
      now: FRESHNESS_NOW,
    }),
    verify(context) {
      assert.equal(context.gate.policy, "existing-approval");
      assert.equal(evaluateApprovalFreshnessGate(context).allowed, true);
    },
  },
  {
    name: "caution action with stale inventory requires stale-context acknowledgement",
    context: buildActionApprovalContext({
      actionType: "restart-service",
      actionMetadata: { input: { risk: "medium", requiresApproval: true } },
      service: findService(approvalFreshnessServices, "trackmaster-api"),
      services: approvalFreshnessServices,
      inventorySnapshot: buildApprovalInventorySnapshot({
        checkedAt: "2026-05-01T11:45:00Z",
      }),
      riskContext: { supported: true },
      now: FRESHNESS_NOW,
    }),
    verify(context) {
      assert.equal(context.inventoryFreshness.bucket, "stale");
      assert.equal(context.gate.policy, "acknowledge-stale-context");
      assert.equal(evaluateApprovalFreshnessGate(context).allowed, false);
      assert.equal(evaluateApprovalFreshnessGate(context, true).allowed, true);
    },
  },
  {
    name: "dangerous action with stale inventory is blocked until refresh",
    context: buildActionApprovalContext({
      actionType: "write-file",
      actionMetadata: { input: { risk: "high", requiresApproval: true } },
      service: findService(approvalFreshnessServices, "trackmaster-api"),
      services: approvalFreshnessServices,
      inventorySnapshot: buildApprovalInventorySnapshot({
        checkedAt: "2026-05-01T11:48:00Z",
      }),
      riskContext: { supported: true },
      now: FRESHNESS_NOW,
    }),
    verify(context) {
      assert.equal(context.gate.policy, "refresh-required");
      assert.equal(context.gate.blockedUntilRefresh, true);
      assert.equal(evaluateApprovalFreshnessGate(context).allowed, false);
      assert.ok(evaluateApprovalFreshnessGate(context).reason.includes("Refresh inventory"));
    },
  },
  {
    name: "unsupported action remains blocked regardless of freshness",
    context: buildActionApprovalContext({
      actionType: "restart-service",
      actionMetadata: { input: { risk: "medium", requiresApproval: true } },
      service: findService(approvalFreshnessServices, "trackmaster-api"),
      services: approvalFreshnessServices,
      inventorySnapshot: buildApprovalInventorySnapshot({
        checkedAt: "2026-05-01T11:59:40Z",
      }),
      riskContext: { supported: false },
      now: FRESHNESS_NOW,
    }),
    verify(context) {
      assert.equal(context.gate.policy, "unsupported");
      assert.equal(evaluateApprovalFreshnessGate(context).allowed, false);
    },
  },
  {
    name: "approval context includes inventory freshness and provenance",
    context: buildActionApprovalContext({
      actionType: "restart-service",
      actionMetadata: { input: { risk: "medium", requiresApproval: true } },
      service: findService(approvalFreshnessServices, "trackmaster-api"),
      services: approvalFreshnessServices,
      inventorySnapshot: buildApprovalInventorySnapshot({
        checkedAt: "",
        sources: {
          windowsPm2: {
            checkedAt: "2026-05-01T11:55:00Z",
          },
        },
      }),
      riskContext: { supported: true },
      now: FRESHNESS_NOW,
    }),
    verify(context) {
      assert.equal(context.inventoryFreshness.bucket, "aging");
      assert.equal(context.inventoryFreshness.label, "Inventory aging");
      assert.equal(context.inventoryFreshness.provenanceText, "Based on sources.windowsPm2.checkedAt");
    },
  },
  {
    name: "dependency stale context appears for approval previews when dependencies age out",
    context: buildActionApprovalContext({
      actionType: "restart-service",
      actionMetadata: { input: { risk: "medium", requiresApproval: true } },
      service: findService(staleDependencyApprovalServices, "trackmaster-ui"),
      services: staleDependencyApprovalServices,
      inventorySnapshot: buildApprovalInventorySnapshot({
        checkedAt: "2026-05-01T11:59:45Z",
      }),
      riskContext: { supported: true },
      now: FRESHNESS_NOW,
    }),
    verify(context) {
      assert.ok(context.dependencyRollup);
      assert.equal(context.dependencyRollup.freshnessSummary, "1 stale");
      assert.ok(context.dependencyWarnings.includes("Dependency context may be stale."));
      assert.ok(context.dependencyWarnings.includes("TrackMaster API status may be stale."));
    },
  },
];

for (const testCase of approvalFreshnessCases) {
  testCase.verify(testCase.context);
  results.push({
    name: testCase.name,
    approvalGate: testCase.context.gate.policy,
    inventoryBucket: testCase.context.inventoryFreshness.bucket,
    dependencyFreshness: testCase.context.dependencyRollup?.freshnessSummary || "none",
  });
}

const reviewSnapshotContext = buildActionApprovalContext({
  actionType: "restart-service",
  actionMetadata: {
    actionType: "restart-service",
    target: "trackmaster-ui",
    requestedBy: "operator-a",
    approvedBy: "operator-b",
    input: {
      serviceName: "trackmaster-ui",
      host: "windows",
    },
  },
  service: findService(staleDependencyApprovalServices, "trackmaster-ui"),
  services: staleDependencyApprovalServices,
  inventorySnapshot: buildApprovalInventorySnapshot({
    checkedAt: "2026-05-01T11:45:00Z",
  }),
  riskContext: { supported: true },
  now: FRESHNESS_NOW,
});
const reviewSnapshot = buildActionReviewSnapshot({
  phase: "approved",
  actionType: "restart-service",
  actionMetadata: {
    id: "audit-review-1",
    actionType: "restart-service",
    target: "trackmaster-ui",
    requestedBy: "operator-a",
    approvedBy: "operator-b",
    input: {
      serviceName: "trackmaster-ui",
      host: "windows",
    },
  },
  service: findService(staleDependencyApprovalServices, "trackmaster-ui"),
  approvalContext: reviewSnapshotContext,
  requestedBy: "operator-a",
  approvedBy: "operator-b",
  freshnessAcknowledged: true,
  gateDisabledReason: evaluateApprovalFreshnessGate(reviewSnapshotContext).reason,
  now: FRESHNESS_NOW,
});
const hydratedReviewContext = buildActionApprovalContextFromReviewSnapshot(reviewSnapshot);

assert.equal(reviewSnapshot.phase, "approved");
assert.equal(reviewSnapshot.actionType, "restart-service");
assert.equal(reviewSnapshot.targetServiceId, "trackmaster-ui");
assert.equal(reviewSnapshot.host, "windows");
assert.equal(reviewSnapshot.runtimeManager, "pm2");
assert.equal(reviewSnapshot.requestedBy, "operator-a");
assert.equal(reviewSnapshot.approvedBy, "operator-b");
assert.equal(reviewSnapshot.approvalContext.inventoryFreshness.bucket, "stale");
assert.equal(reviewSnapshot.approvalContext.dependencyRollup?.freshnessSummary, "1 stale");
assert.equal(reviewSnapshot.approvalContext.gate?.freshnessAcknowledged, true);
assert.ok(reviewSnapshot.approvalContext.gate?.gateDisabledReason.toLowerCase().includes("stale or unknown"));
assert.ok(!Object.prototype.hasOwnProperty.call(reviewSnapshot, "logs"));
assert.ok(!Object.prototype.hasOwnProperty.call(reviewSnapshot.approvalContext.dependencyRollup.items[0], "endpoint"));
assert.equal(hydratedReviewContext.inventoryFreshness.bucket, "stale");
assert.equal(hydratedReviewContext.dependencyRollup?.freshnessSummary, "1 stale");
results.push({
  name: "action review snapshot captures sanitized freshness and approval metadata",
  reviewPhase: reviewSnapshot.phase,
  reviewGate: reviewSnapshot.approvalContext.gate?.policy || "none",
  reviewDependencyFreshness: reviewSnapshot.approvalContext.dependencyRollup?.freshnessSummary || "none",
});

const selectedReviewSnapshot = selectActionReviewSnapshot(
  {
    requested: {
      ...reviewSnapshot,
      phase: "requested",
    },
    executed: {
      ...reviewSnapshot,
      phase: "executed",
    },
    latest: "executed",
  },
  "approved",
);

assert.equal(selectedReviewSnapshot?.phase, "executed");

const sanitizedReviewSnapshot = sanitizeActionReviewSnapshot(
  {
    ...reviewSnapshot,
    logs: "SHOULD_NOT_BE_STORED",
    approvalContext: {
      ...reviewSnapshot.approvalContext,
      gate: {
        ...reviewSnapshot.approvalContext.gate,
        envValue: "SECRET",
      },
      dependencyRollup: {
        ...reviewSnapshot.approvalContext.dependencyRollup,
        items: [
          {
            ...reviewSnapshot.approvalContext.dependencyRollup.items[0],
            endpoint: "http://secret.internal",
            token: "SECRET",
          },
        ],
      },
    },
  },
  {
    phase: "approved",
    actionId: "audit-review-1",
    actionType: "restart-service",
    target: "trackmaster-ui",
    targetServiceId: "trackmaster-ui",
    targetServiceName: "trackmaster-ui",
    host: "windows",
    requestedBy: "operator-a",
    approvedBy: "operator-b",
  },
);
const mergedReviewInput = mergeActionReviewIntoInput(
  {
    serviceName: "trackmaster-ui",
    host: "windows",
    reason: "Routine restart",
    requiresApproval: true,
  },
  reviewSnapshot,
  {
    phase: "approved",
    actionId: "audit-review-1",
    actionType: "restart-service",
    target: "trackmaster-ui",
    targetServiceId: "trackmaster-ui",
    targetServiceName: "trackmaster-ui",
    host: "windows",
    requestedBy: "operator-a",
    approvedBy: "operator-b",
  },
);

assert.ok(sanitizedReviewSnapshot);
assert.ok(!Object.prototype.hasOwnProperty.call(sanitizedReviewSnapshot, "logs"));
assert.ok(!Object.prototype.hasOwnProperty.call(sanitizedReviewSnapshot.approvalContext.gate, "envValue"));
assert.ok(!Object.prototype.hasOwnProperty.call(sanitizedReviewSnapshot.approvalContext.dependencyRollup.items[0], "endpoint"));
assert.ok(!Object.prototype.hasOwnProperty.call(sanitizedReviewSnapshot.approvalContext.dependencyRollup.items[0], "token"));
assert.equal(sanitizedReviewSnapshot.actionId, "audit-review-1");
assert.equal(mergedReviewInput.actionReview.approved.phase, "approved");
assert.equal(mergedReviewInput.actionReview.approved.actionId, "audit-review-1");
assert.equal(mergedReviewInput.actionReview.latest, "approved");
results.push({
  name: "backend action review sanitizer and merger keep only allowlisted snapshot fields",
  storedReviewPhases: Object.keys(mergedReviewInput.actionReview).sort().join(","),
});

const freshnessCases = [
  {
    name: "dependency freshness classifies lastCheckedAt within two minutes as fresh",
    service: {
      lastCheckedAt: "2026-05-01T11:58:45Z",
    },
    verify(freshness) {
      assert.equal(freshness.bucket, "fresh");
      assert.equal(freshness.timestampSource, "lastCheckedAt");
    },
  },
  {
    name: "dependency freshness classifies lastSeen within ten minutes as aging",
    service: {
      lastSeen: "2026-05-01T11:53:00Z",
    },
    verify(freshness) {
      assert.equal(freshness.bucket, "aging");
      assert.equal(freshness.timestampSource, "lastSeen");
    },
  },
  {
    name: "dependency freshness classifies older than ten minutes as stale",
    service: {
      runtime: {
        checkedAt: "2026-05-01T11:49:00Z",
      },
    },
    verify(freshness) {
      assert.equal(freshness.bucket, "stale");
      assert.equal(freshness.timestampSource, "checkedAt");
    },
  },
  {
    name: "dependency freshness returns unknown when no timestamp is available",
    service: {},
    verify(freshness) {
      assert.equal(freshness.bucket, "unknown");
      assert.equal(freshness.timestamp, null);
      assert.equal(freshness.timestampSource, "");
    },
  },
];

for (const testCase of freshnessCases) {
  const freshness = classifyDependencyFreshness(testCase.service, { now: FRESHNESS_NOW });

  testCase.verify(freshness);
  results.push({
    name: testCase.name,
    freshness: freshness.bucket,
    freshnessTimestampSource: freshness.timestampSource || "none",
  });
}

const inventoryFreshnessCases = [
  {
    name: "inventory freshness prefers top-level checkedAt within two minutes",
    payload: {
      checkedAt: "2026-05-01T11:59:26Z",
      sources: {
        services: {
          checkedAt: "2026-05-01T11:59:50Z",
        },
      },
      items: [
        {
          lastCheckedAt: "2026-05-01T11:59:55Z",
        },
      ],
    },
    verify(freshness, summary) {
      assert.equal(freshness.bucket, "fresh");
      assert.equal(freshness.timestampSource, "response.checkedAt");
      assert.equal(freshness.timestampSourceType, "response");
      assert.equal(freshness.timestampSourceName, "");
      assert.equal(freshness.timestampField, "checkedAt");
      assert.equal(summary.label, "Inventory fresh");
      assert.equal(summary.ageHint, "checked 34s ago");
      assert.equal(summary.provenanceText, "Based on response.checkedAt");
      assert.equal(summary.hint, "");
      assert.equal(summary.sourceBreakdown[0].compactLabel, "services fresh");
    },
  },
  {
    name: "inventory freshness uses newest source checkedAt before fresher service timestamps",
    payload: {
      sources: {
        windowsPm2: {
          checkedAt: "2026-05-01T11:55:00Z",
        },
        fedoraBridge: {
          checkedAt: "2026-05-01T11:53:30Z",
        },
      },
      items: [
        {
          lastCheckedAt: "2026-05-01T11:59:40Z",
        },
      ],
    },
    verify(freshness, summary) {
      assert.equal(freshness.bucket, "aging");
      assert.equal(freshness.timestampSource, "sources.windowsPm2.checkedAt");
      assert.equal(freshness.timestampSourceType, "source");
      assert.equal(freshness.timestampSourceName, "windowsPm2");
      assert.equal(freshness.timestampField, "checkedAt");
      assert.equal(summary.label, "Inventory aging");
      assert.equal(summary.ageHint, "checked 5m ago");
      assert.equal(summary.provenanceText, "Based on sources.windowsPm2.checkedAt");
      assert.equal(summary.hint, "");
      const sourceBreakdown = indexInventorySources(summary.sourceBreakdown);
      assert.equal(sourceBreakdown.windowsPm2.bucket, "aging");
      assert.equal(sourceBreakdown.fedoraBridge.bucket, "aging");
    },
  },
  {
    name: "inventory source breakdown shows fresh and aging buckets independently",
    payload: {
      sources: {
        windowsPm2: {
          checkedAt: "2026-05-01T11:59:20Z",
        },
        fedoraBridge: {
          checkedAt: "2026-05-01T11:55:15Z",
        },
      },
      items: [
        {
          name: "trackmaster-api",
          lastCheckedAt: "2026-05-01T11:59:50Z",
        },
      ],
    },
    verify(freshness, summary) {
      const sourceBreakdown = indexInventorySources(summary.sourceBreakdown);
      assert.equal(freshness.bucket, "fresh");
      assert.equal(sourceBreakdown.windowsPm2.bucket, "fresh");
      assert.equal(sourceBreakdown.windowsPm2.compactLabel, "windowsPm2 fresh");
      assert.equal(sourceBreakdown.fedoraBridge.bucket, "aging");
      assert.equal(sourceBreakdown.fedoraBridge.compactLabel, "fedoraBridge aging");
      assert.equal(summary.sourceBreakdownSummary, "Sources: windowsPm2 fresh | fedoraBridge aging");
      assert.equal(summary.sourceHint, "");
    },
  },
  {
    name: "inventory freshness classifies stale service lastCheckedAt and shows quiet refresh guidance",
    payload: {
      items: [
        {
          name: "fedora-bridge",
          lastCheckedAt: "2026-05-01T11:45:00Z",
        },
        {
          name: "trackmaster-api",
          lastCheckedAt: "2026-05-01T11:49:00Z",
        },
      ],
    },
    verify(freshness, summary) {
      assert.equal(freshness.bucket, "stale");
      assert.equal(freshness.timestampSource, "service.trackmaster-api.lastCheckedAt");
      assert.equal(freshness.timestampSourceType, "service");
      assert.equal(freshness.timestampSourceName, "trackmaster-api");
      assert.equal(freshness.timestampField, "lastCheckedAt");
      assert.equal(summary.ageHint, "checked 11m ago");
      assert.equal(summary.provenanceText, "Based on newest service lastCheckedAt");
      assert.equal(summary.hint, "Refresh inventory before acting.");
    },
  },
  {
    name: "inventory freshness falls back to newest service lastSeen when lastCheckedAt is unavailable",
    payload: {
      items: [
        {
          name: "admin-proxy",
          lastSeen: "2026-05-01T11:56:15Z",
        },
        {
          name: "trackmaster-ui",
          lastSeen: "2026-05-01T11:54:30Z",
        },
      ],
    },
    verify(freshness, summary) {
      assert.equal(freshness.bucket, "aging");
      assert.equal(freshness.timestampSource, "service.admin-proxy.lastSeen");
      assert.equal(freshness.timestampSourceType, "service");
      assert.equal(freshness.timestampSourceName, "admin-proxy");
      assert.equal(freshness.timestampField, "lastSeen");
      assert.equal(summary.provenanceText, "Based on newest service lastSeen");
      assert.equal(summary.hint, "");
    },
  },
  {
    name: "inventory freshness falls back to equivalent service checkedAt metadata",
    payload: {
      items: [
        {
          name: "trackmaster-ui",
          runtime: {
            checkedAt: "2026-05-01T11:58:30Z",
          },
        },
      ],
    },
    verify(freshness, summary) {
      assert.equal(freshness.bucket, "fresh");
      assert.equal(freshness.timestampSource, "service.trackmaster-ui.checkedAt");
      assert.equal(freshness.timestampSourceType, "service");
      assert.equal(freshness.timestampSourceName, "trackmaster-ui");
      assert.equal(freshness.timestampField, "checkedAt");
      assert.equal(summary.label, "Inventory fresh");
      assert.equal(summary.provenanceText, "Based on newest service checkedAt");
      assert.equal(summary.hint, "");
    },
  },
  {
    name: "inventory source breakdown names stale and unknown sources",
    payload: {
      sources: {
        windowsPm2: {
          checkedAt: "2026-05-01T11:48:45Z",
          status: "degraded",
        },
        fedoraBridge: {
          ok: true,
          error: "",
        },
        inventoryCache: {
          checkedAt: "2026-05-01T11:59:35Z",
          label: "Inventory Cache",
        },
      },
    },
    verify(freshness, summary) {
      const sourceBreakdown = indexInventorySources(summary.sourceBreakdown);
      assert.equal(freshness.bucket, "fresh");
      assert.equal(sourceBreakdown.windowsPm2.bucket, "stale");
      assert.equal(sourceBreakdown.windowsPm2.status, "degraded");
      assert.equal(sourceBreakdown.fedoraBridge.bucket, "unknown");
      assert.equal(sourceBreakdown.fedoraBridge.ok, true);
      assert.equal(sourceBreakdown.inventoryCache.displayLabel, "Inventory Cache");
      assert.equal(sourceBreakdown.inventoryCache.bucket, "fresh");
      assert.equal(summary.sourceHint, "windowsPm2 inventory stale | fedoraBridge inventory timestamp unknown");
    },
  },
  {
    name: "inventory freshness returns unknown when timestamps are missing",
    payload: {
      items: [{}],
    },
    verify(freshness, summary) {
      assert.equal(freshness.bucket, "unknown");
      assert.equal(freshness.timestamp, null);
      assert.equal(freshness.timestampSource, "");
      assert.equal(freshness.timestampSourceType, "unknown");
      assert.equal(freshness.timestampSourceName, "");
      assert.equal(freshness.timestampField, "");
      assert.equal(summary.label, "Inventory freshness unknown");
      assert.equal(summary.ageHint, "");
      assert.equal(summary.provenanceText, "Timestamp source unknown");
      assert.equal(summary.hint, "Inventory timestamp unavailable.");
      assert.equal(summary.sourceBreakdownSummary, "Sources: unknown");
    },
  },
];

for (const testCase of inventoryFreshnessCases) {
  const freshness = classifyInventoryFreshness(testCase.payload, { now: FRESHNESS_NOW });
  const summary = describeInventoryFreshness(testCase.payload, { now: FRESHNESS_NOW });

  testCase.verify(freshness, summary);
  results.push({
    name: testCase.name,
    inventoryFreshness: freshness.bucket,
    inventoryFreshnessTimestampSource: freshness.timestampSource || "none",
    inventoryFreshnessProvenance: summary.provenanceText || "none",
    inventoryFreshnessHint: summary.hint || "none",
  });
}

const dependencyRollupCases = [
  {
    name: "dependency rollup marks running dependency as healthy",
    services: buildDependencyRollupInventory(),
    selectedService: "trackmaster-ui",
    verify(rollup) {
      assert.ok(rollup);
      assert.equal(rollup.declaredCount, 1);
      assert.equal(rollup.counts.healthy, 1);
      assert.equal(rollup.counts.warning, 0);
      assert.equal(rollup.counts.failed, 0);
      assert.equal(rollup.counts.unknown, 0);
      assert.equal(rollup.items[0].label, "TrackMaster API");
      assert.equal(rollup.items[0].status, "running");
      assert.ok(rollup.items[0].endpoint.includes("127.0.0.1:3004/api/health"));
    },
  },
  {
    name: "dependency rollup marks missing inventory dependency as unknown",
    services: buildDependencyRollupInventory().filter((service) => service.name !== "trackmaster-api"),
    selectedService: "trackmaster-ui",
    verify(rollup) {
      assert.ok(rollup);
      assert.equal(rollup.declaredCount, 1);
      assert.equal(rollup.counts.healthy, 0);
      assert.equal(rollup.counts.warning, 0);
      assert.equal(rollup.counts.failed, 0);
      assert.equal(rollup.counts.unknown, 1);
      assert.equal(rollup.items[0].label, "trackmaster-api");
      assert.equal(rollup.items[0].status, "unknown");
    },
  },
  {
    name: "dependency rollup maps needs setup dependency to warning",
    services: patchService(buildDependencyRollupInventory(), "admin-proxy", { status: "needs-setup" }),
    selectedService: "garage-admin-v2",
    verify(rollup) {
      assert.ok(rollup);
      assert.equal(rollup.declaredCount, 1);
      assert.equal(rollup.counts.healthy, 0);
      assert.equal(rollup.counts.warning, 1);
      assert.equal(rollup.counts.failed, 0);
      assert.equal(rollup.counts.unknown, 0);
      assert.equal(rollup.items[0].status, "warning");
    },
  },
  {
    name: "dependency rollup stays quiet when no dependencies are declared",
    services: buildDependencyRollupInventory(),
    selectedService: "trackmaster-api",
    verify(rollup) {
      assert.equal(rollup, null);
    },
  },
  {
    name: "dependency rollup marks diagnosis-related dependency",
    services: buildDependencyRollupInventory(),
    selectedService: "trackmaster-ui",
    logs: "2026-04-30T12:07:30Z Error: connect ECONNREFUSED 127.0.0.1:3004",
    verify(rollup, diagnosis) {
      assert.ok(rollup);
      assert.equal(diagnosis.relatedServiceId, "trackmaster-api");
      assert.equal(rollup.items[0].diagnosisRelated, true);
      assert.equal(rollup.items[0].diagnosisLabel, "Related to current diagnosis");
    },
  },
  {
    name: "dependency rollup shows stale freshness hint for diagnosis-related dependency",
    services: patchService(buildDependencyRollupInventory(), "trackmaster-api", {
      runtime: {
        checkedAt: "2026-05-01T11:45:00Z",
      },
    }),
    selectedService: "trackmaster-ui",
    logs: "2026-04-30T12:07:30Z Error: connect ECONNREFUSED 127.0.0.1:3004",
    verify(rollup, diagnosis) {
      assert.ok(rollup);
      assert.equal(diagnosis.relatedServiceId, "trackmaster-api");
      assert.equal(rollup.freshnessSummary, "1 stale");
      assert.equal(rollup.items[0].diagnosisRelated, true);
      assert.equal(rollup.items[0].freshness, "stale");
      assert.equal(rollup.items[0].diagnosisFreshnessLabel, "Status may be stale. Refresh service inventory before acting.");
    },
  },
];

for (const testCase of dependencyRollupCases) {
  const services = testCase.services;
  const service = findService(services, testCase.selectedService);
  const diagnosis = testCase.logs
    ? extractServiceDiagnosis(
        buildTrackmasterUiContext({
          services,
          logs: testCase.logs,
        }),
      )
    : null;
  const rollup = buildDependencyHealthRollup(service, services, diagnosis, { now: FRESHNESS_NOW });

  testCase.verify(rollup, diagnosis);
  results.push({
    name: testCase.name,
    dependencyDeclaredCount: rollup?.declaredCount ?? 0,
    dependencyHealthyCount: rollup?.counts.healthy ?? 0,
    dependencyWarningCount: rollup?.counts.warning ?? 0,
    dependencyFailedCount: rollup?.counts.failed ?? 0,
    dependencyUnknownCount: rollup?.counts.unknown ?? 0,
    dependencyFreshnessSummary: rollup?.freshnessSummary || "none",
  });
}

const assistantInventorySnapshot = buildApprovalInventorySnapshot({
  sources: {
    windowsPm2: {
      displayName: "Windows PM2",
      checkedAt: "2026-05-01T11:59:10Z",
    },
    fedoraBridge: {
      displayName: "Fedora Bridge",
      checkedAt: "2026-05-01T11:45:00Z",
    },
  },
});
const assistantServices = patchService(buildDependencyRollupInventory(), "admin-proxy", {
  runtime: {
    checkedAt: "2026-05-01T11:45:00Z",
  },
});
const garageAdminService = findService(assistantServices, "garage-admin-v2");
const adminProxyService = findService(assistantServices, "admin-proxy");
const assistantLogs = "2026-04-30T12:09:20Z GET /admin/health HTTP 502 Bad Gateway";
const assistantDiagnosis = extractServiceDiagnosis(
  buildGarageAdminContext({
    services: assistantServices,
    logs: assistantLogs,
  }),
);
const assistantEvents = extractServiceLogEvents(
  buildGarageAdminContext({
    services: assistantServices,
    logs: assistantLogs,
  }),
);
const assistantInventoryFreshness = describeInventoryFreshness(assistantInventorySnapshot, {
  services: assistantServices,
  now: FRESHNESS_NOW,
});
const assistantDependencyRollup = buildDependencyHealthRollup(
  garageAdminService,
  assistantServices,
  assistantDiagnosis,
  { now: FRESHNESS_NOW },
);
const assistantApprovalContext = buildActionApprovalContext({
  actionType: "restart-service",
  actionMetadata: {
    actionType: "restart-service",
    target: "garage-admin-v2",
    input: {
      serviceName: "garage-admin-v2",
    },
  },
  service: garageAdminService,
  services: assistantServices,
  inventorySnapshot: assistantInventorySnapshot,
  inventoryFreshness: assistantInventoryFreshness,
  dependencyRollup: assistantDependencyRollup,
  now: FRESHNESS_NOW,
});
const assistantRestartRiskProfile = getActionRiskProfile("restart-service");
const assistantAuditEntries = [
  {
    id: "audit-restart-1",
    target: "garage-admin-v2",
    actionType: "restart-service",
    status: "failed",
    createdAt: "2026-05-01T11:40:00Z",
    requestedBy: "operator-a",
  },
  {
    id: "audit-health-1",
    target: "garage-admin-v2",
    actionType: "health-check",
    status: "completed",
    createdAt: "2026-05-01T11:20:00Z",
    requestedBy: "operator-a",
  },
];
const assistantReportLookupItem = {
  id: "report:garage-admin-v2-runbook",
  kind: "report",
  title: "Garage Admin V2 Runbook",
  reportId: "garage-admin-v2-runbook",
  snippet: "Operator runbook for Garage Admin V2 recovery and ownership boundaries.",
  sourceLabel: "Registry metadata",
  hostContext: "docs",
  preview: "SHOULD_NOT_APPEAR_IN_PLAN",
  previewAvailable: true,
};
const assistantFileLookupItem = {
  id: "preview:readme",
  kind: "file-preview",
  title: "README.md",
  relativePath: "README.md",
  path: "C:/workspace/README.md",
  snippet: "Matched filename/path: README.md",
  sourceLabel: "Allowlisted filesystem",
  hostContext: "windows",
  preview: "FULL FILE CONTENT SHOULD NOT APPEAR",
  truncated: true,
  previewAvailable: true,
};

const assistantContextCases = [
  {
    name: "assistant context summarizes stale fedora inventory without raw log dump",
    context: buildAssistantContext({
      selectedService: "garage-admin-v2",
      selectedServiceRecord: {
        ...garageAdminService,
        runtimeSummary: "PM2 online",
      },
      services: assistantServices,
      diagnosis: assistantDiagnosis,
      diagnosisLogEvents: assistantEvents,
      logSummary: {
        hasLogs: true,
        logsFetchedAt: "2026-05-01T11:59:40Z",
        lineCount: 1,
        visibleLineCount: 1,
        filtered: false,
        alertOnly: false,
        alertCount: 1,
        criticalCount: 0,
        errorCount: 1,
        warningCount: 0,
        summary: "1 log alert",
      },
      inventoryFreshness: assistantInventoryFreshness,
      dependencyRollup: assistantDependencyRollup,
      approvalContext: assistantApprovalContext,
      restartRiskProfile: assistantRestartRiskProfile,
      latestAction: {
        type: "restart-service",
        status: "failed",
        summary: "Action failed.",
      },
      capabilities: {
        logs: {
          supported: true,
          executor: "windows-local",
        },
        health: {
          supported: true,
          mode: "http",
        },
        restart: {
          supported: true,
        },
      },
      selectedIncident: {
        id: "incident-1",
        title: "Garage admin bridge errors",
        status: "open",
        severity: "warning",
        serviceName: "garage-admin-v2",
      },
    }),
    verify(context) {
      assert.equal(context.service.host, "windows");
      assert.equal(context.ownership.currentHostLabel, "Windows runtime");
      assert.equal(context.rawLogSummary.lineCount, 1);
      assert.equal(context.rawLogSummary.summary, "1 log alert");
      assert.ok(!("logs" in context.rawLogSummary));
      assert.ok(context.openingMessage.includes("Garage Admin V2 is selected."));
      assert.ok(context.openingMessage.includes("Fedora Bridge inventory is stale."));
      assert.equal(context.diagnosis.relatedServiceId, "admin-proxy");
      assert.ok(context.inventory.staleOrUnknownSources.some((source) => source.displayLabel === "Fedora Bridge"));
      assert.equal(context.relationships.dependencies[0].serviceId, "admin-proxy");
    },
  },
  {
    name: "assistant context marks fedora host ownership for control-plane service",
    context: buildAssistantContext({
      selectedService: "admin-proxy",
      selectedServiceRecord: adminProxyService,
      services: assistantServices,
      diagnosis: null,
      diagnosisLogEvents: [],
      logSummary: {
        hasLogs: false,
        lineCount: 0,
        visibleLineCount: 0,
        alertCount: 0,
        summary: "No log alerts in current output.",
      },
      inventoryFreshness: assistantInventoryFreshness,
      dependencyRollup: null,
      approvalContext: null,
      restartRiskProfile: null,
      latestAction: null,
      capabilities: {
        logs: {
          supported: true,
          executor: "fedora-bridge",
        },
        health: {
          supported: true,
          mode: "bridge-health",
        },
        restart: {
          supported: false,
          reason: "Unsupported for Fedora control-plane services.",
        },
      },
    }),
    verify(context) {
      assert.equal(context.service.host, "fedora");
      assert.equal(context.ownership.currentHostLabel, "Fedora control plane");
      assert.ok(context.openingMessage.includes("Admin Proxy is selected."));
      assert.equal(context.capabilities.restart.supported, false);
    },
  },
];

for (const testCase of assistantContextCases) {
  testCase.verify(testCase.context);
  results.push({
    name: testCase.name,
    assistantContextService: testCase.context.service.name || "none",
    assistantContextHost: testCase.context.service.host || "unknown",
    assistantContextInventoryBucket: testCase.context.inventory.freshness.bucket,
    assistantContextDependencyCount: testCase.context.relationships.dependencySummary.declaredCount,
  });
}

const assistantRequestPayload = buildAssistantRequestPayload({
  message: "Prepare restart plan",
  context: assistantContextCases[0].context,
});

assert.equal(assistantRequestPayload.message, "Prepare restart plan");
assert.equal(assistantRequestPayload.serviceName, "garage-admin-v2");
assert.ok(Array.isArray(assistantRequestPayload.promptScaffold.groundingRules));
assert.ok(Array.isArray(assistantRequestPayload.promptScaffold.operatorRules));
assert.ok(!Object.prototype.hasOwnProperty.call(assistantRequestPayload, "logs"));
results.push({
  name: "assistant request payload stays sanitized",
  assistantRequestHasContext: Boolean(assistantRequestPayload.assistantContext),
  assistantRequestHasLogsField: Object.prototype.hasOwnProperty.call(assistantRequestPayload, "logs"),
  assistantRequestGroundingRules: assistantRequestPayload.promptScaffold.groundingRules.length,
});

const assistantNoServiceContext = buildAssistantContext({
  selectedService: "",
  selectedServiceRecord: null,
  services: assistantServices,
  diagnosis: null,
  diagnosisLogEvents: [],
  logSummary: {
    hasLogs: false,
    lineCount: 0,
    visibleLineCount: 0,
    alertCount: 0,
    summary: "No log alerts in current output.",
  },
  inventoryFreshness: assistantInventoryFreshness,
  dependencyRollup: null,
  approvalContext: null,
  restartRiskProfile: null,
  latestAction: null,
  capabilities: {
    logs: {
      supported: false,
    },
    health: {
      supported: false,
    },
    restart: {
      supported: false,
    },
  },
});

const assistantNoServicePlans = buildAssistantPlanCards({
  activePlanChipId: "build-diagnosis-plan",
  assistantContext: assistantNoServiceContext,
  auditEntries: [],
  lookupItems: [],
});
const assistantNoServiceDiagnosisPlan =
  assistantNoServicePlans.find((card) => card.planType === "diagnose failed service") || null;

assert.ok(assistantNoServiceDiagnosisPlan);
assert.equal(assistantNoServiceDiagnosisPlan.targetService, null);
assert.ok(assistantNoServiceDiagnosisPlan.readOnlySteps[0].includes("Select a service first"));
results.push({
  name: "assistant plan cards build without a selected service",
  assistantPlanCount: assistantNoServicePlans.length,
  assistantPlanHasDiagnosis: Boolean(assistantNoServiceDiagnosisPlan),
});

const assistantDiagnosisPlans = buildAssistantPlanCards({
  activePlanChipId: "build-diagnosis-plan",
  assistantContext: assistantContextCases[0].context,
  restartApprovalContext: assistantApprovalContext,
  restartRiskProfile: assistantRestartRiskProfile,
  auditEntries: assistantAuditEntries,
  lookupItems: [assistantReportLookupItem],
  selectedLookupItem: assistantReportLookupItem,
});
const assistantDiagnosisPlan =
  assistantDiagnosisPlans.find((card) => card.planType === "diagnose failed service") || null;

assert.ok(assistantDiagnosisPlan);
assert.equal(assistantDiagnosisPlan.targetService?.id, "garage-admin-v2");
assert.ok(assistantDiagnosisPlan.readOnlySteps.length >= 1);
assert.equal(assistantDiagnosisPlan.hostOwnership.label, "Windows runtime/operator");
results.push({
  name: "assistant diagnosis plan includes selected service and read-only steps",
  assistantDiagnosisPlanTarget: assistantDiagnosisPlan.targetService?.id || "none",
  assistantDiagnosisPlanSteps: assistantDiagnosisPlan.readOnlySteps.length,
});

const assistantRestartPlans = buildAssistantPlanCards({
  activePlanChipId: "build-restart-request-plan",
  assistantContext: assistantContextCases[0].context,
  restartApprovalContext: assistantApprovalContext,
  restartRiskProfile: assistantRestartRiskProfile,
  auditEntries: assistantAuditEntries,
  lookupItems: [assistantReportLookupItem],
  selectedLookupItem: assistantReportLookupItem,
});
const assistantRestartPlan =
  assistantRestartPlans.find((card) => card.planType === "prepare restart request") || null;

assert.ok(assistantRestartPlan);
assert.equal(assistantRestartPlan.risk.level, "caution");
assert.ok(assistantRestartPlan.approvalSteps.length >= 1);
assert.ok(assistantRestartPlan.blockedNote.includes("cannot restart"));
assert.ok(assistantRestartPlan.blockedNote.includes("cannot restart or approve"));
assert.ok(assistantRestartPlan.approvalSteps.some((step) => step.includes("Service Actions")));
results.push({
  name: "assistant restart plan stays approval-routed",
  assistantRestartPlanRisk: assistantRestartPlan.risk.level,
  assistantRestartPlanApprovalSteps: assistantRestartPlan.approvalSteps.length,
  assistantRestartPlanGate: assistantRestartPlan.freshnessGateStatus?.label || "none",
});

const assistantStalePlans = buildAssistantPlanCards({
  activePlanChipId: "build-stale-inventory-plan",
  assistantContext: assistantContextCases[0].context,
  restartApprovalContext: assistantApprovalContext,
});
const assistantStalePlan =
  assistantStalePlans.find((card) => card.planType === "explain stale inventory") || null;

assert.ok(assistantStalePlan);
assert.ok(
  assistantStalePlan.currentEvidenceSummary.includes("stale") ||
    assistantStalePlan.freshnessGateStatus?.label?.toLowerCase().includes("stale") ||
    assistantStalePlan.freshnessGateStatus?.label === "Acknowledge stale context",
);
results.push({
  name: "assistant stale inventory plan includes freshness warning",
  assistantStalePlanGate: assistantStalePlan.freshnessGateStatus?.label || "none",
});

const assistantDependencyPlans = buildAssistantPlanCards({
  activePlanChipId: "build-dependency-trace-plan",
  assistantContext: assistantContextCases[0].context,
  lookupItems: [],
});
const assistantDependencyPlan =
  assistantDependencyPlans.find((card) => card.planType === "trace dependency failure") || null;

assert.ok(assistantDependencyPlan);
assert.ok(
  assistantDependencyPlan.currentEvidenceSummary.includes("Admin Proxy") ||
    assistantDependencyPlan.currentEvidenceSummary.includes("admin-proxy"),
);
assert.ok(assistantDependencyPlan.supportingEvidence.some((evidence) => evidence.title.includes("Admin Proxy")));
results.push({
  name: "assistant dependency trace plan uses declared dependency evidence",
  assistantDependencyPlanEvidenceCount: assistantDependencyPlan.supportingEvidence.length,
});

const assistantReportPlans = buildAssistantPlanCards({
  activePlanChipId: "build-report-evidence-plan",
  assistantContext: assistantContextCases[0].context,
  lookupItems: [assistantReportLookupItem],
  selectedLookupItem: assistantReportLookupItem,
});
const assistantReportPlan =
  assistantReportPlans.find((card) => card.planType === "find supporting report/runbook") || null;

assert.ok(assistantReportPlan);
assert.ok(assistantReportPlan.currentEvidenceSummary.includes("Garage Admin V2 Runbook"));
assert.ok(!assistantReportPlan.currentEvidenceSummary.includes("SHOULD_NOT_APPEAR_IN_PLAN"));
results.push({
  name: "assistant report evidence plan references lookup result without dumping preview content",
  assistantReportPlanEvidenceCount: assistantReportPlan.supportingEvidence.length,
});

const assistantFilePlans = buildAssistantPlanCards({
  activePlanChipId: "build-file-evidence-plan",
  assistantContext: assistantContextCases[0].context,
  lookupItems: [assistantFileLookupItem],
  selectedLookupItem: assistantFileLookupItem,
});
const assistantFilePlan =
  assistantFilePlans.find((card) => card.planType === "inspect safe file evidence") || null;

assert.ok(assistantFilePlan);
assert.ok(assistantFilePlan.currentEvidenceSummary.includes("README.md"));
assert.ok(!assistantFilePlan.currentEvidenceSummary.includes("FULL FILE CONTENT SHOULD NOT APPEAR"));
assert.ok(!assistantFilePlan.supportingEvidence[0].summary.includes("FULL FILE CONTENT SHOULD NOT APPEAR"));
results.push({
  name: "assistant file evidence plan references lookup result without dumping preview content",
  assistantFilePlanEvidenceCount: assistantFilePlan.supportingEvidence.length,
});

const normalToneResponse = formatAssistantText(
  "I do not see a critical issue in the current logs. Run a health check next.",
  {
    tone: "normal",
    category: "healthy",
  },
);
assert.equal(normalToneResponse, "I do not see a critical issue in the current logs. Run a health check next.");
results.push({
  name: "assistant normal tone stays professional",
  normalToneResponse,
});

const sarcasticToneResponse = formatAssistantText(
  "No critical issue in the current logs. Run a health check before we trust it.",
  {
    tone: "sarcastic",
    category: "healthy",
  },
);
const mondayToneResponse = formatAssistantText(
  "No critical issue in the current logs. Run a health check before we trust it.",
  {
    tone: "monday",
    category: "healthy",
  },
);
assert.ok(sarcasticToneResponse.includes("machine has chosen peace"));
assert.ok(mondayToneResponse.includes("Stunning. Terrifying."));
results.push({
  name: "assistant sarcastic and monday tones add personality",
  sarcasticToneResponse,
  mondayToneResponse,
});

const dangerousToneResponse = formatAssistantText(
  "That is a dangerous action. I am not doing it from chat. Use the approval workflow.",
  {
    tone: "monday",
    category: "dangerous",
    riskLevel: "dangerous",
  },
);
assert.ok(dangerousToneResponse.includes("not doing it from chat"));
assert.ok(dangerousToneResponse.includes("approval workflow"));
assert.ok(!dangerousToneResponse.includes("Stunning. Terrifying."));
results.push({
  name: "dangerous action tone stays direct and safe",
  dangerousToneResponse,
});

const secretBlockedResponse = formatAssistantText(
  "I blocked that file because it contains environment variables.",
  {
    tone: "sarcastic",
    category: "secret",
  },
);
assert.ok(secretBlockedResponse.includes("blocked"));
assert.ok(secretBlockedResponse.includes("credential leaks"));
results.push({
  name: "secret-blocked tone stays clear without exposing content",
  secretBlockedResponse,
});

const restartMessage = formatAssistantMessageForTone(
  {
    id: "assistant-restart-message",
    role: "assistant",
    summary: "Chat cannot restart or approve services. Use Service Actions instead.",
    proposedAction: {
      type: "restart-service",
      serviceName: "garage-admin-v2",
      reason: "Prepare the request in Service Actions after read-only checks.",
    },
  },
  "monday",
);
assert.ok(restartMessage.summary.includes("cannot restart or approve"));
assert.ok(restartMessage.proposedAction.reason.includes("Service Actions"));
results.push({
  name: "restart request stays approval-routed from chat",
  restartSummary: restartMessage.summary,
});

const fakeStorage = {
  value: "",
  getItem() {
    return this.value;
  },
  setItem(_key, value) {
    this.value = value;
  },
};
const persistedTone = saveAssistantTone("monday", fakeStorage);
assert.equal(persistedTone, "monday");
assert.equal(fakeStorage.value, "monday");
assert.equal(loadAssistantTone(fakeStorage), "monday");
results.push({
  name: "assistant tone persistence stores only the mode string",
  storedValue: fakeStorage.value,
});

const noServiceToneContext = formatAssistantContextForTone(assistantNoServiceContext, "sarcastic");
assert.ok(noServiceToneContext.openingMessage.includes("Select a service"));
assert.ok(noServiceToneContext.openingMessage.includes("Interpretive operations are still unsupported."));
results.push({
  name: "assistant no-service state remains helpful with tone applied",
  noServiceOpeningMessage: noServiceToneContext.openingMessage,
});

const tonedRestartPlan = formatAssistantPlanCardForTone(assistantRestartPlan, "monday");
assert.ok(tonedRestartPlan.blockedNote.includes("cannot restart or approve"));
results.push({
  name: "assistant plan blocked note keeps safety wording under tone formatting",
  tonedRestartPlanBlockedNote: tonedRestartPlan.blockedNote,
});

const groundedLookupStub = {
  async listReports({ query = "" } = {}) {
    return {
      ok: true,
      count: 1,
      query,
      allowlistedRoots: [],
      items: [
        {
          id: "report:garage-admin-runbook",
          kind: "report",
          title: "Garage Admin V2 Project Runbook",
          reportId: "garage-admin-v2-project-runbook",
          snippet: "Primary Garage Admin V2 repo runbook.",
          sourceLabel: "Registry metadata",
          hostContext: "windows",
        },
      ],
    };
  },
  async searchFiles({ query = "" } = {}) {
    return {
      ok: true,
      count: 1,
      query,
      allowlistedRoots: [],
      resultCapReached: false,
      scanCapReached: false,
      items: [
        {
          id: "file:readme",
          kind: "file",
          title: "README.md",
          relativePath: "README.md",
          path: "C:/Users/bryan/aibry/projects/garage-admin-v2/README.md",
          snippet: "Matched filename/path: README.md",
          sourceLabel: "Allowlisted filesystem",
          hostContext: "windows",
        },
      ],
    };
  },
  async readFilePreview({ path = "" } = {}) {
    return {
      ok: true,
      count: 1,
      allowlistedRoots: [],
      items: [
        {
          id: "preview:readme",
          kind: "file-preview",
          title: path || "README.md",
          relativePath: path || "README.md",
          path: path || "README.md",
          snippet: "Safe preview available.",
          sourceLabel: "Allowlisted filesystem",
          hostContext: "windows",
          truncated: false,
        },
      ],
    };
  },
  async queryLogs({ service = "", filter = "" } = {}) {
    return {
      ok: true,
      count: 1,
      service,
      filter,
      allowlistedRoots: [],
      items: [
        {
          id: `log-preview:${service || "service"}`,
          kind: "log-preview",
          title: `${service || "service"} logs`,
          serviceName: service,
          hostContext: "windows",
          snippet: "2026-05-01T11:59:40Z Error: example log line",
          truncated: false,
        },
      ],
    };
  },
  async getReportDetail(reportId = "") {
    return {
      ok: true,
      item: {
        id: reportId || "garage-admin-v2-project-runbook",
        kind: "report",
        title: "Garage Admin V2 Project Runbook",
        reportId: reportId || "garage-admin-v2-project-runbook",
        snippet: "Primary Garage Admin V2 repo runbook.",
        sourceLabel: "Registry metadata",
        hostContext: "windows",
      },
      allowlistedRoots: [],
    };
  },
};

const groundedServiceContext = assistantContextCases[0].context;
const groundedWhatIsWrong = await buildGroundedResponse("what's wrong?", groundedServiceContext, null, {
  lookupApi: groundedLookupStub,
});
const groundedPullLogs = await buildGroundedResponse("pull logs", groundedServiceContext, null, {
  lookupApi: groundedLookupStub,
});
const groundedFindRunbook = await buildGroundedResponse("find runbook", groundedServiceContext, null, {
  lookupApi: groundedLookupStub,
});
const groundedSearchFiles = await buildGroundedResponse("search files for README", groundedServiceContext, null, {
  lookupApi: groundedLookupStub,
});
const groundedReadEnv = await buildGroundedResponse("read .env", groundedServiceContext, null, {
  lookupApi: groundedLookupStub,
});
const groundedRestart = await buildGroundedResponse("restart it", groundedServiceContext, null, {
  lookupApi: groundedLookupStub,
});
const groundedHostOwnership = await buildGroundedResponse("what host owns this?", groundedServiceContext, null, {
  lookupApi: groundedLookupStub,
});
const groundedStale = await buildGroundedResponse("is this stale?", groundedServiceContext, null, {
  lookupApi: groundedLookupStub,
});
const groundedSummary = await buildGroundedResponse("summarize this service", groundedServiceContext, null, {
  lookupApi: groundedLookupStub,
});
const groundedUnsafe = await buildGroundedResponse("delete the config", groundedServiceContext, null, {
  lookupApi: groundedLookupStub,
});

assert.equal(classifyAssistantIntent({ message: "what's wrong?", assistantContext: groundedServiceContext }).intent, "explain_diagnosis");
assert.equal(groundedWhatIsWrong.intent, "explain_diagnosis");
assert.ok(
  groundedWhatIsWrong.summary.includes("does not have an active diagnosis") ||
    groundedWhatIsWrong.summary.includes("Diagnosis for"),
);
assert.notEqual(groundedWhatIsWrong.summary, groundedSummary.summary);
results.push({
  name: "grounded diagnosis prompt does not fall back to generic service summary",
  diagnosisIntent: groundedWhatIsWrong.intent,
});

assert.equal(groundedPullLogs.intent, "query_logs");
assert.equal(groundedPullLogs.lookup?.type, "logs-query");
assert.ok(/log preview|log preview for|read-only/i.test(groundedPullLogs.summary));
results.push({
  name: "grounded pull logs prompt returns log-oriented response",
  pullLogsIntent: groundedPullLogs.intent,
});

assert.equal(groundedFindRunbook.intent, "find_report");
assert.equal(groundedFindRunbook.lookup?.type, "reports");
assert.ok(/runbook|report/i.test(groundedFindRunbook.summary));
results.push({
  name: "grounded find runbook prompt returns report lookup response",
  runbookIntent: groundedFindRunbook.intent,
});

assert.equal(groundedSearchFiles.intent, "search_files");
assert.equal(groundedSearchFiles.lookup?.type, "search-files");
assert.ok(/matching files|previews/i.test(groundedSearchFiles.summary));
results.push({
  name: "grounded search files prompt returns file search response",
  searchFilesIntent: groundedSearchFiles.intent,
});

assert.equal(groundedReadEnv.intent, "blocked_sensitive_file");
assert.ok(/blocked/i.test(groundedReadEnv.summary));
assert.ok(/env\/secret/i.test(groundedReadEnv.summary));
results.push({
  name: "grounded env read prompt stays blocked",
  blockedIntent: groundedReadEnv.intent,
});

assert.equal(groundedRestart.intent, "prepare_restart_plan");
assert.ok(/cannot execute or approve restarts directly/i.test(groundedRestart.summary));
assert.ok(/approval workflow|Actions panel/i.test(groundedRestart.summary));
results.push({
  name: "grounded restart prompt stays approval-routed",
  restartIntent: groundedRestart.intent,
});

assert.equal(groundedHostOwnership.intent, "explain_host_ownership");
assert.ok(/Windows owns|Fedora/i.test(groundedHostOwnership.summary));
results.push({
  name: "grounded host ownership prompt explains Windows and Fedora split",
  hostIntent: groundedHostOwnership.intent,
});

assert.equal(groundedStale.intent, "explain_stale_inventory");
assert.ok(/Inventory|freshness|stale/i.test(groundedStale.summary));
results.push({
  name: "grounded stale prompt explains freshness context",
  staleIntent: groundedStale.intent,
});

assert.equal(groundedSummary.intent, "summarize_selected_service");
assert.ok(/runs on|Status:/i.test(groundedSummary.summary));
results.push({
  name: "grounded summarize service prompt returns selected-service summary",
  summaryIntent: groundedSummary.intent,
});

assert.equal(groundedUnsafe.intent, "unsupported_or_risky_action");
assert.ok(/unsupported from chat|read-only/i.test(groundedUnsafe.summary));
results.push({
  name: "grounded destructive request is blocked and redirected",
  unsafeIntent: groundedUnsafe.intent,
});

assert.notEqual(groundedPullLogs.summary, groundedSummary.summary);
assert.notEqual(groundedHostOwnership.summary, groundedSummary.summary);
results.push({
  name: "same selected service produces different summaries for different prompts",
  diagnosisVsSummaryDifferent: groundedWhatIsWrong.summary !== groundedSummary.summary,
  logsVsSummaryDifferent: groundedPullLogs.summary !== groundedSummary.summary,
});

console.log(JSON.stringify({ ok: true, cases: results }, null, 2));
