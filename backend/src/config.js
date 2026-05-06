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
  port: coerceNumber(process.env.PORT, 4010),
  host: process.env.HOST || "0.0.0.0",
  frontendOrigin: process.env.FRONTEND_ORIGIN || "*",
  databaseUrl: process.env.GARAGE_ADMIN_DATABASE_URL || process.env.DATABASE_URL || "",
  databaseHost: process.env.GARAGE_ADMIN_DATABASE_HOST || process.env.DATABASE_HOST || "",
  databasePort: process.env.GARAGE_ADMIN_DATABASE_PORT || process.env.DATABASE_PORT || "",
  bridgeBaseUrl: process.env.ADMIN_BRIDGE_BASE_URL || "",
  bridgeToken: process.env.ADMIN_BRIDGE_TOKEN || "",
  bridgeTimeoutMs: coerceNumber(process.env.ADMIN_BRIDGE_TIMEOUT_MS, 10000),
  bridgeActionTimeoutMs: coerceNumber(process.env.ADMIN_BRIDGE_ACTION_TIMEOUT_MS, 30000),
  windowsAdminBaseUrl: process.env.WINDOWS_ADMIN_BASE_URL || "",
  windowsAdminAuthToken: process.env.WINDOWS_ADMIN_AUTH_TOKEN || "",
  windowsGarageBaseUrl: process.env.WINDOWS_GARAGE_BASE_URL || "",
  windowsGarageApiKey: process.env.WINDOWS_GARAGE_API_KEY || "",
  windowsBridgeTimeoutMs: coerceNumber(process.env.WINDOWS_BRIDGE_TIMEOUT_MS, 7000),
  chatkitSessionTimeoutMs: coerceNumber(process.env.CHATKIT_SESSION_TIMEOUT_MS, 8000),
  windowsExecutorTimeoutMs: coerceNumber(process.env.WINDOWS_EXECUTOR_TIMEOUT_MS, 30000),
  windowsVerificationTimeoutMs: coerceNumber(process.env.WINDOWS_VERIFICATION_TIMEOUT_MS, 5000),
};
