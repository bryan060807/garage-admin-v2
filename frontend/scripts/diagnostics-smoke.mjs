import assert from "node:assert/strict";

import { buildActionApprovalContext, evaluateApprovalFreshnessGate } from "../src/actionApproval.js";
import { getActionRiskProfile, shouldShowActionApprovalPreview } from "../src/actionRisk.js";
import {
  buildDependencyHealthRollup,
  classifyDependencyFreshness,
  classifyInventoryFreshness,
  describeInventoryFreshness,
} from "../src/dependencyHealth.js";
import { extractServiceDiagnosis, extractServiceLogEvents } from "../src/diagnostics.js";

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

console.log(JSON.stringify({ ok: true, cases: results }, null, 2));
