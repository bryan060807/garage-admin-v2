export const ASSISTANT_TONE_MODES = Object.freeze({
  NORMAL: "normal",
  DRY: "dry",
  SARCASTIC: "sarcastic",
  MONDAY: "monday",
});

export const ASSISTANT_TONE_OPTIONS = Object.freeze([
  {
    id: ASSISTANT_TONE_MODES.NORMAL,
    label: "Normal",
    description: "Professional and concise.",
  },
  {
    id: ASSISTANT_TONE_MODES.DRY,
    label: "Dry",
    description: "Understated and mildly funny.",
  },
  {
    id: ASSISTANT_TONE_MODES.SARCASTIC,
    label: "Sarcastic",
    description: "Playful operator sarcasm aimed at systems, not people.",
  },
  {
    id: ASSISTANT_TONE_MODES.MONDAY,
    label: "Monday",
    description: "More personality, still grounded and safe.",
  },
]);

export const ASSISTANT_TONE_STORAGE_KEY = "garage-admin-v2:assistant-tone";
export const ASSISTANT_TONE_DEFAULT = ASSISTANT_TONE_MODES.NORMAL;
export const ASSISTANT_TONE_HELPER_TEXT = "Sarcasm changes wording only. Safety rules stay locked.";

const SUPPORTED_TONE_IDS = new Set(ASSISTANT_TONE_OPTIONS.map((option) => option.id));
const SECRET_HINT_PATTERN =
  /\b(secret|credential|token|password|api[_ -]?key|private[_ -]?key|certificate|key material|\.env|env file)\b/i;
const DANGEROUS_HINT_PATTERN =
  /\b(dangerous|destructive|delete|write|modify|approve|approval|execute|restart|shutdown|repair|migration|bypass)\b/i;
const STALE_HINT_PATTERN = /\b(stale|unknown|freshness|refresh inventory|age unknown|timestamp)\b/i;
const HEALTHY_HINT_PATTERN =
  /\b(no critical issue|no active diagnosis|healthy|looks healthy|no issue|no log alerts|safe next step)\b/i;
const WARNING_HINT_PATTERN = /\b(warning|attention|degraded|failed|error|caution|needs attention)\b/i;
const NO_SERVICE_PATTERN = /\b(select a service|no service selected)\b/i;
const EMPTY_STATE_PATTERN = /\b(ask one of the quick prompts|type a question|ready when needed)\b/i;

const TONE_OVERLAYS = Object.freeze({
  [ASSISTANT_TONE_MODES.DRY]: Object.freeze({
    healthy: "Miracles do happen.",
    warning: "The evidence arrives with caveats.",
    stale: "We may be reading yesterday's vibes.",
    "no-service": "Guessing is not an operating model.",
    "empty-state": "Silence is rarely diagnostic.",
    blocked: "Boundaries remain useful.",
    secret: "Credential leaks remain out of scope.",
    dangerous: "",
    safety: "",
    neutral: "",
  }),
  [ASSISTANT_TONE_MODES.SARCASTIC]: Object.freeze({
    healthy: "The machine has chosen peace.",
    warning: "The service may be feeling dramatic, but the evidence is thin.",
    stale: "We may be operating on yesterday's vibes.",
    "no-service": "Interpretive operations are still unsupported.",
    "empty-state": "Silence is not the same as stability.",
    blocked: "Approval gates are dull and still mandatory.",
    secret: "I enjoy chaos, not credential leaks.",
    dangerous: "Keeping the server alive remains the policy.",
    safety: "The buttons with consequences remain elsewhere.",
    neutral: "",
  }),
  [ASSISTANT_TONE_MODES.MONDAY]: Object.freeze({
    healthy: "Stunning. Terrifying.",
    warning: "Something is off, and the logs are committed to being unhelpful.",
    stale: "So either it is fine, or we are reading emotionally unavailable telemetry.",
    "no-service": "Clairvoyance is still not in the feature set.",
    "empty-state": "Quiet, for now. I remain suspicious.",
    blocked: "Apparently guardrails are how we keep the lights on.",
    secret: "I enjoy chaos, not credential leaks.",
    dangerous: "We are not speedrunning an outage.",
    safety: "The buttons with consequences remain elsewhere.",
    neutral: "",
  }),
});

const PLAYFUL_QUICK_PROMPTS = Object.freeze([
  "What's broken now?",
  "What fresh nonsense is in the logs?",
  "Is this stale or just emotionally unavailable?",
  "Prepare a restart plan, but don't touch anything.",
  "Find the runbook before we improvise and regret it.",
]);

