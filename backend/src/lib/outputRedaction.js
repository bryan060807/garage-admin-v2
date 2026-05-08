const SECRET_PATTERNS = [
  {
    pattern:
      /(["']?)(token|secret|password|credential|api[-_ ]?key|access[-_ ]?key|refresh[-_ ]?token)(["']?)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,}\]]+)/gi,
    replacement: "$1$2$3: <redacted>",
  },
  {
    pattern: /(["']?)(x-aibry-auth|x-api-key|authorization)(["']?)\s*[:=]\s*(?:"[^"]*"|'[^']*'|Bearer\s+[^\s"'`]+|[^\s,}\]]+)/gi,
    replacement: "$1$2$3: <redacted>",
  },
  {
    pattern: /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    replacement: "Bearer <redacted>",
  },
  {
    pattern: /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^:\s/]+:[^@\s/]+@/gi,
    replacement: "<redacted-scheme>://<redacted>:<redacted>@",
  },
  {
    pattern: /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g,
    replacement: "<redacted-private-material>",
  },
];
const SENSITIVE_OBJECT_KEY_PATTERN =
  /^(token|secret|password|credential|api[-_ ]?key|access[-_ ]?key|refresh[-_ ]?token|x-aibry-auth|x-api-key|authorization)$/i;

function redactText(value) {
  let text = String(value ?? "");

  SECRET_PATTERNS.forEach(({ pattern, replacement }) => {
    text = text.replace(pattern, replacement);
  });

  return text;
}

function redactValue(value) {
  if (typeof value === "string") {
    return redactText(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, SENSITIVE_OBJECT_KEY_PATTERN.test(key) ? "<redacted>" : redactValue(entry)]),
    );
  }

  return value;
}

module.exports = {
  redactText,
  redactValue,
};
