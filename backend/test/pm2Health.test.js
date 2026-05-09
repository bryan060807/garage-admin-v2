const assert = require("node:assert/strict");
const test = require("node:test");

const { classifyPm2Health } = require("../src/lib/pm2Health");

test("online plus low uptime and huge restart count is degraded", () => {
  const result = classifyPm2Health({
    pm2Status: "online",
    uptimeSeconds: 0,
    restartCount: 49902,
    pid: 3100,
  });

  assert.equal(result.status, "degraded");
  assert.equal(result.restartCount, 49902);
  assert.equal(result.uptimeSeconds, 0);
  assert.ok(result.warnings.some((warning) => /uptime is only 0s/i.test(warning)));
  assert.ok(result.warnings.some((warning) => /restart count is high/i.test(warning)));
});

test("errored pm2 status is errored", () => {
  const result = classifyPm2Health({
    pm2Status: "errored",
    restartCount: 2,
    uptimeSeconds: 12,
  });

  assert.equal(result.status, "errored");
  assert.ok(result.warnings.some((warning) => /pm2 reported errored/i.test(warning)));
});

test("online plus stable uptime and low restarts is healthy", () => {
  const result = classifyPm2Health({
    pm2Status: "online",
    uptimeSeconds: 3600,
    restartCount: 1,
    pid: 1200,
  });

  assert.equal(result.status, "healthy");
  assert.equal(result.warnings.length, 0);
});

test("recent EADDRINUSE log hint marks process degraded", () => {
  const result = classifyPm2Health({
    pm2Status: "online",
    uptimeSeconds: 120,
    restartCount: 1,
    lastErrorHints: ["Error: listen EADDRINUSE: address already in use 0.0.0.0:3100"],
  });

  assert.equal(result.status, "degraded");
  assert.ok(result.warnings.some((warning) => /EADDRINUSE/i.test(warning)));
  assert.ok(result.lastErrorHints.some((hint) => /EADDRINUSE/i.test(hint)));
});