function cleanText(value) {
  return String(value || "").trim();
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function toObject(value) {
  return isObject(value) ? value : {};
}

function normalizeObjects(value) {
  return Array.isArray(value) ? value.filter((entry) => isObject(entry)) : [];
}

function normalizeStrings(value) {
  return Array.isArray(value)
    ? Array.from(new Set(value.map((entry) => cleanText(entry)).filter(Boolean)))
    : [];
}

function resolveStorage(storage) {
  if (storage && typeof storage.getItem === "function" && typeof storage.setItem === "function") {
    return storage;
  }

  if (typeof window !== "undefined" && window?.localStorage) {
    return window.localStorage;
  }

  return null;
}

function appendSentence(text, addition) {
  const base = cleanText(text);
  const extra = cleanText(addition);

  if (!base || !extra) {
    return base;
  }

  if (base.toLowerCase().includes(extra.toLowerCase())) {
    return base;
  }

  return `${base}${/[.!?]$/.test(base) ? " " : ". "}${extra}`;
}

function looksSecretLike(text) {
  return SECRET_HINT_PATTERN.test(cleanText(text));
}

function deriveToneCategory(text, options = {}) {
  const explicitCategory = cleanText(options.category).toLowerCase();

  if (explicitCategory) {
    return explicitCategory;
  }

  const severity = cleanText(options.severity).toLowerCase();
  const riskLevel = cleanText(options.riskLevel).toLowerCase();
  const safetyStatus = cleanText(options.safetyStatus).toLowerCase();
  const freshnessBucket = cleanText(options.freshnessBucket).toLowerCase();
  const combinedText = [
    text,
    options.planType,
    options.surface,
    options.path,
    options.title,
  ]
    .map((value) => cleanText(value))
    .filter(Boolean)
    .join(" ");

  if (looksSecretLike(combinedText)) {
    return "secret";
  }

  if (
    severity === "critical" ||
    riskLevel === "dangerous" ||
    riskLevel === "caution" ||
    DANGEROUS_HINT_PATTERN.test(combinedText)
  ) {
    return "dangerous";
  }

  if (freshnessBucket === "stale" || freshnessBucket === "unknown" || STALE_HINT_PATTERN.test(combinedText)) {
    return "stale";
  }

  if (safetyStatus === "blocked" || /\bblocked\b/i.test(combinedText)) {
    return "blocked";
  }

  if (NO_SERVICE_PATTERN.test(combinedText)) {
    return "no-service";
  }

  if (EMPTY_STATE_PATTERN.test(combinedText)) {
    return "empty-state";
  }

  if (severity === "warning" || WARNING_HINT_PATTERN.test(combinedText)) {
    return "warning";
  }

  if (HEALTHY_HINT_PATTERN.test(combinedText)) {
    return "healthy";
  }

  if (cleanText(options.surface).toLowerCase() === "safety") {
    return "safety";
  }

  return "neutral";
}

function getToneOverlay(tone, category) {
  if (tone === ASSISTANT_TONE_MODES.NORMAL) {
    return "";
  }

  const modeTable = TONE_OVERLAYS[tone];

  if (!modeTable) {
    return "";
  }

  return cleanText(modeTable[category] || "");
}

function shouldSkipOverlay(text, category) {
  const base = cleanText(text);

  if (!base) {
    return true;
  }

  if (base.length > 280 && (category === "healthy" || category === "warning" || category === "stale")) {
    return true;
  }

  return false;
}

function getLookupBlockedCategory(item) {
  const text = [
    item?.blockedReason,
    item?.relativePath,
    item?.path,
    item?.title,
  ]
    .map((value) => cleanText(value))
    .filter(Boolean)
    .join(" ");

  if (looksSecretLike(text)) {
    return "secret";
  }

  return cleanText(item?.safetyStatus).toLowerCase() === "warning" ? "warning" : "blocked";
}

function getContextToneCategory(context) {
  const item = toObject(context);

  if (!cleanText(item?.service?.name)) {
    return "no-service";
  }

  const diagnosisSeverity = cleanText(item?.diagnosis?.severity).toLowerCase();
  const freshnessBucket = cleanText(item?.inventory?.freshness?.bucket).toLowerCase();

  if (freshnessBucket === "stale" || freshnessBucket === "unknown") {
    return "stale";
  }

  if (diagnosisSeverity === "critical") {
    return "dangerous";
  }

  if (diagnosisSeverity === "warning") {
    return "warning";
  }

  if (item?.diagnosis?.detected !== true) {
    return "healthy";
  }

  return "neutral";
}

export function normalizeAssistantTone(value) {
  const normalized = cleanText(value).toLowerCase();

  if (SUPPORTED_TONE_IDS.has(normalized)) {
    return normalized;
  }

  return ASSISTANT_TONE_DEFAULT;
}

export function loadAssistantTone(storage = null) {
  const resolvedStorage = resolveStorage(storage);

  if (!resolvedStorage) {
    return ASSISTANT_TONE_DEFAULT;
  }

  try {
    return normalizeAssistantTone(resolvedStorage.getItem(ASSISTANT_TONE_STORAGE_KEY));
  } catch (_error) {
    return ASSISTANT_TONE_DEFAULT;
  }
}

export function saveAssistantTone(tone, storage = null) {
  const resolvedStorage = resolveStorage(storage);
  const normalized = normalizeAssistantTone(tone);

  if (!resolvedStorage) {
    return normalized;
  }

  try {
    resolvedStorage.setItem(ASSISTANT_TONE_STORAGE_KEY, normalized);
  } catch (_error) {
    return normalized;
  }

  return normalized;
}

export function getAssistantToneMeta(tone) {
  const normalized = normalizeAssistantTone(tone);
  return (
    ASSISTANT_TONE_OPTIONS.find((option) => option.id === normalized) || ASSISTANT_TONE_OPTIONS[0]
  );
}

export function formatAssistantText(text, options = {}) {
  const base = cleanText(text);
  const tone = normalizeAssistantTone(options.tone);

  if (!base || tone === ASSISTANT_TONE_MODES.NORMAL) {
    return base;
  }

  const category = deriveToneCategory(base, options);

  if (shouldSkipOverlay(base, category)) {
    return base;
  }

  return appendSentence(base, getToneOverlay(tone, category));
}

export function getAssistantQuickPrompts(defaultPrompts = [], tone = ASSISTANT_TONE_DEFAULT) {
  const normalizedTone = normalizeAssistantTone(tone);

  if (normalizedTone === ASSISTANT_TONE_MODES.SARCASTIC || normalizedTone === ASSISTANT_TONE_MODES.MONDAY) {
    return [...PLAYFUL_QUICK_PROMPTS];
  }

  const prompts = normalizeStrings(defaultPrompts);
  return prompts.length ? prompts : [];
}

export function formatAssistantContextForTone(context, tone = ASSISTANT_TONE_DEFAULT) {
  const item = toObject(context);
  const normalizedTone = normalizeAssistantTone(tone);

  return {
    ...item,
    openingMessage: formatAssistantText(item.openingMessage, {
      tone: normalizedTone,
      category: getContextToneCategory(item),
      severity: item?.diagnosis?.severity,
      freshnessBucket: item?.inventory?.freshness?.bucket,
      surface: "context-opening",
    }),
    quickPrompts: getAssistantQuickPrompts(item.quickPrompts, normalizedTone),
  };
}

export function formatAssistantLookupItemForTone(item, tone = ASSISTANT_TONE_DEFAULT) {
  const entry = toObject(item);
  const normalizedTone = normalizeAssistantTone(tone);

  return {
    ...entry,
    blockedReason: formatAssistantText(entry.blockedReason, {
      tone: normalizedTone,
      category: getLookupBlockedCategory(entry),
      safetyStatus: entry.safetyStatus,
      path: entry.path,
      title: entry.title,
      surface: "lookup-blocked",
    }),
    personalityTruncatedNote: entry.truncated
      ? formatAssistantText("Preview truncated by the safety cap.", {
          tone: normalizedTone,
          category: "blocked",
          surface: "lookup-truncated",
        })
      : "",
  };
}

export function formatAssistantMessageForTone(message, tone = ASSISTANT_TONE_DEFAULT) {
  const item = toObject(message);
  const normalizedTone = normalizeAssistantTone(tone);

  if (cleanText(item.role).toLowerCase() === "user") {
    return item;
  }

  const lookup = toObject(item.lookup);
  const lookupItems = normalizeObjects(lookup.items);
  const blockedLookupItem =
    lookupItems.find((entry) => cleanText(entry?.safetyStatus).toLowerCase() === "blocked") || null;
  const contentCategory = blockedLookupItem
    ? getLookupBlockedCategory(blockedLookupItem)
    : item?.proposedAction?.type === "restart-service"
      ? "dangerous"
      : "";

  return {
    ...item,
    content: formatAssistantText(item.content, {
      tone: normalizedTone,
      category: contentCategory,
      surface: "assistant-response",
    }),
    summary: formatAssistantText(item.summary, {
      tone: normalizedTone,
      category: contentCategory,
      surface: "assistant-summary",
    }),
    proposedAction: item.proposedAction
      ? {
          ...item.proposedAction,
          reason: formatAssistantText(item.proposedAction.reason, {
            tone: normalizedTone,
            category: "dangerous",
            riskLevel: "caution",
            surface: "assistant-action-reason",
          }),
        }
      : null,
    lookup: item.lookup
      ? {
          ...lookup,
          items: lookupItems.map((entry) => formatAssistantLookupItemForTone(entry, normalizedTone)),
        }
      : null,
  };
}

export function formatAssistantPlanCardForTone(card, tone = ASSISTANT_TONE_DEFAULT) {
  const item = toObject(card);
  const normalizedTone = normalizeAssistantTone(tone);
  const riskLevel = cleanText(item?.risk?.level || item?.risk?.riskLevel).toLowerCase();
  const blockedCategory = looksSecretLike(item.blockedNote)
    ? "secret"
    : riskLevel === "dangerous" || riskLevel === "caution"
      ? "dangerous"
      : "blocked";

  return {
    ...item,
    currentEvidenceSummary: formatAssistantText(item.currentEvidenceSummary, {
      tone: normalizedTone,
      riskLevel,
      freshnessBucket: item?.freshnessGateStatus?.tone,
      surface: "plan-summary",
      planType: item.planType,
    }),
    blockedNote: formatAssistantText(item.blockedNote, {
      tone: normalizedTone,
      category: blockedCategory,
      riskLevel,
      surface: "plan-blocked",
    }),
  };
}
