const WINDOWS_RUNTIME_INVENTORY = [
  {
    id: "taskmaster-api",
    serviceName: "taskmaster-api",
    displayName: "TaskMaster API",
    host: "windows",
    manager: "pm2",
    processName: "taskmaster-api",
    serviceGroup: "api",
    serviceType: "API",
    localPort: 3101,
    localUrl: "http://127.0.0.1:3101",
    healthUrl: "http://127.0.0.1:3101/health",
    publicUrl: "https://taskmaster.aibry.shop/api",
    restartSupported: true,
    logsSupported: true,
    notes: [
      "Public API traffic is expected through the TaskMaster app route.",
    ],
  },
  {
    id: "taskmaster-app",
    serviceName: "taskmaster-app",
    displayName: "TaskMaster App",
    host: "windows",
    manager: "pm2",
    processName: "taskmaster-app",
    serviceGroup: "ui-apps",
    serviceType: "UI",
    localPort: 3100,
    localUrl: "http://127.0.0.1:3100",
    publicUrl: "https://taskmaster.aibry.shop",
    restartSupported: true,
    logsSupported: true,
    notes: [
      "Static app runtime proxies /api traffic to the local TaskMaster API.",
    ],
  },
  {
    id: "chordmaster-api",
    serviceName: "chordmaster-api",
    displayName: "ChordMaster API",
    host: "windows",
    manager: "pm2",
    processName: "chordmaster-api",
    serviceGroup: "api",
    serviceType: "API",
    localPort: 3002,
    localUrl: "http://127.0.0.1:3002",
    healthUrl: "http://127.0.0.1:3002/health",
    publicUrl: "https://api-chordmaster.aibry.shop",
    restartSupported: false,
    logsSupported: true,
    notes: [
      "PM2 process name is confirmed, but restart remains read-only in the first pass.",
    ],
  },
  {
    id: "chordmaster-ui",
    serviceName: "chordmaster-app",
    aliases: ["chordmaster-ui"],
    displayName: "ChordMaster UI",
    host: "windows",
    manager: "pm2",
    processName: "chordmaster-app",
    serviceGroup: "ui-apps",
    serviceType: "UI",
    localPort: 3200,
    localUrl: "http://127.0.0.1:3200",
    publicUrl: "https://chordmaster.aibry.shop",
    restartSupported: false,
    logsSupported: true,
    notes: [
      "Canonical service key stays chordmaster-app for logs and bridge compatibility.",
      "Restart remains read-only in the first pass.",
    ],
  },
  {
    id: "garage-admin-v2",
    serviceName: "garage-admin-v2",
    displayName: "Garage Admin V2",
    host: "windows",
    manager: "pm2",
    processName: "garage-admin-v2",
    serviceGroup: "ui-apps",
    serviceType: "Operator Console",
    localPort: 4010,
    localUrl: "http://127.0.0.1:4010",
    healthUrl: "http://127.0.0.1:4010/health",
    provides: [
      {
        kind: "http",
        endpoint: "http://127.0.0.1:4010",
        healthEndpoint: "http://127.0.0.1:4010/health",
        notes: "Windows PM2 operator-console runtime.",
      },
    ],
    restartSupported: false,
    logsSupported: true,
    notes: [
      "Self-restart is intentionally disabled to avoid operator lockout during first-pass inventory work.",
    ],
  },
  {
    id: "aibry-masterclass-landing",
    serviceName: "aibry-masterclass-landing",
    displayName: "AIBRY Masterclass Landing",
    host: "windows",
    manager: "pm2",
    processName: "aibry-masterclass-landing",
    serviceGroup: "ui-apps",
    serviceType: "UI",
    localPort: 8083,
    localUrl: "http://127.0.0.1:8083",
    publicUrl: "https://apps.aibry.shop",
    restartSupported: true,
    logsSupported: true,
    notes: [
      "Fedora nginx proxies apps.aibry.shop to this Windows-hosted PM2 runtime.",
    ],
  },
  {
    id: "trackmaster-api",
    serviceName: "trackmaster-api",
    displayName: "TrackMaster API",
    host: "windows",
    manager: "pm2",
    processName: "trackmaster-api",
    serviceGroup: "api",
    serviceType: "API",
    localPort: 3004,
    localUrl: "http://127.0.0.1:3004",
    healthUrl: "http://127.0.0.1:3004/api/health",
    readinessUrl: "http://127.0.0.1:3004/api/readiness",
    publicUrl: "https://trackmaster.aibry.shop/api",
    provides: [
      {
        kind: "http",
        endpoint: "http://127.0.0.1:3004",
        healthEndpoint: "http://127.0.0.1:3004/api/health",
        readinessEndpoint: "http://127.0.0.1:3004/api/readiness",
        publicHost: "trackmaster-api.aibry.shop",
        paths: ["/api"],
        notes: "Windows PM2 TrackMaster API runtime.",
      },
    ],
    restartSupported: true,
    logsSupported: true,
    notes: [
      "Windows PM2 owns the live TrackMaster API runtime; Fedora remains responsible for Postgres, Cloudflare ingress, backups, and control-plane duties.",
      "The API uses Fedora Postgres database trackmaster_production through the current runtime role aibry pending least-privilege hardening.",
      "Public API routing also includes https://trackmaster-api.aibry.shop/api.",
    ],
  },
  {
    id: "trackmaster-ui",
    serviceName: "trackmaster-ui",
    displayName: "TrackMaster UI",
    host: "windows",
    manager: "pm2",
    processName: "trackmaster-ui",
    serviceGroup: "ui-apps",
    serviceType: "UI",
    localPort: 3000,
    localUrl: "http://127.0.0.1:3000",
    healthUrl: "http://127.0.0.1:3000/",
    publicUrl: "https://trackmaster.aibry.shop",
    provides: [
      {
        kind: "static-ui",
        endpoint: "http://127.0.0.1:3000",
        publicHost: "trackmaster.aibry.shop",
        paths: ["/"],
        notes: "Windows PM2 TrackMaster UI runtime.",
      },
    ],
    dependencies: [
      {
        serviceId: "trackmaster-api",
        relationship: "calls-api",
        endpoint: "http://127.0.0.1:3004/api/health",
        required: true,
        confidence: "authoritative",
        notes: "UI depends on the Windows-local TrackMaster API runtime.",
      },
    ],
    restartSupported: true,
    logsSupported: true,
    notes: [
      "Windows PM2 owns the live TrackMaster UI runtime.",
      "Cloudflare routes the public UI here and forwards /api traffic to the Windows TrackMaster API runtime.",
    ],
  },
  {
    id: "trackmaster-comparator",
    serviceName: "trackmaster-comparator",
    displayName: "TrackMaster Comparator",
    host: "windows",
    manager: "pm2",
    processName: "trackmaster-comparator",
    serviceGroup: "ui-apps",
    serviceType: "UI",
    localPort: 8081,
    localUrl: "http://127.0.0.1:8081",
    publicUrl: "https://comparator.aibry.shop",
    restartSupported: true,
    logsSupported: true,
    notes: [
      "No dedicated health endpoint is modeled yet; local HTTP and port reachability are used.",
    ],
  },
];

function serviceKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

const LOOKUP = WINDOWS_RUNTIME_INVENTORY.reduce((map, definition) => {
  const keys = new Set([
    definition.id,
    definition.serviceName,
    definition.processName,
    ...(Array.isArray(definition.aliases) ? definition.aliases : []),
  ]);

  keys.forEach((key) => {
    const normalized = serviceKey(key);
    if (normalized) {
      map.set(normalized, definition);
    }
  });

  return map;
}, new Map());

function getWindowsRuntimeDefinition(serviceName) {
  return LOOKUP.get(serviceKey(serviceName)) || null;
}

function getWindowsRuntimeDefinitions() {
  return WINDOWS_RUNTIME_INVENTORY;
}

function getWindowsProcessNames() {
  return Array.from(new Set(WINDOWS_RUNTIME_INVENTORY.map((definition) => definition.processName).filter(Boolean)));
}

function isWindowsRuntime(serviceName) {
  return Boolean(getWindowsRuntimeDefinition(serviceName));
}

function isWindowsRestartSupported(serviceName) {
  return Boolean(getWindowsRuntimeDefinition(serviceName)?.restartSupported);
}

module.exports = {
  WINDOWS_RUNTIME_INVENTORY,
  getWindowsProcessNames,
  getWindowsRuntimeDefinition,
  getWindowsRuntimeDefinitions,
  isWindowsRestartSupported,
  isWindowsRuntime,
};
