const assert = require("node:assert/strict");
const test = require("node:test");

const { redactText, redactValue } = require("../src/lib/outputRedaction");

test("redaction helper catches obvious text secret patterns", () => {
  const redacted = redactText(
    'token=abc123 api_key: secret123 Authorization=Bearer supersecrettoken123 x-aibry-auth=mytoken password=hunter2',
  );

  assert.equal(redacted.includes("abc123"), false);
  assert.equal(redacted.includes("secret123"), false);
  assert.equal(redacted.includes("supersecrettoken123"), false);
  assert.equal(redacted.includes("mytoken"), false);
  assert.equal(redacted.includes("hunter2"), false);
  assert.match(redacted, /<redacted>/);
});

test("redaction helper catches JSON-like secret fields", () => {
  const payload = {
    apiKey: "secret123",
    nested: {
      authorization: "Bearer verylongsecrettoken12345",
      "x-aibry-auth": "bridge-token-123",
    },
    databaseUrl: "postgresql://user:password123@example.test/app",
  };

  const redacted = redactValue(payload);
  const serialized = JSON.stringify(redacted);

  assert.equal(serialized.includes("secret123"), false);
  assert.equal(serialized.includes("verylongsecrettoken12345"), false);
  assert.equal(serialized.includes("bridge-token-123"), false);
  assert.equal(serialized.includes("password123"), false);
  assert.match(serialized, /<redacted>/);
});
