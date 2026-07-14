const path = require("path");
const dotenv = require("dotenv");

dotenv.config({
  path: path.resolve(__dirname, "../../.env"),
});

function coerceNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

module.exports = {
  port: coerceNumber(process.env.PORT, 3010),
  host: process.env.HOST || "0.0.0.0",
  frontendOrigin: process.env.FRONTEND_ORIGIN || "*",
  databaseUrl: process.env.GARAGE_ADMIN_DATABASE_URL || process.env.DATABASE_URL || "",
  databaseHost: "fedora.local",
  databasePort: process.env.GARAGE_ADMIN_DATABASE_PORT || process.env.DATABASE_PORT || "",
  databaseConnectTimeoutMs: coerceNumber(process.env.GARAGE_ADMIN_DATABASE_CONNECT_TIMEOUT_MS, 1500),
  databaseQueryTimeoutMs: coerceNumber(process.env.GARAGE_ADMIN_DATABASE_QUERY_TIMEOUT_MS, 2500),
  databaseStatementTimeoutMs: coerceNumber(process.env.GARAGE_ADMIN_DATABASE_STATEMENT_TIMEOUT_MS, 2500),
  databaseIdleTimeoutMs: coerceNumber(process.env.GARAGE_ADMIN_DATABASE_IDLE_TIMEOUT_MS, 10000),
  databasePoolMax: coerceNumber(process.env.GARAGE_ADMIN_DATABASE_POOL_MAX, 4),
  memoryReadTimeoutMs: coerceNumber(process.env.GARAGE_ADMIN_MEMORY_READ_TIMEOUT_MS, 4500),
  memoryApplyTimeoutMs: coerceNumber(process.env.GARAGE_ADMIN_MEMORY_APPLY_TIMEOUT_MS, 30000),
  garageMemoryRoot: process.env.GARAGE_MEMORY_ROOT || path.join(process.env.USERPROFILE || process.env.HOME || "", "aibry", "garage_admin_memory"),
  garageMemoryCommand: process.env.GARAGE_MEMORY_COMMAND || "garage-memory",
  garageMemoryWorkerRoot:
    process.env.GARAGE_MEMORY_WORKER_ROOT ||
    path.join(process.env.USERPROFILE || process.env.HOME || "", "aibry", "garage_admin_memory", "garage_memory_workers"),
  bridgeBaseUrl: process.env.ADMIN_BRIDGE_BASE_URL || "",
  bridgeToken: process.env.ADMIN_BRIDGE_TOKEN || "",
  bridgeTimeoutMs: coerceNumber(process.env.ADMIN_BRIDGE_TIMEOUT_MS, 10000),
  bridgeActionTimeoutMs: coerceNumber(process.env.ADMIN_BRIDGE_ACTION_TIMEOUT_MS, 30000),
  windowsAdminBaseUrl: process.env.WINDOWS_ADMIN_BASE_URL || "",
  windowsAdminAuthToken: process.env.WINDOWS_ADMIN_AUTH_TOKEN || "",
  windowsGarageBaseUrl: process.env.WINDOWS_GARAGE_BASE_URL || "",
  windowsGarageLoopbackBaseUrl: process.env.WINDOWS_GARAGE_LOOPBACK_BASE_URL || "http://127.0.0.1:5100",
  windowsGarageApiKey: process.env.WINDOWS_GARAGE_API_KEY || "",
  windowsBridgeTimeoutMs: coerceNumber(process.env.WINDOWS_BRIDGE_TIMEOUT_MS, 7000),
  chatkitSessionTimeoutMs: coerceNumber(process.env.CHATKIT_SESSION_TIMEOUT_MS, 20000),
  windowsExecutorTimeoutMs: coerceNumber(process.env.WINDOWS_EXECUTOR_TIMEOUT_MS, 30000),
  windowsVerificationTimeoutMs: coerceNumber(process.env.WINDOWS_VERIFICATION_TIMEOUT_MS, 5000),
  websiteApiBaseUrl: String(process.env.AIBRY_WEBSITE_API_BASE_URL || "https://aibry.shop").replace(/\/+$/, ""),
  websiteApiInternalToken: process.env.AIBRY_WEBSITE_INTERNAL_ADMIN_TOKEN || process.env.AIBRY_BACKEND_INTERNAL_TOKEN || "",
  websiteApiTimeoutMs: coerceNumber(process.env.AIBRY_WEBSITE_API_TIMEOUT_MS, 8000),
  pm2MinHealthyUptimeSeconds: coerceNumber(process.env.PM2_MIN_HEALTHY_UPTIME_SECONDS, 30),
  pm2FlappingRestartThreshold: coerceNumber(process.env.PM2_FLAPPING_RESTART_THRESHOLD, 5),
  pm2HighRestartThreshold: coerceNumber(process.env.PM2_HIGH_RESTART_THRESHOLD, 20),
  terminalSshEnabled: String(process.env.GARAGE_ADMIN_TERMINAL_SSH_ENABLED || "false").toLowerCase() === "true",
};
