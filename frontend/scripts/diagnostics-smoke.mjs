import assert from "node:assert/strict";

import { extractServiceDiagnosis, extractServiceLogEvents } from "../src/diagnostics.js";

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
      assert.equal(events[0].relatedServiceId, "trackmaster-ui");
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
      assert.equal(events[0].relatedServiceId, "trackmaster-ui");
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
      assert.equal(events[0].relatedServiceId || "", "");
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
      assert.equal(diagnosis.correlationReason, "Matched service/process name");
      assert.equal(events[0].relatedServiceId, "trackmaster-ui");
      assert.equal(events[0].correlationReason, "Matched service/process name");
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
      assert.equal(diagnosis.correlationReason, "Fallback inference");
      assert.equal(events[0].relatedServiceId, "node-agent");
      assert.equal(events[0].correlationReason, "Fallback inference");
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

console.log(JSON.stringify({ ok: true, cases: results }, null, 2));
