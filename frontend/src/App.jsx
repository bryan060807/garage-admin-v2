import { Component, useEffect, useRef, useState } from "react";
import {
  buildActionApprovalContext,
  buildActionApprovalContextFromReviewSnapshot,
  buildActionReviewSnapshot,
  evaluateApprovalFreshnessGate,
  formatApprovalFreshnessSummary,
  selectActionReviewSnapshot,
} from "./actionApproval";
import { formatActionTypeLabel, getActionRiskProfile, shouldShowActionApprovalPreview } from "./actionRisk";
import { buildAssistantContext, buildAssistantRequestPayload } from "./assistantContext";
import { ASSISTANT_LOOKUP_CHIPS, buildAssistantLookupInvocation, createAssistantSelection } from "./assistantLookup";
import {
  ASSISTANT_TONE_HELPER_TEXT,
  ASSISTANT_TONE_OPTIONS,
  formatAssistantContextForTone,
  formatAssistantMessageForTone,
  formatAssistantPlanCardForTone,
  formatAssistantText,
  getAssistantToneMeta,
  loadAssistantTone,
  normalizeAssistantTone,
  saveAssistantTone,
} from "./assistantPersonality.js";
import { ASSISTANT_PLAN_CHIPS, buildAssistantPlanCards } from "./assistantPlans";
import { buildDependencyHealthRollup, describeInventoryFreshness } from "./dependencyHealth";
import { extractServiceDiagnosis } from "./diagnostics";

const RIGHT_PANEL_SPLIT_STORAGE_KEY = "garage-admin-v2:right-panel-split";
const LAYOUT_CUSTOMIZATION_VERSION = 1;
const LAYOUT_CUSTOMIZATION_STORAGE_KEY = `garage-admin-v2:experimental-layout:v${LAYOUT_CUSTOMIZATION_VERSION}`;
const ASSISTANT_MODE_STORAGE_KEY = "garage-admin-v2:assistant-mode";
const ASSISTANT_LAUNCHER_POSITION_STORAGE_KEY = "garage-admin-v2:assistant-launcher-position";
const ASSISTANT_MODES = Object.freeze({
  MINIMIZED: "minimized",
  DOCKED: "docked",
  EXPANDED: "expanded",
});
const ASSISTANT_LAUNCHER_POSITIONS = Object.freeze({
  BOTTOM_RIGHT: "bottom-right",
  RIGHT_CENTER: "right-center",
  BOTTOM_CENTER: "bottom-center",
});
const ASSISTANT_LAUNCHER_POSITION_ORDER = [
  ASSISTANT_LAUNCHER_POSITIONS.RIGHT_CENTER,
  ASSISTANT_LAUNCHER_POSITIONS.BOTTOM_RIGHT,
  ASSISTANT_LAUNCHER_POSITIONS.BOTTOM_CENTER,
];
const ASSISTANT_LAUNCHER_POSITION_META = {
  [ASSISTANT_LAUNCHER_POSITIONS.BOTTOM_RIGHT]: {
    label: "Bottom right",
    shortLabel: "BR",
  },
  [ASSISTANT_LAUNCHER_POSITIONS.RIGHT_CENTER]: {
    label: "Right center",
    shortLabel: "RC",
  },
  [ASSISTANT_LAUNCHER_POSITIONS.BOTTOM_CENTER]: {
    label: "Bottom center",
    shortLabel: "BC",
  },
};
const WORKSPACE_TABS = Object.freeze([
  { id: "overview", label: "Overview" },
  { id: "actions", label: "Actions" },
  { id: "workers", label: "Workers" },
  { id: "assistant", label: "Assistant" },
  { id: "evidence", label: "Logs / Evidence" },
]);

const ENABLE_EXPERIMENTAL_LAYOUT_CUSTOMIZATION = ["1", "true", "yes", "on"].includes(
  String(import.meta.env.VITE_ENABLE_EXPERIMENTAL_LAYOUT_CUSTOMIZATION || "").toLowerCase(),
);
const DEFAULT_RIGHT_PANEL_SPLIT = 0.45;
const RIGHT_PANEL_MIN_PX = 240;
const RIGHT_PANEL_RESIZER_PX = 12;
const DEFAULT_RIGHT_PANEL_ORDER = ["actions", "audit"];
const RIGHT_PANEL_CARD_IDS = new Set(DEFAULT_RIGHT_PANEL_ORDER);
const RIGHT_PANEL_CARD_LABELS = {
  actions: "Actions",
  audit: "Recent Audit",
};

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function clampRightPanelSplit(value, containerHeight = 0) {
  if (!Number.isFinite(value)) {
    return DEFAULT_RIGHT_PANEL_SPLIT;
  }

  const fallbackMin = 0.18;
  const fallbackMax = 0.82;

  if (!containerHeight) {
    return clamp(value, fallbackMin, fallbackMax);
  }

  const availableHeight = Math.max(containerHeight - RIGHT_PANEL_RESIZER_PX, 1);

  if (availableHeight <= RIGHT_PANEL_MIN_PX * 2) {
    return 0.5;
  }

  const minRatio = RIGHT_PANEL_MIN_PX / availableHeight;
  const maxRatio = 1 - minRatio;

  return clamp(value, minRatio, maxRatio);
}

function loadRightPanelSplit() {
  try {
    if (typeof window === "undefined") {
      return DEFAULT_RIGHT_PANEL_SPLIT;
    }

    const stored = window.localStorage.getItem(RIGHT_PANEL_SPLIT_STORAGE_KEY);
    const parsed = Number(stored);

    if (Number.isFinite(parsed)) {
      return clampRightPanelSplit(parsed);
    }
  } catch (_error) {
    return DEFAULT_RIGHT_PANEL_SPLIT;
  }

  return DEFAULT_RIGHT_PANEL_SPLIT;
}

function saveRightPanelSplit(value) {
  try {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(RIGHT_PANEL_SPLIT_STORAGE_KEY, String(value));
    }
  } catch (_error) {
    // localStorage can be unavailable in locked-down browser contexts.
  }
}

function normalizeRightPanelOrder(order) {
  if (!Array.isArray(order)) {
    return [...DEFAULT_RIGHT_PANEL_ORDER];
  }

  const next = [];

  order.forEach((cardId) => {
    if (RIGHT_PANEL_CARD_IDS.has(cardId) && !next.includes(cardId)) {
      next.push(cardId);
    }
  });

  DEFAULT_RIGHT_PANEL_ORDER.forEach((cardId) => {
    if (!next.includes(cardId)) {
      next.push(cardId);
    }
  });

  return next.slice(0, DEFAULT_RIGHT_PANEL_ORDER.length);
}

function createDefaultExperimentalLayout(split = DEFAULT_RIGHT_PANEL_SPLIT) {
  return {
    version: LAYOUT_CUSTOMIZATION_VERSION,
    zones: {
      right: [...DEFAULT_RIGHT_PANEL_ORDER],
    },
    splitRatios: {
      right: clampRightPanelSplit(split),
    },
  };
}

function normalizeExperimentalLayout(layout, fallbackSplit = DEFAULT_RIGHT_PANEL_SPLIT) {
  if (!layout || typeof layout !== "object" || layout.version !== LAYOUT_CUSTOMIZATION_VERSION) {
    return createDefaultExperimentalLayout(fallbackSplit);
  }

  return {
    version: LAYOUT_CUSTOMIZATION_VERSION,
    zones: {
      right: normalizeRightPanelOrder(layout.zones?.right),
    },
    splitRatios: {
      right: clampRightPanelSplit(Number(layout.splitRatios?.right)),
    },
  };
}

function loadExperimentalLayout() {
  try {
    if (typeof window === "undefined") {
      return createDefaultExperimentalLayout();
    }

    const stored = window.localStorage.getItem(LAYOUT_CUSTOMIZATION_STORAGE_KEY);

    if (!stored) {
      return createDefaultExperimentalLayout();
    }

    return normalizeExperimentalLayout(JSON.parse(stored));
  } catch (_error) {
    return createDefaultExperimentalLayout();
  }
}

function loadInitialRightLayout() {
  if (ENABLE_EXPERIMENTAL_LAYOUT_CUSTOMIZATION) {
    return loadExperimentalLayout();
  }

  return createDefaultExperimentalLayout(loadRightPanelSplit());
}

function saveExperimentalLayout(layout) {
  try {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(
        LAYOUT_CUSTOMIZATION_STORAGE_KEY,
        JSON.stringify(normalizeExperimentalLayout(layout)),
      );
    }
  } catch (_error) {
    // localStorage can be unavailable in locked-down browser contexts.
  }
}

function removeSavedLayoutPreferences() {
  try {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(LAYOUT_CUSTOMIZATION_STORAGE_KEY);
      window.localStorage.removeItem(RIGHT_PANEL_SPLIT_STORAGE_KEY);
    }
  } catch (_error) {
    // A reset should still update the in-memory layout if storage is blocked.
  }
}

function normalizeAssistantMode(value) {
  if (Object.values(ASSISTANT_MODES).includes(value)) {
    return value;
  }

  return ASSISTANT_MODES.MINIMIZED;
}

function loadAssistantMode() {
  try {
    if (typeof window === "undefined") {
      return ASSISTANT_MODES.MINIMIZED;
    }

    return normalizeAssistantMode(window.localStorage.getItem(ASSISTANT_MODE_STORAGE_KEY));
  } catch (_error) {
    return ASSISTANT_MODES.MINIMIZED;
  }
}

function saveAssistantMode(mode) {
  try {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(ASSISTANT_MODE_STORAGE_KEY, normalizeAssistantMode(mode));
    }
  } catch (_error) {
    // localStorage can be unavailable in locked-down browser contexts.
  }
}

function normalizeAssistantLauncherPosition(value) {
  if (ASSISTANT_LAUNCHER_POSITION_ORDER.includes(value)) {
    return value;
  }

  return ASSISTANT_LAUNCHER_POSITIONS.RIGHT_CENTER;
}

function loadAssistantLauncherPosition() {
  try {
    if (typeof window === "undefined") {
      return ASSISTANT_LAUNCHER_POSITIONS.RIGHT_CENTER;
    }

    return normalizeAssistantLauncherPosition(window.localStorage.getItem(ASSISTANT_LAUNCHER_POSITION_STORAGE_KEY));
  } catch (_error) {
    return ASSISTANT_LAUNCHER_POSITIONS.RIGHT_CENTER;
  }
}

function saveAssistantLauncherPosition(position) {
  try {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(
        ASSISTANT_LAUNCHER_POSITION_STORAGE_KEY,
        normalizeAssistantLauncherPosition(position),
      );
    }
  } catch (_error) {
    // localStorage can be unavailable in locked-down browser contexts.
  }
}

function getNextAssistantLauncherPosition(position) {
  const normalized = normalizeAssistantLauncherPosition(position);
  const index = ASSISTANT_LAUNCHER_POSITION_ORDER.indexOf(normalized);
  return ASSISTANT_LAUNCHER_POSITION_ORDER[(index + 1) % ASSISTANT_LAUNCHER_POSITION_ORDER.length];
}

function formatAssistantHostOwnership(host) {
  const normalized = String(host || "").trim().toLowerCase();

  if (normalized === "fedora") {
    return "Fedora control-plane";
  }

  if (normalized === "windows") {
    return "Windows runtime/operator";
  }

  if (normalized === "cross-host" || normalized === "docs") {
    return "Cross-host docs";
  }

  return "";
}

function buildAssistantAttentionState({
  hasSelectedService = false,
  unreadCount = 0,
  diagnosisDetected = false,
  needsAttention = false,
} = {}) {
  const labels = [];

  if (hasSelectedService) {
    labels.push("Context");
  }

  if (unreadCount > 0) {
    labels.push(unreadCount === 1 ? "1 unread" : `${unreadCount} unread`);
  }

  if (diagnosisDetected) {
    labels.push("Diagnosis");
  }

  if (needsAttention) {
    labels.push("Attention");
  }

  return {
    count: labels.length,
    labels,
    summary: labels.length ? labels.join(" Â· ") : "Ready when needed",
  };
}

function moveCardInOrder(order, cardId, direction) {
  const next = normalizeRightPanelOrder(order);
  const fromIndex = next.indexOf(cardId);
  const toIndex = clamp(fromIndex + direction, 0, next.length - 1);

  if (fromIndex < 0 || fromIndex === toIndex) {
    return next;
  }

  const [movedCard] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, movedCard);

  return next;
}

function LayoutCardControls({ cardId, label, order, onMove }) {
  const normalizedOrder = normalizeRightPanelOrder(order);
  const index = normalizedOrder.indexOf(cardId);

  return (
    <div className="layout-card-controls" aria-label={`${label} layout controls`}>
      <button
        type="button"
        className="layout-move-button"
        onClick={() => onMove(cardId, -1)}
        disabled={index <= 0}
        aria-label={`Move ${label} up`}
      >
        Up
      </button>
      <button
        type="button"
        className="layout-move-button"
        onClick={() => onMove(cardId, 1)}
        disabled={index < 0 || index >= normalizedOrder.length - 1}
        aria-label={`Move ${label} down`}
      >
        Down
      </button>
    </div>
  );
}

class SelectedServiceWorkspaceBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = {
      hasError: false,
      message: "",
    };
  }

  static getDerivedStateFromError(error) {
    return {
      hasError: true,
      message: error?.message || "Unknown workspace error",
    };
  }

  componentDidCatch(error) {
    console.error("Selected service workspace failed to render", error);
  }

  componentDidUpdate(prevProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({
        hasError: false,
        message: "",
      });
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <section className="panel workspace-fallback-panel">
          <span className="section-title">Workspace Fallback</span>
          <h2>Selected service view is unavailable</h2>
          <p>
            {this.props.serviceName
              ? `${this.props.serviceName} returned incomplete UI data.`
              : "The selected service returned incomplete UI data."}
          </p>
          <div className="inline-note">
            {this.state.message || "Select another service or refresh service metadata."}
          </div>
        </section>
      );
    }

    return this.props.children;
  }
}

function DisclosureSection({ title, summary, defaultOpen = false, className = "", children }) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <details
      className={`disclosure-section ${className}`.trim()}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="disclosure-summary">
        <span className="disclosure-copy">
          <span className="disclosure-title">{title}</span>
          <span className="disclosure-text" title={typeof summary === "string" ? summary : undefined}>
            {summary}
          </span>
        </span>
        <span className="disclosure-caret" aria-hidden="true" />
      </summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}

function ServiceGroupDisclosure({ title, summary, defaultOpen = false, forceOpen = false, className = "", children }) {
  const [open, setOpen] = useState(defaultOpen || forceOpen);

  useEffect(() => {
    if (forceOpen) {
      setOpen(true);
    }
  }, [forceOpen]);

  return (
    <details
      className={`disclosure-section service-group-disclosure ${className}`.trim()}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="disclosure-summary">
        <span className="disclosure-copy">
          <span className="disclosure-title">{title}</span>
          <span className="disclosure-text" title={typeof summary === "string" ? summary : undefined}>
            {summary}
          </span>
        </span>
        <span className="disclosure-caret" aria-hidden="true" />
      </summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}

function createId() {
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function getLogText(payload) {
  if (typeof payload === "string") {
    return payload;
  }

  if (payload && typeof payload.logs === "string") {
    return payload.logs;
  }

  return "";
}

function formatAuditValue(value) {
  if (value == null) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value, null, 2);
}

function formatCreatedAt(value) {
  if (!value) {
    return "Unknown";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function formatFileTimestamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "unknown-time";
  }

  return date.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[:]/g, "-");
}

function safeFilePart(value) {
  return (
    String(value || "garage-admin")
      .trim()
      .replace(/[^a-z0-9._-]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "garage-admin"
  );
}

function downloadFile(filename, content, type = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function countLogLines(value) {
  if (typeof value !== "string" || !value) {
    return 0;
  }

  return value.split(/\r?\n/).length;
}

function formatBytes(value) {
  const bytes = typeof value === "string" ? value.length : Number(value) || 0;

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDurationSeconds(value) {
  const totalSeconds = Number(value);

  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return "";
  }

  const rounded = Math.round(totalSeconds);
  const days = Math.floor(rounded / 86400);
  const hours = Math.floor((rounded % 86400) / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);

  if (days > 0) {
    return `${days}d ${hours}h`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  if (minutes > 0) {
    return `${minutes}m`;
  }

  return `${rounded}s`;
}

function lookupText(value) {
  return String(value || "").trim();
}

function getLookupSafetyLabel(item) {
  const status = lookupText(item?.safetyStatus).toLowerCase();

  if (status === "blocked") {
    return "Blocked";
  }

  if (status === "warning") {
    return "Guarded";
  }

  return "Safe";
}

function formatLookupKindLabel(value) {
  return lookupText(value)
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getLookupSafetyBadgeClass(item) {
  const status = lookupText(item?.safetyStatus).toLowerCase();

  if (status === "blocked") {
    return "status-failed";
  }

  if (status === "warning") {
    return "status-warning";
  }

  return "status-completed";
}

function getLookupPreviewText(item) {
  const preview = lookupText(item?.preview);

  if (preview) {
    return preview;
  }

  return lookupText(item?.snippet);
}

function formatLookupMeta(item) {
  const parts = [];

  if (item?.sourceLabel) {
    parts.push(item.sourceLabel);
  }

  if (item?.rootLabel) {
    parts.push(`Root ${item.rootLabel}`);
  }

  if (item?.serviceName) {
    parts.push(`Service ${item.serviceName}`);
  }

  if (item?.matchType) {
    parts.push(`Match ${item.matchType}`);
  }

  if (item?.matchedLineCount != null && Number.isFinite(Number(item.matchedLineCount))) {
    parts.push(`${Number(item.matchedLineCount)} matched`);
  }

  if (item?.updatedDate) {
    parts.push(`Updated ${item.updatedDate}`);
  }

  if (item?.modifiedTime) {
    parts.push(formatCreatedAt(item.modifiedTime));
  }

  if (item?.size != null) {
    parts.push(formatBytes(item.size));
  }

  return parts.join(" Â· ");
}

function isLookupItemSelected(item, selection) {
  if (!item || !selection) {
    return false;
  }

  if (selection.reportId && item.reportId) {
    return selection.reportId === item.reportId;
  }

  if (selection.path && item.path) {
    return selection.path === item.path;
  }

  if (selection.serviceName && item.serviceName) {
    return selection.serviceName === item.serviceName;
  }

  return false;
}

function canPreviewLookupItem(item) {
  const kind = lookupText(item?.kind).toLowerCase();

  if (kind === "report" || kind === "file") {
    return Boolean(item?.reportId || item?.path);
  }

  return false;
}

function canExplainLookupItem(item) {
  return Boolean(item?.reportId);
}

function AssistantLookupResults({ lookup, selection, onSelectItem, onPreviewItem, onExplainItem }) {
  const items = normalizeObjectCollection(lookup?.items);

  if (!items.length) {
    return null;
  }

  return (
    <div className="assistant-lookup-results">
      {items.map((item) => {
        const selected = isLookupItemSelected(item, selection);
        const previewText = getLookupPreviewText(item);
        const showPreviewAsBlock = lookupText(item?.kind).toLowerCase() === "log-preview" || lookupText(item?.kind).toLowerCase() === "file-preview";
        const meta = formatLookupMeta(item);
        const safetyLabel = getLookupSafetyLabel(item);
        const canSelect = Boolean(item?.reportId || item?.path || item?.serviceName);

        return (
          <article
            key={item.id || `${item.kind || "lookup"}-${item.title || item.relativePath || item.serviceName || "item"}`}
            className={`assistant-lookup-card ${selected ? "assistant-lookup-card-selected" : ""} assistant-lookup-card-${
              item.safetyStatus || "safe"
            }`}
          >
            <div className="assistant-lookup-header">
              <div className="assistant-lookup-heading">
                <span className="detail-label">{formatLookupKindLabel(item.kind || "lookup")}</span>
                <strong title={item.title || item.relativePath || item.serviceName}>
                  {item.title || item.relativePath || item.serviceName || "Lookup result"}
                </strong>
              </div>
              <div className="inline-badges assistant-lookup-badges">
                <span className={`status-badge ${getLookupSafetyBadgeClass(item)}`}>{safetyLabel}</span>
                {item.hostLabel ? <span className="status-badge status-info">{item.hostLabel}</span> : null}
              </div>
            </div>

            {item.relativePath || item.path ? (
              <div className="assistant-lookup-path" title={item.path || item.relativePath}>
                {item.relativePath || item.path}
              </div>
            ) : null}

            {meta ? <div className="assistant-lookup-meta">{meta}</div> : null}
            {item.blockedReason ? <div className="known-failure assistant-lookup-blocked">{item.blockedReason}</div> : null}

            {previewText ? (
              showPreviewAsBlock ? (
                <pre className="assistant-lookup-preview" tabIndex={0}>
                  {previewText}
                </pre>
              ) : (
                <div className="assistant-lookup-snippet">{previewText}</div>
              )
            ) : null}

            {item.truncated ? (
              <div className="inline-note assistant-lookup-truncated">
                {item.personalityTruncatedNote || "Preview truncated by the safety cap."}
              </div>
            ) : null}

            <div className="assistant-lookup-actions">
              {canSelect ? (
                <button type="button" className="mini-button" onClick={() => onSelectItem(item)}>
                  {selected ? "Selected" : "Select"}
                </button>
              ) : null}
              {canPreviewLookupItem(item) ? (
                <button type="button" className="mini-button" onClick={() => onPreviewItem(item)}>
                  Preview
                </button>
              ) : null}
              {canExplainLookupItem(item) ? (
                <button type="button" className="mini-button" onClick={() => onExplainItem(item)}>
                  Explain
                </button>
              ) : null}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function assistantPlanStatusClass(status) {
  if (!status) {
    return "status-badge status-risk-unknown";
  }

  if (status.appearance === "freshness") {
    return `signal-freshness-badge signal-freshness-badge-${status.tone || "unknown"}`;
  }

  return `status-badge status-risk-${status.tone || "unknown"}`;
}

function assistantPlanEvidenceSafetyClass(label) {
  const normalized = lookupText(label).toLowerCase();

  if (normalized === "blocked") {
    return "status-badge status-failed";
  }

  if (normalized === "guarded") {
    return "status-badge status-warning";
  }

  return "status-badge status-completed";
}

function AssistantPlanCards({ cards, onRunAction }) {
  const items = normalizeObjectCollection(cards);

  if (!items.length) {
    return null;
  }

  return (
    <div className="assistant-plan-list">
      {items.map((card) => (
        <article
          key={card.id || `${card.planType || "plan"}-${card.targetService?.id || "none"}`}
          className={`assistant-plan-card assistant-plan-card-${card.risk?.level || "unknown"}`}
        >
          <div className="assistant-plan-header">
            <div className="assistant-plan-heading">
              <span className="detail-label">{card.planType || "Operator plan"}</span>
              <strong>{card.title || "Operator plan"}</strong>
              {card.targetService?.name ? (
                <div className="assistant-plan-target">Target: {card.targetService.name}</div>
              ) : null}
            </div>
            <div className="inline-badges assistant-plan-badges">
              <span className="status-badge status-info">{card.hostOwnership?.label || "Unknown"}</span>
              <span
                className={`status-badge status-risk-${card.risk?.level || "unknown"}`}
                title={card.risk?.detail || "Risk level"}
              >
                {card.risk?.label || "Unknown"}
              </span>
              {card.freshnessGateStatus?.label ? (
                <span
                  className={assistantPlanStatusClass(card.freshnessGateStatus)}
                  title={card.freshnessGateStatus.detail || card.freshnessGateStatus.label}
                >
                  {card.freshnessGateStatus.label}
                </span>
              ) : null}
            </div>
          </div>

          <div className="assistant-plan-summary">{card.currentEvidenceSummary}</div>

          {Array.isArray(card.readOnlySteps) && card.readOnlySteps.length ? (
            <div className="assistant-plan-section">
              <span className="detail-label">Read-only first steps</span>
              <ol className="assistant-plan-step-list">
                {card.readOnlySteps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </div>
          ) : null}

          {Array.isArray(card.approvalSteps) && card.approvalSteps.length ? (
            <div className="assistant-plan-section">
              <span className="detail-label">Approval-required steps</span>
              <ol className="assistant-plan-step-list assistant-plan-step-list-approval">
                {card.approvalSteps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </div>
          ) : null}

          <div className="assistant-plan-meta">
            {card.expectedImpact ? (
              <div className="assistant-plan-note">
                <strong>Expected impact:</strong> {card.expectedImpact}
              </div>
            ) : null}
            {card.rollbackNote ? (
              <div className="assistant-plan-note">
                <strong>Rollback:</strong> {card.rollbackNote}
              </div>
            ) : null}
            {card.blockedNote ? (
              <div className="assistant-plan-note assistant-plan-note-warning">
                <strong>Blocked from chat:</strong> {card.blockedNote}
              </div>
            ) : null}
          </div>

          {Array.isArray(card.supportingEvidence) && card.supportingEvidence.length ? (
            <div className="assistant-plan-section">
              <span className="detail-label">Supporting evidence</span>
              <div className="assistant-plan-evidence-list">
                {card.supportingEvidence.map((evidence) => (
                  <div key={evidence.key || `${evidence.kind}-${evidence.title}`} className="assistant-plan-evidence-item">
                    <div className="assistant-plan-evidence-header">
                      <strong>{evidence.title || evidence.kind || "Evidence"}</strong>
                      <div className="inline-badges assistant-plan-evidence-badges">
                        {evidence.kind ? <span className="status-badge status-info">{evidence.kind}</span> : null}
                        {evidence.safetyLabel ? (
                          <span className={assistantPlanEvidenceSafetyClass(evidence.safetyLabel)}>{evidence.safetyLabel}</span>
                        ) : null}
                      </div>
                    </div>
                    <div className="assistant-plan-evidence-summary">{evidence.summary}</div>
                    <div className="assistant-plan-evidence-meta">
                      {[evidence.hostOwnership?.label, evidence.sourceLabel].filter(Boolean).join(" | ")}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {card.nextRecommendedAction?.label ? (
            <div className="assistant-plan-footer">
              <span className="detail-label">Next UI action</span>
              <button type="button" className="mini-button" onClick={(event) => onRunAction(card.nextRecommendedAction, event)}>
                {card.nextRecommendedAction.label}
              </button>
            </div>
          ) : null}
        </article>
      ))}
    </div>
  );
}

function splitLogLine(line) {
  const match = String(line).match(
    /^(\[?\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\]?)(?:\s+|:\s*)?(.*)$/,
  );
  const message = match ? match[2] || "" : String(line);
  const bracketPrefix = message.match(/^(\[[^\]]{2,48}\])\s+(.*)$/);

  if (bracketPrefix) {
    return {
      timestamp: match ? match[1].replace(/^\[|\]$/g, "") : "",
      prefix: bracketPrefix[1],
      message: bracketPrefix[2] || "",
    };
  }

  const prefixMatch = message.match(/^([A-Za-z0-9_.@/-]{2,48}(?:\[\d+\])?)(?::|\s+-\s+|\s+\|\s+)\s*(.*)$/);
  const prefix = prefixMatch?.[1] || "";
  const severityPrefixes = ["debug", "info", "warn", "warning", "error", "fatal", "trace"];

  if (prefix && !severityPrefixes.includes(prefix.toLowerCase())) {
    return {
      timestamp: match ? match[1].replace(/^\[|\]$/g, "") : "",
      prefix,
      message: prefixMatch[2] || "",
    };
  }

  return {
    timestamp: match ? match[1].replace(/^\[|\]$/g, "") : "",
    prefix: "",
    message,
  };
}

function getLogTone(line) {
  if (/\b(fatal|panic|crash|exception)\b/i.test(line)) {
    return "log-critical";
  }

  if (/\b(error|failed|failure|unhealthy|denied)\b/i.test(line)) {
    return "log-error";
  }

  if (/\b(warn|warning|retry|timeout|degraded)\b/i.test(line)) {
    return "log-warning";
  }

  if (/\b(ok|ready|started|listening|healthy|success)\b/i.test(line)) {
    return "log-success";
  }

  return "";
}

function getLogSignals(value) {
  const lines = typeof value === "string" && value ? value.split(/\r?\n/) : [];
  const signals = lines.reduce(
    (current, line) => {
      const tone = getLogTone(line);

      if (tone === "log-critical") {
        current.critical += 1;
      } else if (tone === "log-error") {
        current.errors += 1;
      } else if (tone === "log-warning") {
        current.warnings += 1;
      }

      return current;
    },
    { critical: 0, errors: 0, warnings: 0 },
  );

  const alertCount = signals.critical + signals.errors + signals.warnings;
  let summary = "No log alerts in current output.";

  if (alertCount) {
    summary = `${alertCount} log alert${alertCount === 1 ? "" : "s"}`;
  }

  return {
    ...signals,
    alertCount,
    summary,
  };
}

function LogViewer({ lines, emptyMessage }) {
  const normalizedLines = normalizeCollection(lines).map((line) => String(line ?? ""));

  if (!normalizedLines.length) {
    return <div className="empty-state output-empty">{emptyMessage}</div>;
  }

  return (
    <div className="logs-block" role="log" aria-label="Service logs">
      {normalizedLines.map((line, index) => {
        const parts = splitLogLine(line);
        const tone = getLogTone(line);

        return (
          <div key={`${index}-${line.slice(0, 16)}`} className={`log-row ${tone}`}>
            <span className="log-line-number">{index + 1}</span>
            <span className="log-timestamp">{parts.timestamp}</span>
            <span className="log-prefix">{parts.prefix}</span>
            <span className="log-message">{parts.message || " "}</span>
          </div>
        );
      })}
    </div>
  );
}

function LogEventHighlights({ events, emptyMessage, onSelectService, selectedServiceId }) {
  const items = normalizeObjectCollection(events);

  if (!items.length) {
    return <div className="empty-state output-empty log-highlight-empty">{emptyMessage}</div>;
  }

  return (
    <div className="log-highlight-list">
      {items.map((event, index) => (
        <article
          key={event.id || `${event.errorType || event.primaryIssue || "event"}-${event.timestamp || index}`}
          className={`log-highlight-card log-highlight-card-${event.severity || "unknown"}`}
        >
          <div className="log-highlight-header">
            <div className="log-highlight-heading">
              <span className="detail-label">Detected error</span>
              <strong title={event.detectedError || event.primaryIssue}>
                {event.detectedError || event.primaryIssue || "Extracted log event"}
              </strong>
            </div>
            <div className="inline-badges">
              <span className={`status-badge status-severity-${event.severity || "unknown"}`}>
                Severity: {formatBadgeLabel(event.severity)}
              </span>
              <span className={`status-badge status-confidence-${event.confidence || "low"}`}>
                Confidence: {formatBadgeLabel(event.confidence)}
              </span>
            </div>
          </div>

          <div className="log-highlight-grid">
            <div className="detail-item">
              <span className="detail-label">Error type</span>
              <span className="detail-value diagnosis-detail-value" title={event.errorType || "General failure"}>
                {event.errorType || "General failure"}
              </span>
            </div>
            <div className="detail-item">
              <span className="detail-label">Affected service</span>
              <span className="detail-value diagnosis-detail-value" title={event.affectedService || "Unknown"}>
                {event.affectedService || "Unknown"}
              </span>
            </div>
            <div className="detail-item">
              <span className="detail-label">Most relevant error</span>
              <span className="detail-value diagnosis-detail-value" title={event.mostRelevantError || "No matching error text."}>
                {event.mostRelevantError || "No matching error text."}
              </span>
            </div>
            <div className="detail-item">
              <span className="detail-label">Timestamp</span>
              <span className="detail-value diagnosis-detail-value" title={event.timestamp || "Unknown"}>
                {event.timestamp ? formatCreatedAt(event.timestamp) : "Unknown"}
              </span>
            </div>
            {event.relatedServiceId ? (
              <div className="detail-item">
                <span className="detail-label">Related service</span>
                <span
                  className="detail-value diagnosis-detail-value"
                  title={[event.relatedServiceName || event.relatedServiceId, event.relatedServiceHost, event.relatedServiceManager]
                    .filter(Boolean)
                    .join(" Â· ")}
                >
                  {[event.relatedServiceName || event.relatedServiceId, event.relatedServiceHost, event.relatedServiceManager]
                    .filter(Boolean)
                    .join(" Â· ")}
                </span>
                {typeof onSelectService === "function" && event.relatedServiceId !== selectedServiceId ? (
                  <button
                    type="button"
                    className="mini-button relationship-select-button"
                    onClick={() => onSelectService(event.relatedServiceId)}
                  >
                    Select service
                  </button>
                ) : null}
              </div>
            ) : null}
            {event.relatedEndpoint ? (
              <div className="detail-item">
                <span className="detail-label">Related endpoint</span>
                <span className="detail-value diagnosis-detail-value" title={event.relatedEndpoint}>
                  {event.relatedEndpoint}
                </span>
              </div>
            ) : null}
            {event.correlationReason ? (
              <div className="detail-item">
                <span className="detail-label">Correlation evidence</span>
                <span className="detail-value diagnosis-detail-value" title={event.correlationReason}>
                  {event.correlationReason}
                </span>
              </div>
            ) : null}
            {event.correlationConfidence ? (
              <div className="detail-item">
                <span className="detail-label">Correlation confidence</span>
                <span className="detail-value diagnosis-detail-value" title={event.correlationConfidence}>
                  {formatBadgeLabel(event.correlationConfidence)}
                </span>
              </div>
            ) : null}
            {event.filePath ? (
              <div className="detail-item">
                <span className="detail-label">File</span>
                <span className="detail-value diagnosis-detail-value" title={event.filePath}>
                  {event.filePath}
                </span>
              </div>
            ) : null}
            {event.lineNumber ? (
              <div className="detail-item">
                <span className="detail-label">Line</span>
                <span className="detail-value diagnosis-detail-value" title={String(event.lineNumber)}>
                  {event.lineNumber}
                </span>
              </div>
            ) : null}
          </div>

          {event.suggestedCheck ? (
            <div className="log-highlight-command-block">
              <span className="detail-label">Suggested check</span>
              <pre className="diagnosis-command" tabIndex={0}>
                {event.suggestedCheck}
              </pre>
            </div>
          ) : null}
        </article>
      ))}
    </div>
  );
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function toPlainObject(value) {
  return isPlainObject(value) ? value : {};
}

function normalizeCollection(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeObjectCollection(value) {
  return normalizeCollection(value).filter((item) => isPlainObject(item));
}

function normalizeInventorySources(value) {
  const normalized = {};

  Object.entries(toPlainObject(value)).forEach(([key, entry]) => {
    if (isPlainObject(entry)) {
      normalized[key] = entry;
    }
  });

  return normalized;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry) => String(entry || "").trim()).filter(Boolean);
}

function normalizeServiceRelationArray(value) {
  return normalizeObjectCollection(value)
    .map((entry) => {
      const item = toPlainObject(entry);
      const normalized = {};

      Object.entries(item).forEach(([key, rawValue]) => {
        if (Array.isArray(rawValue)) {
          const values = normalizeStringArray(rawValue);

          if (values.length) {
            normalized[key] = values;
          }

          return;
        }

        if (typeof rawValue === "boolean") {
          normalized[key] = rawValue;
          return;
        }

        const text = String(rawValue || "").trim();

        if (text) {
          normalized[key] = text;
        }
      });

      return Object.keys(normalized).length ? normalized : null;
    })
    .filter(Boolean);
}

function uniqueTextValues(values) {
  return Array.from(new Set(normalizeCollection(values).map((value) => String(value || "").trim()).filter(Boolean)));
}

function buildServiceRelationshipSections(service, services) {
  if (!service) {
    return [];
  }

  const serviceIndex = new Map();
  normalizeObjectCollection(services).forEach((item) => {
    const serviceName = readServiceString(item?.name);

    if (serviceName) {
      serviceIndex.set(serviceName.toLowerCase(), item);
    }
  });
  const provides = normalizeObjectCollection(service.provides);
  const dependencies = normalizeObjectCollection(service.dependencies);
  const providedEndpoints = uniqueTextValues(provides.map((item) => readServiceString(item.endpoint)));
  const healthEndpoints = uniqueTextValues(provides.map((item) => readServiceString(item.healthEndpoint)));
  const readinessEndpoints = uniqueTextValues(provides.map((item) => readServiceString(item.readinessEndpoint)));
  const publicHosts = uniqueTextValues(provides.map((item) => readServiceString(item.publicHost)));
  const declaredPaths = uniqueTextValues(provides.flatMap((item) => normalizeStringArray(item.paths)));
  const provideItems = [
    {
      key: "endpoints",
      meta: "Endpoint",
      values: providedEndpoints,
    },
    {
      key: "health-endpoints",
      meta: "Health endpoint",
      values: healthEndpoints,
    },
    {
      key: "readiness-endpoints",
      meta: "Readiness endpoint",
      values: readinessEndpoints,
    },
    {
      key: "public-hosts",
      meta: "Public host",
      values: publicHosts,
    },
    {
      key: "paths",
      meta: "Paths",
      values: declaredPaths,
    },
  ]
    .filter((item) => item.values.length)
    .map((item) => ({
      key: item.key,
      value: item.values.join("\n"),
      meta: item.meta,
      title: `${item.meta}: ${item.values.join(" Â· ")}`,
    }));
  const dependencyItems = dependencies
    .map((dependency) => {
      const serviceId = readServiceString(dependency.serviceId);

      if (!serviceId) {
        return null;
      }

      const targetService = serviceIndex.get(serviceId.toLowerCase()) || null;
      const displayName = readServiceString(targetService?.displayName, targetService?.name);
      const endpoint = readServiceString(dependency.endpoint);
      const confidence = readServiceString(dependency.confidence);
      const reason = readServiceString(dependency.reason, dependency.relationship);
      const source = readServiceString(dependency.source);
      const metaLines = [];

      if (displayName && displayName !== serviceId) {
        metaLines.push(`Service ID: ${serviceId}`);
      }

      if (endpoint) {
        metaLines.push(`Endpoint: ${endpoint}`);
      }

      if (confidence) {
        metaLines.push(`Confidence: ${confidence}`);
      }

      if (reason) {
        metaLines.push(`Reason: ${reason}`);
      }

      if (source) {
        metaLines.push(`Source: ${source}`);
      }

      return {
        key: `${serviceId.toLowerCase()}-${endpoint || metaLines.join("-") || "dependency"}`,
        value: displayName || serviceId,
        meta: metaLines.join("\n"),
        serviceId,
        title: [displayName || serviceId, ...metaLines].filter(Boolean).join(" Â· "),
      };
    })
    .filter(Boolean);

  return [
    provideItems.length
      ? {
          label: "Provides",
          items: provideItems,
        }
      : null,
    dependencyItems.length
      ? {
          label: "Depends on",
          items: dependencyItems,
        }
      : null,
  ].filter(Boolean);
}

function compactDetailItems(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items.filter((item) => item && typeof item === "object" && String(item.label || "").trim());
}

function readServiceString(...values) {
  for (const value of values) {
    const text = String(value || "").trim();

    if (text) {
      return text;
    }
  }

  return "";
}

function readServiceNumber(...values) {
  for (const value of values) {
    const parsed = Number(value);

    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function normalizeServiceInventorySnapshot(payload) {
  return {
    checkedAt: readServiceString(payload?.checkedAt) || null,
    sources: normalizeInventorySources(payload?.sources),
  };
}

function normalizeServiceCapability(value) {
  const capability = toPlainObject(value);

  return {
    supported: capability.supported === true,
    executor: readServiceString(capability.executor),
    mode: readServiceString(capability.mode),
    reason: readServiceString(capability.reason),
    setupHint: readServiceString(capability.setupHint),
  };
}

function normalizeServiceCapabilities(value) {
  const capabilities = toPlainObject(value);

  return {
    logs: normalizeServiceCapability(capabilities.logs),
    health: normalizeServiceCapability(capabilities.health),
    restart: normalizeServiceCapability(capabilities.restart),
    setupHints: normalizeStringArray(capabilities.setupHints),
  };
}

function normalizeServiceSupports(value) {
  const supports = toPlainObject(value);

  return {
    logs: supports.logs === true,
    health: supports.health === true,
    restart: supports.restart === true,
  };
}

function getServiceManager(service) {
  return readServiceString(service?.manager, service?.inventory?.manager, service?.runtime?.manager);
}

function getServiceProcessName(service) {
  return readServiceString(service?.processName, service?.runtime?.processName, service?.inventory?.processName);
}

function getServiceLocalPort(service) {
  return readServiceNumber(service?.inventory?.localPort);
}

function getServiceLocalUrl(service) {
  return readServiceString(service?.inventory?.localUrl, service?.health?.localUrl);
}

function getServiceLocalHealthUrl(service) {
  return readServiceString(service?.inventory?.localHealthUrl, service?.health?.url);
}

function getServiceLocalReadinessUrl(service) {
  return readServiceString(service?.inventory?.localReadinessUrl, service?.health?.readinessUrl);
}

function getServicePublicUrl(service) {
  return readServiceString(service?.inventory?.publicUrl, service?.health?.publicUrl);
}

function getServiceNotes(service) {
  if (Array.isArray(service?.inventory?.notes)) {
    return service.inventory.notes.map((note) => String(note || "").trim()).filter(Boolean);
  }

  const note = readServiceString(service?.inventory?.notes);
  return note ? [note] : [];
}

function getServiceRuntimeSummary(service) {
  if (!service) {
    return "";
  }

  const runtime = toPlainObject(service.runtime);
  const parts = [];
  const pm2Status = readServiceString(runtime.pm2Status, runtime.status);
  const uptime = formatDurationSeconds(runtime.uptimeSeconds);
  const memory = runtime.memoryBytes != null ? formatBytes(runtime.memoryBytes) : "";
  const restarts = Number.isFinite(Number(runtime.restarts)) ? Number(runtime.restarts) : null;

  if (pm2Status) {
    parts.push(`PM2 ${pm2Status}`);
  }

  if (uptime) {
    parts.push(`uptime ${uptime}`);
  }

  if (memory) {
    parts.push(memory);
  }

  if (restarts != null) {
    parts.push(`${restarts} restart${restarts === 1 ? "" : "s"}`);
  }

  return parts.join(" Â· ");
}

function getServiceLocalCheckSummary(service) {
  if (!service) {
    return "";
  }

  const localHttp = toPlainObject(service?.health?.checks?.localHttp);
  const localPort = toPlainObject(service?.health?.checks?.localPort);
  const parts = [];

  if (localHttp.checkedAt) {
    const label = localHttp.kind === "health-url" ? "health" : "local HTTP";
    parts.push(localHttp.ok ? `${label} ok${localHttp.status ? ` Â· HTTP ${localHttp.status}` : ""}` : `${label} failed`);
  }

  if (localPort.checkedAt) {
    const port = localPort.port || getServiceLocalPort(service);
    parts.push(localPort.ok ? `port ${port} listening` : `port ${port} unavailable`);
  }

  return parts.join(" Â· ");
}

function normalizeServiceItems(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item) => {
      const name = String(item?.name || item?.serviceName || "").trim();

      if (!name) {
        return null;
      }

      const backendClassification = toPlainObject(item?.classification);
      const service = {
        name,
        displayName: String(item?.displayName || name).trim() || name,
        status: String(item?.status || "unknown").trim() || "unknown",
        host: String(item?.host || "unknown").trim() || "unknown",
        source: String(item?.source || "memory").trim() || "memory",
        lastCheckedAt: item?.lastCheckedAt || null,
        checkedAt: item?.checkedAt || null,
        lastSeen: item?.lastSeen || null,
        updatedAt: item?.updatedAt || null,
        healthCheckedAt: item?.healthCheckedAt || null,
        hasLogs: Boolean(item?.hasLogs),
        manager: readServiceString(item?.manager),
        processName: readServiceString(item?.processName),
        serviceGroupKey: readServiceString(item?.serviceGroupKey),
        serviceGroupLabel: readServiceString(item?.serviceGroupLabel),
        serviceTypeLabel: readServiceString(item?.serviceTypeLabel),
        supports: normalizeServiceSupports(item?.supports),
        inventory: toPlainObject(item?.inventory),
        metadata: toPlainObject(item?.metadata),
        health: toPlainObject(item?.health),
        provides: normalizeServiceRelationArray(item?.provides),
        dependencies: normalizeServiceRelationArray(item?.dependencies),
        runtime: toPlainObject(item?.runtime),
        capabilities: normalizeServiceCapabilities(item?.capabilities),
      };

      const classificationSetupHints = normalizeStringArray(backendClassification.setupHints);
      const setupHints = classificationSetupHints.length ? classificationSetupHints : getServiceSetupHints(service);
      const groupKey = normalizeServiceGroupKey(
        backendClassification.groupKey ||
          backendClassification.group ||
          service.serviceGroupKey ||
          service.metadata?.serviceGroup,
      );
      const type = readServiceString(
        backendClassification.type,
        service.serviceTypeLabel,
        service.metadata?.serviceType,
      );
      const severity = readServiceString(backendClassification.severity) || deriveServiceSeverity(service, setupHints);

      return {
        ...service,
        classification: {
          ...backendClassification,
          groupKey: groupKey || getServiceRailGroupKey(service),
          groupLabel:
            readServiceString(backendClassification.groupLabel, service.serviceGroupLabel) ||
            SERVICE_GROUP_META[groupKey || getServiceRailGroupKey(service)]?.title ||
            SERVICE_GROUP_META.admin.title,
          type: type || inferServiceType(service),
          severity,
          setupHints,
          primarySetupHint: readServiceString(backendClassification.primarySetupHint, setupHints[0]) || "",
        },
      };
    })
    .filter(Boolean)
    .sort(compareServiceRailOrder);
}

function getCompactServiceMeta(service) {
  if (!service) {
    return "";
  }

  const parts = [];
  const type = readServiceString(service?.classification?.type, service?.serviceTypeLabel);
  const host = readServiceString(service.host);
  const manager = getServiceManager(service);
  const port = getServiceLocalPort(service);

  if (type) {
    parts.push(type);
  }

  if (host && host !== "unknown") {
    parts.push(host);
  } else {
    parts.push("unknown host");
  }

  if (manager) {
    parts.push(manager);
  }

  if (port) {
    parts.push(`port ${port}`);
  }

  return parts.join(" Â· ");
}

const SERVICE_SEVERITY_ORDER = {
  failed: 0,
  warning: 1,
  "needs-setup": 2,
  unknown: 3,
  running: 4,
  disabled: 5,
};

const SERVICE_GROUP_ORDER = ["api", "ui-apps", "admin", "infrastructure"];

const SERVICE_GROUP_META = {
  api: {
    title: "API",
  },
  "ui-apps": {
    title: "UI & Apps",
  },
  admin: {
    title: "Admin",
  },
  infrastructure: {
    title: "Infrastructure",
  },
};

function normalizeServiceGroupKey(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  if (!normalized) {
    return "";
  }

  if (normalized === "ui" || normalized === "app" || normalized === "apps" || normalized === "ui-apps") {
    return "ui-apps";
  }

  if (normalized === "infra" || normalized === "infrastructure" || normalized === "database" || normalized === "db") {
    return "infrastructure";
  }

  if (normalized === "bridge" || normalized === "control-plane" || normalized === "control") {
    return "admin";
  }

  if (normalized === "api" || normalized === "admin") {
    return normalized;
  }

  return "";
}

function getServiceRailGroupKey(service) {
  const explicitGroupKey = normalizeServiceGroupKey(
    service?.classification?.groupKey || service?.classification?.group || service?.serviceGroupKey,
  );

  if (explicitGroupKey) {
    return explicitGroupKey;
  }

  const type = String(service?.classification?.type || service?.serviceTypeLabel || inferServiceType(service))
    .trim()
    .toLowerCase();

  if (type === "api") {
    return "api";
  }

  if (type === "ui" || type === "app" || type === "operator console") {
    return "ui-apps";
  }

  if (type === "database" || type === "infrastructure") {
    return "infrastructure";
  }

  return "admin";
}

function summarizeServiceGroup(services) {
  const serviceItems = normalizeObjectCollection(services);
  const total = serviceItems.length;
  const attentionCount = serviceItems.filter((service) => {
    const severity = service?.classification?.severity || deriveServiceSeverity(service);
    return severity === "failed" || severity === "warning" || severity === "needs-setup";
  }).length;
  const runningCount = serviceItems.filter((service) => {
    const severity = service?.classification?.severity || deriveServiceSeverity(service);
    return severity === "running";
  }).length;

  return [
    `${total} service${total === 1 ? "" : "s"}`,
    attentionCount ? `${attentionCount} needs attention` : null,
    !attentionCount && runningCount ? `${runningCount} running` : null,
  ]
    .filter(Boolean)
    .join(" Â· ");
}

function groupServicesForRail(services, selectedServiceName) {
  const grouped = Object.fromEntries(SERVICE_GROUP_ORDER.map((key) => [key, []]));

  for (const service of normalizeObjectCollection(services)) {
    const groupKey = getServiceRailGroupKey(service);

    if (!Array.isArray(grouped[groupKey])) {
      grouped[groupKey] = [];
    }

    grouped[groupKey].push(service);
  }

  return SERVICE_GROUP_ORDER.map((key) => {
    const items = normalizeObjectCollection(grouped[key]);

    return {
      key,
      title: SERVICE_GROUP_META[key]?.title || key,
      services: items,
      summary: summarizeServiceGroup(items),
      attentionCount: items.filter((service) => {
        const severity = service?.classification?.severity || deriveServiceSeverity(service);
        return severity === "failed" || severity === "warning" || severity === "needs-setup";
      }).length,
      containsSelectedService: items.some((service) => service.name === selectedServiceName),
    };
  }).filter((group) => group.services.length);
}

function getServiceCapability(service, capabilityName) {
  return normalizeServiceCapability(service?.capabilities?.[capabilityName]);
}

function uniqueHints(values) {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
}

function getServiceSetupHints(service) {
  const capabilityHints = normalizeStringArray(service?.capabilities?.setupHints);

  if (capabilityHints.length) {
    return uniqueHints(capabilityHints);
  }

  return uniqueHints([
    getServiceCapability(service, "logs").setupHint,
    getServiceCapability(service, "health").setupHint,
    String(service?.status || "").trim().toLowerCase() === "pending-env-or-not-started"
      ? "Pending environment or runtime start"
      : "",
  ]);
}

function inferServiceType(service) {
  const text = `${service?.name || ""} ${service?.displayName || ""}`.toLowerCase();

  if (!text) {
    return "Service";
  }

  if (/postgres|taskmaster-db|\bdb\b|database/.test(text) || service?.metadata?.backend === "postgres") {
    return "Database";
  }

  if (/garage-admin|operator console/.test(text)) {
    return "Operator Console";
  }

  if (/admin-proxy|control proxy/.test(text)) {
    return "Control Proxy";
  }

  if (/node-agent/.test(text)) {
    return "Node Agent";
  }

  if (/bridge/.test(text) || (text.includes("aibry-admin") && service?.host === "fedora")) {
    return "Bridge";
  }

  if (/scheduler|scheduled|cron/.test(text)) {
    return "Scheduled Job";
  }

  if (/worker|reminder/.test(text)) {
    return "Worker";
  }

  if (/(^|[-\s])api($|[-\s])/.test(text) || text.endsWith("-api")) {
    return "API";
  }

  if (/frontend|landing|web|(^|[-\s])ui($|[-\s])/.test(text) || text.endsWith("-ui")) {
    return "UI";
  }

  if (/comparator|app/.test(text)) {
    return "App";
  }

  return service?.host === "windows" ? "App" : "Service";
}

function deriveServiceSeverity(service, setupHints = getServiceSetupHints(service)) {
  const status = String(service?.status || "unknown").trim().toLowerCase();

  if (/^(disabled|inactive|paused)$/.test(status)) {
    return "disabled";
  }

  if (/^(failed|stopped|error|unreachable|offline|crashed|missing)$/.test(status)) {
    return "failed";
  }

  if (/^(warning|degraded|partial|timeout|attention|restarting)$/.test(status)) {
    return "warning";
  }

  if (status === "pending-env-or-not-started" || status === "needs-setup") {
    return "needs-setup";
  }

  if (setupHints.length && status === "unknown") {
    return "needs-setup";
  }

  if (/^(running|online|healthy|ok|ready|supported)$/.test(status)) {
    return "running";
  }

  return "unknown";
}

function compareServiceRailOrder(left, right) {
  const leftSeverity = left?.classification?.severity || deriveServiceSeverity(left);
  const rightSeverity = right?.classification?.severity || deriveServiceSeverity(right);
  const leftOrder = SERVICE_SEVERITY_ORDER[leftSeverity] ?? SERVICE_SEVERITY_ORDER.unknown;
  const rightOrder = SERVICE_SEVERITY_ORDER[rightSeverity] ?? SERVICE_SEVERITY_ORDER.unknown;

  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }

  return String(left?.displayName || left?.name || "").localeCompare(String(right?.displayName || right?.name || ""));
}

function capabilityMessage(capability, fallback) {
  return readServiceString(capability?.reason, capability?.setupHint, fallback);
}

function actionCapability(service, actionType) {
  if (actionType === "fetch-logs") {
    return getServiceCapability(service, "logs");
  }

  if (actionType === "health-check") {
    return getServiceCapability(service, "health");
  }

  if (actionType === "restart-service") {
    return getServiceCapability(service, "restart");
  }

  return {};
}

function actionExecutionDetail(actionType, capability) {
  if (!capability?.supported) {
    return capabilityMessage(capability, "Unavailable");
  }

  if (actionType === "fetch-logs") {
    return capability.executor === "windows-local" ? "Windows PM2 logs" : "Fedora bridge logs";
  }

  if (actionType === "health-check") {
    if (capability.mode === "bridge-health") {
      return "Bridge health";
    }

    if (capability.mode === "http") {
      return "Dedicated endpoint";
    }

    if (capability.mode === "local-url") {
      return "Local HTTP reachability";
    }

    if (capability.mode === "tcp") {
      return "Local port verification";
    }

    if (capability.mode === "status-only") {
      return "Status-only fallback";
    }
  }

  return "Run now";
}

function actionSupportSummary(actionType, capability) {
  const detail = actionExecutionDetail(actionType, capability);
  const setupHint = readServiceString(capability?.setupHint);

  if (!capability?.supported) {
    return detail;
  }

  return setupHint ? `${detail} Â· ${setupHint}` : detail;
}

const ACTION_LABELS = {
  "fetch-logs": "Fetch logs",
  "health-check": "Health check",
  "restart-service": "Restart service",
};

function actionLabel(actionType) {
  return ACTION_LABELS[actionType] || formatActionTypeLabel(actionType);
}

function requiresApproval(actionType, metadata = null) {
  return getActionRiskProfile(actionType, metadata).requiresApproval;
}

function getApiErrorMessage(data, fallback) {
  if (!data || typeof data !== "object") {
    return fallback;
  }

  const parts = [];
  if (data.code) {
    parts.push(data.code);
  }
  if (data.serviceName) {
    parts.push(data.serviceName);
  }
  if (data.host) {
    parts.push(data.host);
  }
  if (data.reason) {
    parts.push(data.reason);
  }
  if (data.suggestedSetupHint) {
    parts.push(data.suggestedSetupHint);
  }
  if (data.message) {
    parts.push(data.message);
  }

  return parts.length ? parts.join(" Â· ") : data.error || fallback;
}

function getUnsupportedRestartMessage(result) {
  const payload = result?.data || null;

  if (!["restart_unsupported_for_host", "restart_unsupported_service"].includes(payload?.code)) {
    return "";
  }

  if (payload.message) {
    return payload.message;
  }

  const servicePrefix = payload.serviceName ? `${payload.serviceName}: ` : "";
  const hostPrefix = payload.host && payload.host !== "unknown" ? `${payload.host}-hosted` : "this";

  return `${servicePrefix}Restart is not supported for ${hostPrefix} service.`;
}

function getActionResult(actionResult) {
  const action = actionResult?.action || actionResult;
  return actionResult?.result || action?.result || {};
}

function getVerification(result) {
  const verification = result?.data?.verification;

  if (!verification || typeof verification !== "object") {
    return null;
  }

  return verification;
}

function verificationMethodLabel(method) {
  if (method === "http") {
    return "HTTP health";
  }

  if (method === "pm2") {
    return "PM2 status";
  }

  return method || "verification";
}

function getVerificationSummary(result) {
  const verification = getVerification(result);

  if (!verification) {
    return "";
  }

  const parts = [verificationMethodLabel(verification.method)];

  if (verification.method === "http" && verification.status) {
    parts.push(`HTTP ${verification.status}`);
  }

  if (verification.method === "pm2" && verification.pm2Status) {
    parts.push(`PM2 ${verification.pm2Status}`);
  }

  if (verification.error) {
    parts.push(verification.error);
  }

  return parts.join(" Â· ");
}

function VerificationSummary({ result }) {
  const verification = getVerification(result);

  if (!verification) {
    return null;
  }

  return (
    <div className={`verification-summary ${verification.ok ? "verification-ok" : "verification-failed"}`}>
      <span className={`status-badge ${verification.ok ? "status-completed" : "status-failed"}`}>
        {verification.ok ? "verified" : "verify failed"}
      </span>
      <span>{getVerificationSummary(result)}</span>
    </div>
  );
}

function getActionResultSummary(actionResult) {
  if (!actionResult) {
    return "";
  }

  const action = actionResult.action || actionResult;
  const result = getActionResult(actionResult);
  const unsupportedMessage = getUnsupportedRestartMessage(result);

  if (unsupportedMessage) {
    return unsupportedMessage;
  }

  if (action.status === "pending") {
    return "Action created and waiting for approval.";
  }

  if (action.status === "approved") {
    return "Action approved and ready to execute.";
  }

  if (action.status === "completed") {
    const verification = getVerification(result);
    const verificationText = verification
      ? verification.ok
        ? "Verification passed."
        : "Verification failed; restart command completed."
      : "";

    return [result?.data?.message || "Action completed.", verificationText].filter(Boolean).join(" ");
  }

  if (action.status === "failed") {
    return result?.data?.message || result?.error || "Action failed.";
  }

  return action.status || "";
}

function getCompactAuditSummary(entry) {
  const summary = getActionResultSummary(entry);

  if (summary) {
    return summary;
  }

  const result = getActionResult(entry);
  return result?.data?.message || result?.error || "";
}

function formatActionResultClipboard(actionResult) {
  if (!actionResult) {
    return "";
  }

  const action = actionResult.action || actionResult;
  const result = getActionResult(actionResult);
  const riskProfile = getActionRiskProfile(action.actionType || result.actionType, actionResult);
  const lines = [
    "Garage Admin V2 action result",
    `Action: ${actionLabel(action.actionType || result.actionType)}`,
    `Target: ${action.target || result.target || "unknown"}`,
    `Status: ${action.status || result.status || "unknown"}`,
    `Risk: ${riskProfile.label}`,
  ];
  const createdAt = action.createdAt || result.executedAt;
  const summary = getActionResultSummary(actionResult);

  if (createdAt) {
    lines.push(`Time: ${formatCreatedAt(createdAt)}`);
  }

  if (summary) {
    lines.push(`Summary: ${summary}`);
  }

  lines.push("", "Result:", formatAuditValue(result) || "None");
  return lines.join("\n");
}

function canApproveAction(entry) {
  return entry?.status === "pending" && requiresApproval(entry.actionType, entry);
}

function canExecuteAction(entry) {
  return entry?.status === "approved";
}

function actionMatchesService(actionResult, serviceName) {
  if (!actionResult || !serviceName) {
    return false;
  }

  const action = actionResult.action || actionResult;
  return [action?.target, action?.serviceName, actionResult?.serviceName].some(
    (value) => String(value || "").trim() === serviceName,
  );
}

function canRestartService(service) {
  if (!service) {
    return false;
  }

  const restartCapability = service.capabilities?.restart;
  if (typeof restartCapability === "boolean") {
    return restartCapability;
  }

  if (restartCapability && typeof restartCapability === "object" && typeof restartCapability.supported === "boolean") {
    return restartCapability.supported;
  }

  if (typeof service?.supports?.restart === "boolean") {
    return service.supports.restart;
  }

  return false;
}

function resolveActionTargetName(actionRecord) {
  return readServiceString(
    actionRecord?.input?.serviceName,
    actionRecord?.serviceName,
    actionRecord?.action?.input?.serviceName,
    actionRecord?.action?.serviceName,
    actionRecord?.target,
    actionRecord?.action?.target,
  );
}

function findServiceForAction(actionRecord, services) {
  const targetName = resolveActionTargetName(actionRecord);

  if (!targetName || !Array.isArray(services)) {
    return null;
  }

  return services.find((service) => service?.name === targetName) || null;
}

function getActionHostLabel(actionRecord, serviceRecord) {
  return readServiceString(
    actionRecord?.host,
    actionRecord?.input?.host,
    actionRecord?.action?.input?.host,
    serviceRecord?.host,
    "Unknown",
  );
}

function getActionRuntimeLabel(actionRecord, serviceRecord) {
  return readServiceString(
    getServiceManager(serviceRecord),
    actionRecord?.manager,
    actionRecord?.input?.manager,
    actionRecord?.action?.input?.manager,
    getServiceProcessName(serviceRecord),
    "Unknown runtime",
  );
}

function getActionRiskContext(actionType, actionRecord, serviceRecord) {
  const capability = actionCapability(serviceRecord, actionType);
  const supported =
    typeof capability?.supported === "boolean"
      ? capability.supported
      : actionType === "restart-service"
        ? canRestartService(serviceRecord)
        : undefined;

  return {
    service: serviceRecord,
    supported,
    host: getActionHostLabel(actionRecord, serviceRecord),
    manager: getServiceManager(serviceRecord),
  };
}

function buildActionApprovalDetails(actionType, actionRecord, serviceRecord, options = {}) {
  const targetName = resolveActionTargetName(actionRecord);
  const riskProfile =
    options.riskProfile || getActionRiskProfile(actionType, actionRecord, getActionRiskContext(actionType, actionRecord, serviceRecord));

  return compactDetailItems([
    {
      label: "Action",
      value: actionLabel(actionType),
    },
    {
      label: "Target service",
      value: serviceRecord?.displayName || targetName || "Unknown service",
    },
    {
      label: "Host",
      value: getActionHostLabel(actionRecord, serviceRecord),
    },
    {
      label: "Runtime / manager",
      value: getActionRuntimeLabel(actionRecord, serviceRecord),
    },
    {
      label: "Risk level",
      value: riskProfile.label,
    },
    {
      label: "Requested by",
      value: readServiceString(actionRecord?.requestedBy, actionRecord?.action?.requestedBy, "Not set"),
    },
    {
      label: "Approved by",
      value: readServiceString(actionRecord?.approvedBy, actionRecord?.action?.approvedBy, "Not set"),
    },
    {
      label: "Requires approval",
      value: riskProfile.requiresApproval ? "Yes" : "No",
    },
    {
      label: "Expected impact",
      value: riskProfile.expectedImpact,
    },
    {
      label: "Rollback note",
      value: riskProfile.rollbackNote,
    },
    options.approvalNote
      ? {
          label: "Approval note",
          value: options.approvalNote,
        }
      : null,
    options.lifecycleText
      ? {
          label: "Lifecycle state",
          value: options.lifecycleText,
        }
      : null,
  ]);
}

function preferredActionReviewPhaseForStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();

  if (normalized === "approved") {
    return "approved";
  }

  if (normalized === "executing" || normalized === "completed" || normalized === "failed") {
    return "executed";
  }

  return "requested";
}

function shouldUsePersistedActionReview(snapshot) {
  const riskProfile = snapshot?.approvalContext?.riskProfile;

  if (!riskProfile || typeof riskProfile !== "object") {
    return false;
  }

  return riskProfile.requiresApproval === true || riskProfile.riskLevel === "caution" || riskProfile.riskLevel === "dangerous";
}

function buildPersistedActionReviewDetails(snapshot) {
  const riskProfile = snapshot?.approvalContext?.riskProfile;
  const gate = snapshot?.approvalContext?.gate;

  if (!shouldUsePersistedActionReview(snapshot)) {
    return [];
  }

  return compactDetailItems([
    {
      label: "Action",
      value: readServiceString(snapshot?.actionName, actionLabel(snapshot?.actionType), "Action"),
    },
    {
      label: "Target service",
      value: readServiceString(snapshot?.targetServiceName, snapshot?.targetServiceId, "Unknown service"),
    },
    {
      label: "Host",
      value: readServiceString(snapshot?.host, "Unknown"),
    },
    {
      label: "Runtime / manager",
      value: readServiceString(snapshot?.runtimeManager, "Unknown runtime"),
    },
    {
      label: "Risk level",
      value: readServiceString(riskProfile?.label, "Unknown"),
    },
    {
      label: "Requested by",
      value: readServiceString(snapshot?.requestedBy, "Not set"),
    },
    {
      label: "Approved by",
      value: readServiceString(snapshot?.approvedBy, "Not set"),
    },
    {
      label: "Requires approval",
      value: riskProfile?.requiresApproval ? "Yes" : "No",
    },
    {
      label: "Expected impact",
      value: readServiceString(riskProfile?.expectedImpact, "Not recorded"),
    },
    {
      label: "Rollback note",
      value: readServiceString(riskProfile?.rollbackNote, "Not recorded"),
    },
    gate?.requiresAcknowledgement || gate?.freshnessAcknowledged
      ? {
          label: "Stale context acknowledged",
          value: gate.freshnessAcknowledged ? "Yes" : "No",
        }
      : null,
    gate?.gateDisabledReason
      ? {
          label: "Gate reason",
          value: gate.gateDisabledReason,
        }
      : null,
    {
      label: "Snapshot phase",
      value: formatStatusLabel(snapshot?.phase),
    },
    {
      label: "Captured at",
      value: formatCreatedAt(snapshot?.capturedAt),
    },
  ]);
}

function getHealthStatusSummary(healthResult) {
  if (!healthResult) {
    return "No health result yet.";
  }

  if (healthResult.mode === "bridge-health") {
    return `${healthResult.ok ? "Bridge OK" : "Bridge attention"}${
      healthResult.status ? ` Â· HTTP ${healthResult.status}` : ""
    }`;
  }

  if (healthResult.mode === "local-url") {
    return `${healthResult.ok ? "Reachable" : "Reachability failed"}${
      healthResult.status ? ` Â· HTTP ${healthResult.status}` : ""
    }`;
  }

  if (healthResult.mode === "tcp") {
    return healthResult.ok ? "Port reachable" : "Port check failed";
  }

  if (healthResult.mode === "status-only") {
    const pm2Status = healthResult.verification?.pm2Status ? ` Â· PM2 ${healthResult.verification.pm2Status}` : "";
    return `${healthResult.ok ? "Status only" : "Status alert"}${pm2Status}`;
  }

  return `${healthResult.ok ? "OK" : "Attention"}${healthResult.status ? ` Â· HTTP ${healthResult.status}` : ""}`;
}

function createWorkerEvidenceSnapshot() {
  return {
    health: null,
    capabilities: null,
    jobResults: [],
    lastCheckedAt: null,
    lastJobAt: null,
  };
}

const FEDORA_REPO_BOOTSTRAP_PATH = "/home/aibry/projects/aibry-worker-bootstrap";
const FEDORA_REPO_NODE_CHECK_FILE = "/home/aibry/projects/aibry-worker-bootstrap/src/server.js";

function getWorkerDisplayName(worker) {
  return readServiceString(worker?.name, worker?.id, "Worker");
}

function getWorkerRegistrySource(worker) {
  return readServiceString(worker?.registrySource, worker?.baseRouteSource, worker?.source, "built-in worker registry");
}

function formatWorkerTaskLabel(taskType) {
  const normalized = String(taskType || "").trim().toLowerCase();

  if (normalized === "health") {
    return "Check worker health";
  }

  if (normalized === "capabilities") {
    return "Load capabilities";
  }

  if (normalized === "ping_url") {
    return "Check Garage Admin health";
  }

  if (normalized === "pm2_jlist") {
    return "Fetch PM2 status";
  }

  if (normalized === "system_pulse") {
    return "Run system pulse";
  }

  if (normalized === "templates") {
    return "Inspect templates";
  }

  return formatStatusLabel(normalized);
}

function formatWorkerStatusValue(value) {
  const text = String(value || "").trim();

  if (!text) {
    return "";
  }

  if (/^\d+$/.test(text)) {
    return `HTTP ${text}`;
  }

  return formatBadgeLabel(text);
}

function normalizeWorkerError(payload, fallbackCode = "worker_request_failed", fallbackMessage = "Worker request failed.") {
  const data = toPlainObject(payload);
  const errorCode = readServiceString(data.errorCode, data.code, fallbackCode);
  const message = readServiceString(data.error, data.message, fallbackMessage);

  return {
    code: errorCode || fallbackCode,
    message: message || fallbackMessage,
  };
}

function normalizeWorkerCapabilityEntry(entry, keyHint = "") {
  if (entry == null) {
    return null;
  }

  if (typeof entry === "string") {
    const label = String(entry).trim();

    return label
      ? {
          key: label.toLowerCase(),
          label,
          detail: "",
          supported: true,
        }
      : null;
  }

  if (typeof entry === "boolean") {
    const label = String(keyHint || "").trim();

    return label
      ? {
          key: label.toLowerCase(),
          label,
          detail: "",
          supported: entry,
        }
      : null;
  }

  const item = toPlainObject(entry);
  const label = readServiceString(item.label, item.name, item.taskType, item.id, keyHint);

  if (!label) {
    return null;
  }

  const detail = readServiceString(item.description, item.reason, item.setupHint, item.mode, item.executor, item.target, item.url);

  return {
    key: `${label.toLowerCase()}-${detail.toLowerCase()}`,
    label,
    detail,
    supported: item.supported !== false && item.available !== false && item.enabled !== false && item.ok !== false,
  };
}

function isHiddenWorkerCapabilityEntry(entry) {
  const text = `${entry?.key || ""} ${entry?.label || ""} ${entry?.detail || ""}`.toLowerCase();

  return /\bcreate\b/.test(text);
}

function extractWorkerCapabilityEntries(payload) {
  const candidates = [
    payload,
    payload?.capabilities,
    payload?.items,
    payload?.data,
    payload?.supportedTasks,
    payload?.tasks,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.map((entry) => normalizeWorkerCapabilityEntry(entry)).filter(Boolean).filter((entry) => !isHiddenWorkerCapabilityEntry(entry));
    }

    if (isPlainObject(candidate)) {
      const entries = Object.entries(candidate)
        .map(([key, value]) => normalizeWorkerCapabilityEntry(value, key))
        .filter(Boolean);

      if (entries.length) {
        return entries.filter((entry) => !isHiddenWorkerCapabilityEntry(entry));
      }
    }
  }

  return [];
}

function summarizeWorkerHealthResult(result) {
  if (!result) {
    return "Not checked yet.";
  }

  if (result.ok === false) {
    return readServiceString(result.error, result.message, "Health check failed.");
  }

  const parts = [];
  const status = formatWorkerStatusValue(result.status || result.state);

  if (status) {
    parts.push(status);
  }

  const message = readServiceString(result.message, result.summary, result.detail);

  if (message) {
    parts.push(message);
  }

  return parts.length ? parts.join(" Â· ") : "Healthy.";
}

function summarizeWorkerJobResult(result, taskType) {
  if (!result) {
    return {
      outcome: "Not run yet.",
      detail: "",
    };
  }

  if (result.ok === false) {
    return {
      outcome: readServiceString(result.errorCode, "worker_request_failed"),
      detail: readServiceString(result.error, result.message, "Job failed."),
    };
  }

  const outcome = readServiceString(result.message, result.summary, result.status, "Completed.");
  const detail = readServiceString(result.result, result.output, result.detail, formatWorkerTaskLabel(taskType));

  return {
    outcome,
    detail,
  };
}

function summarizeWorkerCapabilities(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const supportedCount = list.filter((entry) => entry.supported !== false).length;

  return {
    count: list.length,
    supportedCount,
    preview: list.slice(0, 6),
  };
}

function getWorkerJobTarget(worker, input = {}) {
  return readServiceString(
    input.repoPath,
    input.filePath,
    input.targetService,
    input.targetHost,
    input.url,
    worker?.baseUrl,
    "",
  );
}

function supportsSafePm2Task(entries) {
  return Array.isArray(entries) && entries.some((entry) => /pm2[_-\s]?jlist/i.test(`${entry.key || ""} ${entry.label || ""} ${entry.detail || ""}`));
}

function supportsWorkerTask(entries, taskPattern) {
  return Array.isArray(entries) && entries.some((entry) => taskPattern.test(`${entry.key || ""} ${entry.label || ""} ${entry.detail || ""}`));
}

function getWorkerStateLine(worker) {
  const parts = [];

  if (worker?.host) {
    parts.push(worker.host);
  }

  if (worker?.role) {
    parts.push(worker.role);
  }

  return parts.join(" · ");
}

function getRestartConfirmationText(restartSupported) {
  return restartSupported
    ? "Operator approval is required before execution; verify the target service, host, impact, and rollback note first."
    : "Restart is blocked for this service from the current executor.";
}

function getRestartLifecycleText(latestRestartAction, restartSupported, requestedBy) {
  if (latestRestartAction?.status) {
    return formatStatusLabel(latestRestartAction.status);
  }

  if (!restartSupported) {
    return "Unavailable";
  }

  if (requestedBy) {
    return "Draft";
  }

  return "Awaiting request";
}

function formatBadgeLabel(value) {
  const text = String(value || "").trim();

  if (!text) {
    return "Unknown";
  }

  return text.charAt(0).toUpperCase() + text.slice(1);
}

const AUDIT_FRESH_WINDOW_MS = 15 * 60 * 1000;

const STATUS_LABELS = {
  ok: "OK",
  supported: "Available",
  unsupported: "Unavailable",
  "pending-env-or-not-started": "Needs setup",
};

function formatStatusLabel(value) {
  const normalized = String(value || "unknown").trim().toLowerCase();

  if (!normalized) {
    return "Unknown";
  }

  if (STATUS_LABELS[normalized]) {
    return STATUS_LABELS[normalized];
  }

  return normalized
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => {
      if (part === "pm2") {
        return "PM2";
      }

      return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
    })
    .join(" ");
}

function formatDependencyFreshnessLabel(value) {
  const normalized = String(value || "unknown").trim().toLowerCase();

  if (!normalized || normalized === "unknown") {
    return "Unknown freshness";
  }

  return formatStatusLabel(normalized);
}

function statusClassName(value) {
  return `status-${String(value || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")}`;
}

function isAuditEntryFresh(entry, now = Date.now()) {
  const createdAt = new Date(entry?.createdAt).getTime();

  if (!Number.isFinite(createdAt)) {
    return false;
  }

  return now - createdAt <= AUDIT_FRESH_WINDOW_MS;
}

function approvalGateTone(policy) {
  if (policy === "refresh-required" || policy === "unsupported") {
    return "dangerous";
  }

  if (policy === "acknowledge-stale-context") {
    return "caution";
  }

  return "unknown";
}

function ApprovalFreshnessSection({
  approvalContext,
  onRefreshInventory = null,
  refreshBusy = false,
  refreshError = "",
}) {
  const inventoryFreshness = approvalContext?.inventoryFreshness;
  const serviceFreshness = approvalContext?.serviceFreshness;
  const dependencyRollup = approvalContext?.dependencyRollup;
  const dependencyWarnings = Array.isArray(approvalContext?.dependencyWarnings) ? approvalContext.dependencyWarnings : [];
  const showSection = Boolean(
    approvalContext &&
      approvalContext.riskProfile?.riskLevel !== "safe" &&
      inventoryFreshness &&
      typeof inventoryFreshness === "object",
  );

  if (!showSection) {
    return null;
  }

  const inventorySummary = formatApprovalFreshnessSummary(inventoryFreshness, inventoryFreshness.label);
  const serviceFreshnessSummary = formatApprovalFreshnessSummary(serviceFreshness);
  const showRefreshInventoryAction =
    typeof onRefreshInventory === "function" &&
    (inventoryFreshness.bucket === "stale" ||
      inventoryFreshness.bucket === "unknown" ||
      Boolean(inventoryFreshness.sourceHint));
  const gateTone = approvalGateTone(approvalContext.gate?.policy);

  return (
    <div className="approval-freshness-section">
      <div className="detail-header approval-freshness-header">
        <span className="detail-label">Freshness context</span>
        {showRefreshInventoryAction ? (
          <button
            type="button"
            className="mini-button"
            onClick={(event) => {
              event.stopPropagation();
              onRefreshInventory(event);
            }}
            disabled={refreshBusy}
          >
            {refreshBusy ? "Refreshing..." : "Refresh Inventory"}
          </button>
        ) : null}
      </div>

      <div className="service-inventory-freshness approval-freshness-row">
        <span
          className={`signal-freshness-badge signal-freshness-badge-${inventoryFreshness.bucket}`}
          title={inventorySummary || inventoryFreshness.title || inventoryFreshness.label}
        >
          {inventoryFreshness.label}
        </span>
        {inventoryFreshness.ageHint ? <span className="signal-freshness-summary">{inventoryFreshness.ageHint}</span> : null}
        {inventoryFreshness.provenanceText ? (
          <span className="service-inventory-provenance">{inventoryFreshness.provenanceText}</span>
        ) : null}
      </div>

      <div
        className="service-inventory-sources approval-freshness-sources"
        title={
          inventoryFreshness.sourceBreakdownTitle || inventoryFreshness.sourceBreakdownSummary || "Sources: unknown"
        }
      >
        <span className="service-inventory-sources-label">Sources:</span>
        {inventoryFreshness.sourceBreakdown.length ? (
          inventoryFreshness.sourceBreakdown.map((source) => (
            <span
              key={source.key}
              className={`signal-freshness-badge signal-freshness-badge-${source.bucket} service-inventory-source-chip`}
              title={source.title || source.compactLabel}
            >
              {source.compactLabel}
            </span>
          ))
        ) : (
          <span className="service-inventory-sources-empty">unknown</span>
        )}
      </div>

      {inventoryFreshness.sourceHint ? (
        <div className="approval-freshness-note" title={inventoryFreshness.sourceHintTitle || inventoryFreshness.sourceHint}>
          {inventoryFreshness.sourceHint}
        </div>
      ) : null}
      {inventoryFreshness.hint ? <div className="approval-freshness-note">{inventoryFreshness.hint}</div> : null}

      {serviceFreshness ? (
        <div className="approval-freshness-service">
          <span className="detail-label">Selected service freshness</span>
          <div className="service-inventory-freshness approval-freshness-row">
            <span
              className={`signal-freshness-badge signal-freshness-badge-${serviceFreshness.bucket}`}
              title={serviceFreshnessSummary || serviceFreshness.timestamp || serviceFreshness.label}
            >
              {serviceFreshness.label || "Unknown freshness"}
            </span>
            {serviceFreshness.ageLabel ? (
              <span className="signal-freshness-summary">checked {serviceFreshness.ageLabel} ago</span>
            ) : null}
            {serviceFreshness.timestampSource ? (
              <span className="service-inventory-provenance">Based on {serviceFreshness.timestampSource}</span>
            ) : null}
          </div>
        </div>
      ) : null}

      {dependencyRollup ? (
        <div className="approval-freshness-dependencies">
          <span className="detail-label">Dependency freshness</span>
          <div className="service-inventory-freshness approval-freshness-row">
            <span className={`signal-freshness-badge signal-freshness-badge-${dependencyRollup.freshnessSummary.includes("stale") ? "stale" : dependencyRollup.freshnessSummary.includes("unknown") ? "unknown" : dependencyRollup.freshnessSummary.includes("aging") ? "aging" : "fresh"}`}>
              {dependencyRollup.freshnessSummary}
            </span>
            <span className="signal-freshness-summary">
              {dependencyRollup.declaredCount} dependenc{dependencyRollup.declaredCount === 1 ? "y" : "ies"} declared
            </span>
          </div>
          {dependencyWarnings.length ? (
            <div className="approval-freshness-note-list">
              {dependencyWarnings.map((warning) => (
                <div key={warning} className="approval-freshness-note">
                  {warning}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {approvalContext.gate?.message || approvalContext.gate?.refreshGuidance ? (
        <div className={`approval-gate-callout approval-gate-callout-${gateTone}`}>
          {approvalContext.gate?.message ? <div>{approvalContext.gate.message}</div> : null}
          {approvalContext.gate?.refreshGuidance ? <div>{approvalContext.gate.refreshGuidance}</div> : null}
        </div>
      ) : null}
      {refreshError ? <div className="error-text">Inventory refresh failed: {refreshError}</div> : null}
    </div>
  );
}

function WorkerEvidencePanel() {
  const [workers, setWorkers] = useState([]);
  const [selectedWorkerId, setSelectedWorkerId] = useState("");
  const [workerEvidence, setWorkerEvidence] = useState({});
  const [workerRegistryCheckedAt, setWorkerRegistryCheckedAt] = useState(null);
  const [loadingAction, setLoadingAction] = useState("");
  const [error, setError] = useState(null);

  const selectedWorker =
    workers.find((worker) => worker.id === selectedWorkerId) ||
    workers.find((worker) => worker.id === "windows-runtime") ||
    workers[0] ||
    null;
  const selectedWorkerLabel = getWorkerDisplayName(selectedWorker);
  const selectedWorkerIsWindows = selectedWorker?.host === "windows";
  const selectedWorkerIsFedora = selectedWorker?.host === "fedora";
  const selectedWorkerIsFedoraInfra = selectedWorker?.id === "fedora-infra";
  const selectedWorkerIsFedoraBootstrap = selectedWorker?.id === "fedora-bootstrap";
  const selectedWorkerIsFedoraRepo = selectedWorker?.id === "fedora-repo";
  const selectedWorkerEvidence = selectedWorker ? workerEvidence[selectedWorker.id] || createWorkerEvidenceSnapshot() : createWorkerEvidenceSnapshot();
  const selectedWorkerCapabilities = Array.isArray(selectedWorkerEvidence.capabilities?.entries)
    ? selectedWorkerEvidence.capabilities.entries
    : [];
  const selectedWorkerCapabilitySummary = summarizeWorkerCapabilities(selectedWorkerCapabilities);
  const selectedWorkerHasPm2Task = supportsSafePm2Task(selectedWorkerCapabilities);
  const selectedWorkerHasSystemPulseTask = selectedWorkerIsFedoraInfra || supportsWorkerTask(selectedWorkerCapabilities, /system[_-\s]?pulse/i);
  const selectedWorkerHasTemplatesTask = selectedWorkerIsFedoraBootstrap || supportsWorkerTask(selectedWorkerCapabilities, /\btemplates?\b/i);
  const selectedWorkerHasGitStatusTask = selectedWorkerIsFedoraRepo || supportsWorkerTask(selectedWorkerCapabilities, /\bgit[_-\s]?status\b/i);
  const selectedWorkerHasGitDiffStatTask = selectedWorkerIsFedoraRepo || supportsWorkerTask(selectedWorkerCapabilities, /\bgit[_-\s]?diff[_-\s]?stat\b/i);
  const selectedWorkerHasNodeCheckTask = selectedWorkerIsFedoraRepo || supportsWorkerTask(selectedWorkerCapabilities, /\bnode[_-\s]?check\b/i);
  const selectedWorkerHasPackageScriptsTask = selectedWorkerIsFedoraRepo || supportsWorkerTask(selectedWorkerCapabilities, /\bpackage[_-\s]?scripts\b/i);
  const selectedWorkerHealthSummary = selectedWorkerEvidence.health?.summary || "Not checked yet.";
  const selectedWorkerHealthLabel = selectedWorkerEvidence.health
    ? selectedWorkerEvidence.health.ok
      ? "healthy"
      : "attention"
    : "not checked";
  const selectedWorkerLastCheckedAt = selectedWorkerEvidence.lastCheckedAt || workerRegistryCheckedAt || null;
  const selectedWorkerLastJobAt = selectedWorkerEvidence.lastJobAt || null;
  const windowsWorkerMissing = !workers.some((worker) => worker.id === "windows-runtime");
  const workerUnavailableMessage = windowsWorkerMissing
    ? "Windows runtime worker is not currently registered. It may be stopped or its registry entry may be missing."
    : selectedWorker && !selectedWorker.authConfigured
      ? `${selectedWorkerLabel} may be stopped or token/config may be missing.`
      : "";

  function updateWorkerEvidence(workerId, updater) {
    setWorkerEvidence((previous) => {
      const current = previous[workerId] || createWorkerEvidenceSnapshot();
      const next = updater(current) || current;

      return {
        ...previous,
        [workerId]: next,
      };
    });
  }

  async function callWorkerRoute(worker, path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 12000);

    try {
      const response = await fetch(`/api/workers/${worker.id}${path}`, {
        method: options.method || "GET",
        headers: options.body
          ? {
              "Content-Type": "application/json",
            }
          : undefined,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });

      const data = await response.json().catch(() => null);

      if (data == null) {
        return {
          ok: false,
          error: {
            code: "invalid_worker_response",
            message: "Worker did not return JSON.",
          },
        };
      }

      const responseData = toPlainObject(data);

      if (!response.ok || responseData.ok === false) {
        return {
          ok: false,
          data: responseData,
          error: normalizeWorkerError(
            responseData.result || responseData,
            responseData.result?.errorCode || responseData.errorCode || `http_${response.status}`,
            responseData.result?.error || responseData.error || `${path} failed.`,
          ),
        };
      }

      return {
        ok: true,
        data: responseData,
      };
    } catch (requestError) {
      return {
        ok: false,
        error: {
          code: requestError?.name === "AbortError" ? "worker_timeout" : "worker_request_failed",
          message: requestError?.name === "AbortError" ? "Worker request timed out." : "Worker request failed.",
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function loadWorkerHealth(worker, { quiet = false } = {}) {
    if (!worker) {
      return;
    }

    if (!quiet) {
      setLoadingAction("health");
      setError(null);
    }

    const checkedAt = new Date().toISOString();
    const response = await callWorkerRoute(worker, "/health", { timeoutMs: 8000 });
    const result = response.data?.result || {};

    if (!response.ok) {
      updateWorkerEvidence(worker.id, (current) => ({
        ...current,
        health: {
          checkedAt,
          ok: false,
          source: getWorkerDisplayName(worker),
          taskType: "health",
          target: "/health",
          summary: response.error?.message || "Health check failed.",
          error: response.error,
        },
        lastCheckedAt: checkedAt,
      }));
      setError(response.error);
    } else {
      updateWorkerEvidence(worker.id, (current) => ({
        ...current,
        health: {
          checkedAt,
          ok: result.ok !== false,
          source: getWorkerDisplayName(worker),
          taskType: "health",
          target: "/health",
          status: formatWorkerStatusValue(result.status || result.state),
          summary: summarizeWorkerHealthResult(result),
          error: result.ok === false ? normalizeWorkerError(result, "worker_health_failed", "Health check failed.") : null,
        },
        lastCheckedAt: checkedAt,
      }));
      if (!quiet) {
        setError(null);
      }
    }

    if (!quiet) {
      setLoadingAction("");
    }
  }

  async function loadWorkerCapabilities(worker, { quiet = false } = {}) {
    if (!worker) {
      return;
    }

    if (!quiet) {
      setLoadingAction("capabilities");
      setError(null);
    }

    const checkedAt = new Date().toISOString();
    const response = await callWorkerRoute(worker, "/capabilities", { timeoutMs: 8000 });
    const result = response.data?.result || {};

    if (!response.ok) {
      updateWorkerEvidence(worker.id, (current) => ({
        ...current,
        capabilities: {
          checkedAt,
          ok: false,
          source: getWorkerDisplayName(worker),
          taskType: "capabilities",
          target: "/v1/capabilities",
          entries: [],
          summary: response.error?.message || "Capabilities request failed.",
          error: response.error,
        },
        lastCheckedAt: checkedAt,
      }));
      setError(response.error);
    } else {
      const entries = extractWorkerCapabilityEntries(result);
      const capabilitySummary = summarizeWorkerCapabilities(entries);

      updateWorkerEvidence(worker.id, (current) => ({
        ...current,
        capabilities: {
          checkedAt,
          ok: result.ok !== false,
          source: getWorkerDisplayName(worker),
          taskType: "capabilities",
          target: "/v1/capabilities",
          entries,
          supportedCount: capabilitySummary.supportedCount,
          count: capabilitySummary.count,
          summary:
            capabilitySummary.count > 0
              ? `${capabilitySummary.supportedCount} supported / ${capabilitySummary.count} reported`
              : "No capabilities reported.",
          error: result.ok === false ? normalizeWorkerError(result, "worker_capabilities_failed", "Capabilities request failed.") : null,
        },
        lastCheckedAt: checkedAt,
      }));
      if (!quiet) {
        setError(null);
      }
    }

    if (!quiet) {
      setLoadingAction("");
    }
  }

  async function runWorkerJob(worker, jobType, input = {}, { quiet = false, title = "" } = {}) {
    if (!worker) {
      return;
    }

    if (!quiet) {
      setLoadingAction(jobType);
      setError(null);
    }

    const checkedAt = new Date().toISOString();
    const body = {
      jobId: `garage_worker_${jobType}_${Date.now()}`,
      taskType: jobType,
      targetHost: worker.host,
      targetService: input.targetService || null,
      input,
    };
    const target = getWorkerJobTarget(worker, input);
    const response = await callWorkerRoute(worker, "/jobs", {
      method: "POST",
      body,
      timeoutMs: 30000,
    });
    const result = response.data?.result || {};
    const taskLabel = title || formatWorkerTaskLabel(jobType);
    const jobSummary = summarizeWorkerJobResult(result, jobType);
    const jobEntry = response.ok
      ? {
          checkedAt,
          ok: result.ok !== false,
          source: getWorkerDisplayName(worker),
          taskType: jobType,
          taskLabel,
          target,
          summary: jobSummary.outcome,
          detail: jobSummary.detail,
          error: result.ok === false ? normalizeWorkerError(result, "worker_job_failed", "Job failed.") : null,
        }
      : {
          checkedAt,
          ok: false,
          source: getWorkerDisplayName(worker),
          taskType: jobType,
          taskLabel,
          target,
          summary: response.error?.code || "worker_job_failed",
          detail: response.error?.message || "Job failed.",
          error: response.error,
        };

    updateWorkerEvidence(worker.id, (current) => ({
      ...current,
      jobResults: [jobEntry, ...(current.jobResults || [])].slice(0, 6),
      lastCheckedAt: checkedAt,
      lastJobAt: checkedAt,
    }));

    if (!response.ok) {
      setError(response.error);
    } else if (!quiet) {
      setError(null);
    }

    if (!quiet) {
      setLoadingAction("");
    }
  }

  async function hydrateWorkerEvidence(worker) {
    if (!worker) {
      return;
    }

    if (!worker.authConfigured) {
      setError({
        scope: "registry",
        code: "worker_auth_not_configured",
        message: `${getWorkerDisplayName(worker)} may be stopped or token/config may be missing.`,
      });
      return;
    }

    await Promise.allSettled([loadWorkerHealth(worker, { quiet: true }), loadWorkerCapabilities(worker, { quiet: true })]);
  }

  async function loadWorkers() {
    setLoadingAction("workers");
    setError(null);

    try {
      const response = await fetch("/api/workers");
      const data = await response.json();

      if (!response.ok || !data.ok) {
        throw new Error(data.error || data.errorCode || "Worker registry request failed.");
      }

      const items = Array.isArray(data.items) ? data.items : [];
      setWorkers(items);
      setWorkerRegistryCheckedAt(new Date().toISOString());

      const nextWorker = items.find((worker) => worker.id === "windows-runtime") || items[0] || null;

      if (nextWorker?.id) {
        setSelectedWorkerId(nextWorker.id);
      } else {
        setSelectedWorkerId("");
      }

      if (!items.length) {
        setError({
          scope: "registry",
          code: "worker_registry_empty",
          message: "No workers are registered in the backend registry.",
        });
        return;
      }

    if (!nextWorker || nextWorker.id !== "windows-runtime") {
      setError({
        scope: "registry",
        code: "windows_runtime_unavailable",
        message: "Windows runtime worker is not currently registered. It may be stopped or its registry entry may be missing.",
        });
        return;
      }

      await hydrateWorkerEvidence(nextWorker);
    } catch (requestError) {
      setError({
        scope: "registry",
        code: "worker_registry_failed",
        message: requestError.message || "Worker registry request failed.",
      });
    } finally {
      setLoadingAction("");
    }
  }

  function handleWorkerSelect(event) {
    const nextWorkerId = event.target.value;
    setSelectedWorkerId(nextWorkerId);
    setError(null);

    const nextWorker = workers.find((worker) => worker.id === nextWorkerId) || null;

    if (nextWorker?.authConfigured) {
      hydrateWorkerEvidence(nextWorker).catch(() => {});
    } else if (nextWorker) {
      setError({
        scope: "registry",
        code: "worker_auth_not_configured",
        message: `${getWorkerDisplayName(nextWorker)} may be stopped or token/config may be missing.`,
      });
    }
  }

  function runGarageHealthJob() {
    if (!selectedWorker) {
      return;
    }

    return runWorkerJob(
      selectedWorker,
      "ping_url",
      {
        url: "http://127.0.0.1:4010/health",
        targetService: "garage-admin-v2",
      },
      {
        title: "Check Garage Admin health",
      },
    );
  }

  function runSafePm2Job() {
    if (!selectedWorker || !selectedWorkerHasPm2Task) {
      return;
    }

    return runWorkerJob(
      selectedWorker,
      "pm2_jlist",
      {
        targetService: "garage-admin-v2",
      },
      {
        title: "Fetch PM2 status",
      },
    );
  }

  function runFedoraRepoJob(jobType, input = {}, title = "") {
    if (!selectedWorker || !selectedWorkerIsFedoraRepo) {
      return;
    }

    return runWorkerJob(selectedWorker, jobType, input, {
      title,
    });
  }

  function runFedoraRepoGitStatusJob() {
    return runFedoraRepoJob(
      "git_status",
      {
        repoPath: FEDORA_REPO_BOOTSTRAP_PATH,
      },
      "Fetch Fedora repo git status",
    );
  }

  function runFedoraRepoPackageScriptsJob() {
    return runFedoraRepoJob(
      "package_scripts",
      {
        repoPath: FEDORA_REPO_BOOTSTRAP_PATH,
      },
      "Inspect package scripts",
    );
  }

  function runFedoraRepoGitDiffStatJob() {
    return runFedoraRepoJob(
      "git_diff_stat",
      {
        repoPath: FEDORA_REPO_BOOTSTRAP_PATH,
      },
      "Fetch Fedora repo diff stat",
    );
  }

  function runFedoraRepoNodeCheckJob() {
    return runFedoraRepoJob(
      "node_check",
      {
        filePath: FEDORA_REPO_NODE_CHECK_FILE,
      },
      "Run Node check on Fedora repo file",
    );
  }

  useEffect(() => {
    loadWorkers().catch(() => {});
  }, []);

  return (
    <section className="panel-card worker-evidence-card">
      <div className="panel-heading">
        <div>
          <span className="section-title">Workers</span>
          <h2>Worker Evidence</h2>
          <p>Read-only operational evidence for Garage Admin V2 and Fedora helper-backed checks. No restarts, writes, deletes, rebuilds, or shell access.</p>
        </div>
        <button type="button" className="mini-button" onClick={loadWorkers} disabled={Boolean(loadingAction)}>
          {loadingAction === "workers" ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {workers.length ? (
        <>
          <div className="worker-registry-grid">
            {workers.map((worker) => {
              const isSelected = worker.id === selectedWorker?.id;

              return (
                <article key={worker.id} className={`worker-registry-card ${isSelected ? "is-selected" : ""}`}>
                  <div className="detail-header">
                    <div>
                      <span className="detail-label">{worker.id === "fedora-repo" ? "Fedora repo worker" : getWorkerStateLine(worker) || "Worker"}</span>
                      <h3>{getWorkerDisplayName(worker)}</h3>
                    </div>
                    <span className={`status-badge ${worker.authConfigured ? "status-completed" : "status-failed"}`}>{worker.authConfigured ? "auth configured" : "auth missing"}</span>
                  </div>
                  <div className="worker-registry-card-meta">
                    <span className="status-badge status-info">{worker.host}</span>
                    <span className="status-badge status-info">{worker.role}</span>
                    <span className="status-badge status-info">{getWorkerRegistrySource(worker)}</span>
                  </div>
                  <div className="worker-registry-card-copy" title={worker.baseUrl || ""}>
                    {worker.baseUrl || "Not configured"}
                  </div>
                  <button type="button" className="mini-button worker-registry-card-select" onClick={() => setSelectedWorkerId(worker.id)}>
                    {isSelected ? "Selected" : "Select"}
                  </button>
                </article>
              );
            })}
          </div>

          <div className="worker-evidence-toolbar">
            <label className="worker-evidence-select-label">
              <span className="detail-label">Worker</span>
              <select className="worker-evidence-select" value={selectedWorker?.id || ""} onChange={handleWorkerSelect}>
                {workers.map((worker) => (
                  <option key={worker.id} value={worker.id}>
                    {worker.name || worker.id}
                  </option>
                ))}
              </select>
            </label>

            {selectedWorker ? (
              <div className="worker-evidence-summary">
                <span className="status-badge status-info">{selectedWorker.host}</span>
                <span className="status-badge status-info">{selectedWorker.role}</span>
                <span className="status-badge status-info">{getWorkerRegistrySource(selectedWorker)}</span>
                <span className={`status-badge ${selectedWorker.authConfigured ? "status-completed" : "status-failed"}`}>
                  {selectedWorker.authConfigured ? "auth configured" : "auth missing"}
                </span>
              </div>
            ) : null}
          </div>

          <div className="worker-summary-grid">
            <div className="worker-summary-main">
              <div className="detail-header">
                <div>
                  <span className="detail-label">{selectedWorkerIsFedoraRepo ? "Fedora repo worker" : selectedWorkerIsFedora ? "Fedora worker" : "Windows runtime worker"}</span>
                  <h3>{selectedWorkerLabel}</h3>
                </div>
                <span className={`status-badge ${selectedWorkerEvidence.health ? (selectedWorkerEvidence.health.ok ? "status-completed" : "status-failed") : "status-unknown"}`}>
                  {selectedWorkerHealthLabel}
                </span>
              </div>

              <div className="worker-summary-detail-grid">
                <div className="detail-item">
                  <span className="detail-label">Name</span>
                  <span className="detail-value" title={selectedWorkerLabel}>
                    {selectedWorkerLabel}
                  </span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">ID</span>
                  <span className="detail-value">{selectedWorker?.id || "windows-runtime"}</span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">Host / role</span>
                  <span className="detail-value">{getWorkerStateLine(selectedWorker)}</span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">Base URL</span>
                  <span className="detail-value" title={selectedWorker?.baseUrl || ""}>
                    {selectedWorker?.baseUrl || "http://127.0.0.1:4091"}
                  </span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">Base route source</span>
                  <span className="detail-value">{getWorkerRegistrySource(selectedWorker)}</span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">Health status</span>
                  <span className="detail-value">{selectedWorkerHealthSummary}</span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">Capabilities</span>
                  <span className="detail-value">
                    {selectedWorkerCapabilitySummary.count > 0
                      ? `${selectedWorkerCapabilitySummary.supportedCount} supported / ${selectedWorkerCapabilitySummary.count} reported`
                      : "Not loaded yet."}
                  </span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">Last checked</span>
                  <span className="detail-value">{formatCreatedAt(selectedWorkerLastCheckedAt)}</span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">Last job result</span>
                  <span className="detail-value">{selectedWorkerLastJobAt ? formatCreatedAt(selectedWorkerLastJobAt) : "Not run yet"}</span>
                </div>
              </div>

              <div className="worker-capability-chip-row">
                {selectedWorkerCapabilities.length ? (
                  selectedWorkerCapabilitySummary.preview.map((entry) => (
                    <span
                      key={entry.key}
                      className={`status-badge ${entry.supported ? "status-supported" : "status-unknown"} worker-capability-chip`}
                      title={entry.detail || entry.label}
                    >
                      {entry.label}
                    </span>
                  ))
                ) : (
                  <span className="empty-state">Capabilities are loaded on demand and shown as read-only evidence.</span>
                )}
                {selectedWorkerCapabilities.length > selectedWorkerCapabilitySummary.preview.length ? (
                  <span className="status-badge status-unknown worker-capability-chip">
                    +{selectedWorkerCapabilities.length - selectedWorkerCapabilitySummary.preview.length} more
                  </span>
                ) : null}
              </div>
            </div>
          </div>

          <div className="worker-job-grid">
            <button
              type="button"
              className="worker-job-card"
              onClick={() => loadWorkerHealth(selectedWorker)}
              disabled={!selectedWorker || Boolean(loadingAction)}
            >
              <span className="detail-label">Check worker health</span>
              <span className="worker-job-card-copy">GET /api/workers/:id/health</span>
              <span className={`status-badge ${loadingAction === "health" ? "status-executing" : selectedWorkerEvidence.health?.ok ? "status-completed" : "status-unknown"}`}>
                {loadingAction === "health" ? "checking" : selectedWorkerEvidence.health ? (selectedWorkerEvidence.health.ok ? "healthy" : "attention") : "run"}
              </span>
            </button>

            <button
              type="button"
              className="worker-job-card"
              onClick={() => loadWorkerCapabilities(selectedWorker)}
              disabled={!selectedWorker || Boolean(loadingAction)}
            >
              <span className="detail-label">Load capabilities</span>
              <span className="worker-job-card-copy">GET /api/workers/:id/capabilities</span>
              <span className={`status-badge ${loadingAction === "capabilities" ? "status-executing" : selectedWorkerCapabilities.length ? "status-completed" : "status-unknown"}`}>
                {loadingAction === "capabilities" ? "loading" : selectedWorkerCapabilities.length ? `${selectedWorkerCapabilities.length} reported` : "run"}
              </span>
            </button>

            {selectedWorkerIsWindows ? (
              <>
                <button
                  type="button"
                  className="worker-job-card"
                  onClick={runGarageHealthJob}
                  disabled={!selectedWorker || Boolean(loadingAction)}
                >
                  <span className="detail-label">Check Garage Admin health via worker</span>
                  <span className="worker-job-card-copy">ping_url to http://127.0.0.1:4010/health</span>
                  <span className={`status-badge ${loadingAction === "ping_url" ? "status-executing" : "status-info"}`}>read-only</span>
                </button>

                <button
                  type="button"
                  className="worker-job-card"
                  onClick={runSafePm2Job}
                  disabled={!selectedWorker || Boolean(loadingAction) || !selectedWorkerHasPm2Task}
                >
                  <span className="detail-label">Fetch safe PM2 status</span>
                  <span className="worker-job-card-copy">
                    {selectedWorkerHasPm2Task ? "pm2_jlist read-only task" : "Not advertised by this worker"}
                  </span>
                  <span className={`status-badge ${selectedWorkerHasPm2Task ? "status-supported" : "status-unknown"}`}>
                    {selectedWorkerHasPm2Task ? "supported" : "hidden"}
                  </span>
                </button>
              </>
            ) : null}

            {selectedWorkerIsFedora ? (
              <>
                {selectedWorkerIsFedoraInfra ? (
                  <button
                    type="button"
                    className="worker-job-card"
                    onClick={() =>
                      runWorkerJob(
                        selectedWorker,
                        "system_pulse",
                        {
                          targetService: selectedWorker.id,
                        },
                        {
                          title: "Run Fedora system pulse",
                        },
                      )
                    }
                    disabled={!selectedWorker || Boolean(loadingAction)}
                  >
                    <span className="detail-label">Run system pulse</span>
                    <span className="worker-job-card-copy">
                      {selectedWorkerHasSystemPulseTask ? "system_pulse read-only task" : "Not advertised by this worker"}
                    </span>
                    <span className={`status-badge ${selectedWorkerHasSystemPulseTask ? "status-supported" : "status-unknown"}`}>
                      {selectedWorkerHasSystemPulseTask ? "supported" : "hidden"}
                    </span>
                  </button>
                ) : null}

                {selectedWorkerIsFedoraBootstrap ? (
                  <button
                    type="button"
                    className="worker-job-card"
                    onClick={() =>
                      runWorkerJob(
                        selectedWorker,
                        "templates",
                        {
                          targetService: selectedWorker.id,
                        },
                        {
                          title: "Inspect templates",
                        },
                      )
                    }
                    disabled={!selectedWorker || Boolean(loadingAction)}
                  >
                    <span className="detail-label">Inspect templates</span>
                    <span className="worker-job-card-copy">
                      {selectedWorkerHasTemplatesTask ? "templates read-only task" : "Not advertised by this worker"}
                    </span>
                    <span className={`status-badge ${selectedWorkerHasTemplatesTask ? "status-supported" : "status-unknown"}`}>
                      {selectedWorkerHasTemplatesTask ? "supported" : "hidden"}
                    </span>
                  </button>
                ) : null}
              </>
            ) : null}

            {selectedWorkerIsFedoraRepo ? (
              <>
                <button
                  type="button"
                  className="worker-job-card"
                  onClick={runFedoraRepoGitStatusJob}
                  disabled={!selectedWorker || Boolean(loadingAction) || !selectedWorkerHasGitStatusTask}
                >
                  <span className="detail-label">Git status</span>
                  <span className="worker-job-card-copy">{FEDORA_REPO_BOOTSTRAP_PATH}</span>
                  <span className={`status-badge ${selectedWorkerHasGitStatusTask ? "status-supported" : "status-unknown"}`}>
                    {selectedWorkerHasGitStatusTask ? "supported" : "hidden"}
                  </span>
                </button>

                <button
                  type="button"
                  className="worker-job-card"
                  onClick={runFedoraRepoPackageScriptsJob}
                  disabled={!selectedWorker || Boolean(loadingAction) || !selectedWorkerHasPackageScriptsTask}
                >
                  <span className="detail-label">Package scripts</span>
                  <span className="worker-job-card-copy">{FEDORA_REPO_BOOTSTRAP_PATH}</span>
                  <span className={`status-badge ${selectedWorkerHasPackageScriptsTask ? "status-supported" : "status-unknown"}`}>
                    {selectedWorkerHasPackageScriptsTask ? "supported" : "hidden"}
                  </span>
                </button>

                <button
                  type="button"
                  className="worker-job-card"
                  onClick={runFedoraRepoGitDiffStatJob}
                  disabled={!selectedWorker || Boolean(loadingAction) || !selectedWorkerHasGitDiffStatTask}
                >
                  <span className="detail-label">Git diff stat</span>
                  <span className="worker-job-card-copy">{FEDORA_REPO_BOOTSTRAP_PATH}</span>
                  <span className={`status-badge ${selectedWorkerHasGitDiffStatTask ? "status-supported" : "status-unknown"}`}>
                    {selectedWorkerHasGitDiffStatTask ? "supported" : "hidden"}
                  </span>
                </button>

                <button
                  type="button"
                  className="worker-job-card"
                  onClick={runFedoraRepoNodeCheckJob}
                  disabled={!selectedWorker || Boolean(loadingAction) || !selectedWorkerHasNodeCheckTask}
                >
                  <span className="detail-label">Node check</span>
                  <span className="worker-job-card-copy">{FEDORA_REPO_NODE_CHECK_FILE}</span>
                  <span className={`status-badge ${selectedWorkerHasNodeCheckTask ? "status-supported" : "status-unknown"}`}>
                    {selectedWorkerHasNodeCheckTask ? "supported" : "hidden"}
                  </span>
                </button>
              </>
            ) : null}
          </div>

          {error ? (
            <div className="banner error-banner worker-evidence-error">
              <strong>{error.code || "worker_error"}</strong>
              <span>{error.message}</span>
            </div>
          ) : null}

          {workerUnavailableMessage ? <div className="empty-state worker-unavailable-note">{workerUnavailableMessage}</div> : null}

          <div className="worker-evidence-feed">
              <div className="worker-evidence-feed-header">
                <div>
                  <span className="detail-label">Result provenance</span>
                  <p className="worker-evidence-feed-copy">
                  Source: {selectedWorkerLabel}. Read-only evidence only. Timestamps reflect the last observed worker check or job result. Fedora repo jobs use fixed safe paths only.
                  </p>
                </div>
              </div>

            {selectedWorkerEvidence.health ? (
              <article className="worker-evidence-record">
                <div className="detail-header">
                  <span className="detail-label">Worker health</span>
                  <span className={`status-badge ${selectedWorkerEvidence.health.ok ? "status-completed" : "status-failed"}`}>
                    {selectedWorkerEvidence.health.ok ? "ok" : "failed"}
                  </span>
                </div>
                <div className="worker-evidence-record-grid">
                  <div className="detail-item">
                    <span className="detail-label">Source</span>
                    <span className="detail-value">{selectedWorkerEvidence.health.source}</span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Evidence</span>
                    <span className="detail-value">Read-only evidence</span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Task type</span>
                    <span className="detail-value">{selectedWorkerEvidence.health.taskType}</span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Target</span>
                    <span className="detail-value">{selectedWorkerEvidence.health.target}</span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Timestamp</span>
                    <span className="detail-value">{formatCreatedAt(selectedWorkerEvidence.health.checkedAt)}</span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Status</span>
                    <span className="detail-value">{selectedWorkerEvidence.health.status || selectedWorkerEvidence.health.summary}</span>
                  </div>
                </div>
                <p className="worker-evidence-record-copy">{selectedWorkerEvidence.health.summary}</p>
                {selectedWorkerEvidence.health.error ? (
                  <p className="worker-evidence-record-error">
                    {selectedWorkerEvidence.health.error.code}: {selectedWorkerEvidence.health.error.message}
                  </p>
                ) : null}
              </article>
            ) : null}

            {selectedWorkerEvidence.capabilities ? (
              <article className="worker-evidence-record">
                <div className="detail-header">
                  <span className="detail-label">Capabilities</span>
                  <span className={`status-badge ${selectedWorkerEvidence.capabilities.ok ? "status-completed" : "status-failed"}`}>
                    {selectedWorkerEvidence.capabilities.ok ? "loaded" : "failed"}
                  </span>
                </div>
                <div className="worker-evidence-record-grid">
                  <div className="detail-item">
                    <span className="detail-label">Source</span>
                    <span className="detail-value">{selectedWorkerEvidence.capabilities.source}</span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Evidence</span>
                    <span className="detail-value">Read-only evidence</span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Task type</span>
                    <span className="detail-value">{selectedWorkerEvidence.capabilities.taskType}</span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Target</span>
                    <span className="detail-value">{selectedWorkerEvidence.capabilities.target}</span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Timestamp</span>
                    <span className="detail-value">{formatCreatedAt(selectedWorkerEvidence.capabilities.checkedAt)}</span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Reported</span>
                    <span className="detail-value">
                      {selectedWorkerEvidence.capabilities.supportedCount || 0} supported / {selectedWorkerEvidence.capabilities.count || 0} total
                    </span>
                  </div>
                </div>
                <div className="worker-capability-chip-row worker-capability-chip-row-feed">
                  {selectedWorkerCapabilities.length ? (
                    selectedWorkerCapabilities.map((entry) => (
                      <span
                        key={`feed-${entry.key}`}
                        className={`status-badge ${entry.supported ? "status-supported" : "status-unknown"} worker-capability-chip`}
                        title={entry.detail || entry.label}
                      >
                        {entry.label}
                      </span>
                    ))
                  ) : (
                    <span className="empty-state">No capability entries were reported.</span>
                  )}
                </div>
                <p className="worker-evidence-record-copy">{selectedWorkerEvidence.capabilities.summary}</p>
                {selectedWorkerEvidence.capabilities.error ? (
                  <p className="worker-evidence-record-error">
                    {selectedWorkerEvidence.capabilities.error.code}: {selectedWorkerEvidence.capabilities.error.message}
                  </p>
                ) : null}
              </article>
            ) : null}

            {selectedWorkerEvidence.jobResults.length ? (
              <div className="worker-job-feed">
                {selectedWorkerEvidence.jobResults.map((jobResult) => (
                  <article key={`${jobResult.taskType}-${jobResult.checkedAt}`} className="worker-evidence-record">
                    <div className="detail-header">
                      <span className="detail-label">{jobResult.taskLabel}</span>
                      <span className={`status-badge ${jobResult.ok ? "status-completed" : "status-failed"}`}>{jobResult.ok ? "ok" : "failed"}</span>
                    </div>
                    <div className="worker-evidence-record-grid">
                      <div className="detail-item">
                        <span className="detail-label">Source</span>
                        <span className="detail-value">{jobResult.source}</span>
                      </div>
                      <div className="detail-item">
                        <span className="detail-label">Evidence</span>
                        <span className="detail-value">Read-only evidence</span>
                      </div>
                      <div className="detail-item">
                        <span className="detail-label">Task type</span>
                        <span className="detail-value">{jobResult.taskType}</span>
                      </div>
                      <div className="detail-item">
                        <span className="detail-label">Target</span>
                        <span className="detail-value" title={jobResult.target}>
                          {jobResult.target}
                        </span>
                      </div>
                      <div className="detail-item">
                        <span className="detail-label">Timestamp</span>
                        <span className="detail-value">{formatCreatedAt(jobResult.checkedAt)}</span>
                      </div>
                      <div className="detail-item">
                        <span className="detail-label">Result</span>
                        <span className="detail-value">{jobResult.summary}</span>
                      </div>
                    </div>
                    <p className="worker-evidence-record-copy">{jobResult.detail}</p>
                    {jobResult.error ? (
                      <p className="worker-evidence-record-error">
                        {jobResult.error.code}: {jobResult.error.message}
                      </p>
                    ) : null}
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty-state">Run a worker job to capture read-only evidence with provenance.</div>
            )}
          </div>
        </>
      ) : (
        <div className="empty-state">No workers are registered in the backend registry.</div>
      )}
    </section>
  );
}


export default function App() {
  const [incidents, setIncidents] = useState([]);
  const [services, setServices] = useState([]);
  const [serviceInventorySnapshot, setServiceInventorySnapshot] = useState(() => normalizeServiceInventorySnapshot(null));
  const [audit, setAudit] = useState([]);
  const [selectedService, setSelectedService] = useState(null);
  const [selectedIncidentId, setSelectedIncidentId] = useState(null);
  const [activeWorkspaceTab, setActiveWorkspaceTab] = useState("overview");
  const [logs, setLogs] = useState(null);
  const [logsFetchedAt, setLogsFetchedAt] = useState(null);
  const [logFilter, setLogFilter] = useState("");
  const [logAlertOnly, setLogAlertOnly] = useState(false);
  const [logCopyStatus, setLogCopyStatus] = useState("");
  const [resultCopyStatus, setResultCopyStatus] = useState("");
  const [logsArchive, setLogsArchive] = useState([]);
  const [logsDisposition, setLogsDisposition] = useState(null);
  const [healthOutput, setHealthOutput] = useState(null);
  const [healthMeta, setHealthMeta] = useState(null);
  const [healthArchive, setHealthArchive] = useState([]);
  const [healthDisposition, setHealthDisposition] = useState(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [initialError, setInitialError] = useState(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState(null);
  const [showRestartForm, setShowRestartForm] = useState(false);
  const [restartForm, setRestartForm] = useState({
    requestedBy: "",
    approvedBy: "",
    reason: "",
  });
  const [restartSubmitting, setRestartSubmitting] = useState(false);
  const [restartResult, setRestartResult] = useState(null);
  const [restartError, setRestartError] = useState(null);
  const [inventoryRefreshBusy, setInventoryRefreshBusy] = useState(false);
  const [inventoryRefreshError, setInventoryRefreshError] = useState(null);
  const [approvalFreshnessAcknowledgements, setApprovalFreshnessAcknowledgements] = useState({});
  const [actionBusyId, setActionBusyId] = useState(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState(null);
  const [auditFilterMode, setAuditFilterMode] = useState("service");
  const [expandedAuditIds, setExpandedAuditIds] = useState([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState(null);
  const [messages, setMessages] = useState([]);
  const [assistantSelection, setAssistantSelection] = useState(null);
  const [activeAssistantPlanChipId, setActiveAssistantPlanChipId] = useState("");
  const [input, setInput] = useState("");
  const [assistantMode, setAssistantMode] = useState(loadAssistantMode);
  const [assistantTone, setAssistantTone] = useState(loadAssistantTone);
  const [assistantLauncherPosition, setAssistantLauncherPosition] = useState(loadAssistantLauncherPosition);
  const [assistantSeenResponseCount, setAssistantSeenResponseCount] = useState(0);
  const opsGridRef = useRef(null);
  const chatRequestIdRef = useRef(0);
  const skipNextLayoutPersistenceRef = useRef(false);
  const [rightLayout, setRightLayout] = useState(loadInitialRightLayout);
  const [rightPanelResizing, setRightPanelResizing] = useState(false);
  const rightPanelSplit = clampRightPanelSplit(Number(rightLayout.splitRatios?.right));
  const rightPanelOrder = ENABLE_EXPERIMENTAL_LAYOUT_CUSTOMIZATION
    ? normalizeRightPanelOrder(rightLayout.zones?.right)
    : [...DEFAULT_RIGHT_PANEL_ORDER];
  const rightPanelGridAreas = {
    [rightPanelOrder[0]]: "right-top",
    [rightPanelOrder[1]]: "right-bottom",
  };
  const topRightPanelLabel = RIGHT_PANEL_CARD_LABELS[rightPanelOrder[0]] || "Top panel";
  const bottomRightPanelLabel = RIGHT_PANEL_CARD_LABELS[rightPanelOrder[1]] || "Bottom panel";

  useEffect(() => {
    if (skipNextLayoutPersistenceRef.current) {
      skipNextLayoutPersistenceRef.current = false;
      return;
    }

    const normalizedLayout = normalizeExperimentalLayout(rightLayout);

    if (ENABLE_EXPERIMENTAL_LAYOUT_CUSTOMIZATION) {
      saveExperimentalLayout(normalizedLayout);
    } else {
      saveRightPanelSplit(normalizedLayout.splitRatios.right);
    }
  }, [rightLayout]);

  useEffect(() => {
    const handleResize = () => {
      const height = opsGridRef.current?.getBoundingClientRect().height || 0;
      setRightPanelSplit((current) => clampRightPanelSplit(current, height));
    };

    handleResize();
    window.addEventListener("resize", handleResize);

    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    document.body.classList.toggle("is-resizing-right-stack", rightPanelResizing);

    return () => document.body.classList.remove("is-resizing-right-stack");
  }, [rightPanelResizing]);

  useEffect(() => {
    saveAssistantMode(assistantMode);
  }, [assistantMode]);

  useEffect(() => {
    saveAssistantTone(assistantTone);
  }, [assistantTone]);

  useEffect(() => {
    saveAssistantLauncherPosition(assistantLauncherPosition);
  }, [assistantLauncherPosition]);

  useEffect(() => {
    if (assistantMode !== ASSISTANT_MODES.EXPANDED) {
      return undefined;
    }

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setAssistantMode(ASSISTANT_MODES.MINIMIZED);
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [assistantMode]);

  function setRightPanelSplitFromClientY(clientY) {
    const grid = opsGridRef.current;

    if (!grid) {
      return;
    }

    const rect = grid.getBoundingClientRect();
    const availableHeight = Math.max(rect.height - RIGHT_PANEL_RESIZER_PX, 1);
    const rawSplit = (clientY - rect.top - RIGHT_PANEL_RESIZER_PX / 2) / availableHeight;

    setRightPanelSplit(clampRightPanelSplit(rawSplit, rect.height));
  }

  function setRightPanelSplit(nextSplit) {
    setRightLayout((current) => {
      const normalizedLayout = normalizeExperimentalLayout(current);
      const currentSplit = normalizedLayout.splitRatios.right;
      const resolvedSplit = typeof nextSplit === "function" ? nextSplit(currentSplit) : nextSplit;

      return {
        ...normalizedLayout,
        splitRatios: {
          ...normalizedLayout.splitRatios,
          right: clampRightPanelSplit(resolvedSplit),
        },
      };
    });
  }

  function moveRightPanelCard(cardId, direction) {
    setRightLayout((current) => {
      const normalizedLayout = normalizeExperimentalLayout(current);

      return {
        ...normalizedLayout,
        zones: {
          ...normalizedLayout.zones,
          right: moveCardInOrder(normalizedLayout.zones.right, cardId, direction),
        },
      };
    });
  }

  function handleResetLayout() {
    skipNextLayoutPersistenceRef.current = true;
    removeSavedLayoutPreferences();
    setRightLayout(createDefaultExperimentalLayout());
  }

  function handleRightResizerPointerDown(event) {
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setRightPanelResizing(true);
    setRightPanelSplitFromClientY(event.clientY);
  }

  function handleRightResizerPointerMove(event) {
    if (!rightPanelResizing) {
      return;
    }

    event.preventDefault();
    setRightPanelSplitFromClientY(event.clientY);
  }

  function handleRightResizerPointerEnd(event) {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    setRightPanelResizing(false);
  }

  function nudgeRightPanelSplit(delta) {
    const height = opsGridRef.current?.getBoundingClientRect().height || 0;
    setRightPanelSplit((current) => clampRightPanelSplit(current + delta, height));
  }

  function handleRightResizerKeyDown(event) {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      nudgeRightPanelSplit(-0.04);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      nudgeRightPanelSplit(0.04);
    } else if (event.key === "PageUp") {
      event.preventDefault();
      nudgeRightPanelSplit(-0.1);
    } else if (event.key === "PageDown") {
      event.preventDefault();
      nudgeRightPanelSplit(0.1);
    } else if (event.key === "Home") {
      event.preventDefault();
      nudgeRightPanelSplit(-1);
    } else if (event.key === "End") {
      event.preventDefault();
      nudgeRightPanelSplit(1);
    }
  }

  useEffect(() => {
    async function load() {
      setInitialLoading(true);
      setInitialError(null);

      try {
        const [incidentsRes, servicesRes, auditRes] = await Promise.all([
          fetch("/api/memory/incidents"),
          fetch("/api/services"),
          fetch("/api/memory/audit"),
        ]);

        if (!incidentsRes.ok || !servicesRes.ok || !auditRes.ok) {
          throw new Error("Failed to load Garage Admin context");
        }

        const incidentsData = await incidentsRes.json();
        const servicesData = await servicesRes.json();
        const auditData = await auditRes.json();
        const incidentItems = normalizeObjectCollection(incidentsData.items);
        applyServicePayload(servicesData);

        setIncidents(incidentItems);
        setAudit(normalizeObjectCollection(auditData.items));
      } catch (error) {
        setInitialError(error.message);
      } finally {
        setInitialLoading(false);
      }
    }

    load().catch(() => {});
  }, []);

  function applyServicePayload(payload) {
    const serviceItems = normalizeServiceItems(payload?.items || []);
    setServiceInventorySnapshot(normalizeServiceInventorySnapshot(payload));
    setServices(serviceItems);
    setSelectedService((current) => {
      if (current && serviceItems.some((service) => service.name === current)) {
        return current;
      }

      return serviceItems[0]?.name || null;
    });
    return serviceItems;
  }

  async function refreshServices() {
    const servicesRes = await fetch("/api/services");
    const servicesData = await servicesRes.json();

    if (!servicesRes.ok || !servicesData.ok) {
      throw new Error(servicesData.error || "Failed to refresh services");
    }

    return applyServicePayload(servicesData);
  }

  async function handleRefreshInventory(event) {
    event?.stopPropagation?.();
    setInventoryRefreshBusy(true);
    setInventoryRefreshError(null);

    try {
      await refreshServices();
    } catch (error) {
      setInventoryRefreshError(error.message);
    } finally {
      setInventoryRefreshBusy(false);
    }
  }

  function setApprovalFreshnessAcknowledged(actionId, checked) {
    const key = String(actionId || "").trim();

    if (!key) {
      return;
    }

    setApprovalFreshnessAcknowledgements((current) => ({
      ...current,
      [key]: checked === true,
    }));
  }

  async function refreshAudit() {
    setAuditLoading(true);
    setAuditError(null);

    try {
      const auditRes = await fetch("/api/memory/audit");
      if (!auditRes.ok) {
        throw new Error("Failed to refresh audit");
      }

      const auditData = await auditRes.json();
      setAudit(normalizeObjectCollection(auditData.items));
    } catch (error) {
      setAuditError(error.message);
      throw error;
    } finally {
      setAuditLoading(false);
    }
  }

  const incidentItems = normalizeObjectCollection(incidents);
  const serviceItems = normalizeObjectCollection(services);
  const auditItems = normalizeObjectCollection(audit);
  const logsArchiveItems = normalizeObjectCollection(logsArchive);
  const expandedAuditItemIds = normalizeStringArray(expandedAuditIds);
  const chatMessages = normalizeObjectCollection(messages);
  const assistantResponseCount = chatMessages.filter((message) => message.role !== "user").length;
  const assistantLookupItems = [...chatMessages]
    .reverse()
    .flatMap((message) => normalizeObjectCollection(message.lookup?.items));
  const selectedAssistantLookupItem =
    assistantLookupItems.find((item) => isLookupItemSelected(item, assistantSelection)) || null;
  const selectedIncident = incidentItems.find((incident) => incident.id === selectedIncidentId) || null;
  const selectedServiceRecord = serviceItems.find((service) => service.name === selectedService) || null;
  const serviceInventoryFreshness = describeInventoryFreshness(serviceInventorySnapshot, {
    services: serviceItems,
    now: Date.now(),
  });

  useEffect(() => {
    if (assistantMode !== ASSISTANT_MODES.MINIMIZED) {
      setAssistantSeenResponseCount(assistantResponseCount);
      return;
    }

    setAssistantSeenResponseCount((current) => Math.min(current, assistantResponseCount));
  }, [assistantMode, assistantResponseCount]);

  function getApprovalContextForAction(actionType, actionRecord, serviceRecord, dependencyRollup = null) {
    return buildActionApprovalContext({
      actionType,
      actionMetadata: actionRecord,
      service: serviceRecord,
      services: serviceItems,
      inventorySnapshot: serviceInventorySnapshot,
      inventoryFreshness: serviceInventoryFreshness,
      dependencyRollup,
      riskContext: getActionRiskContext(actionType, actionRecord, serviceRecord),
      now: Date.now(),
    });
  }

  function buildActionReviewSnapshotPayload({
    phase = "requested",
    actionType,
    actionRecord,
    serviceRecord = null,
    approvalContext = null,
    requestedBy = "",
    approvedBy = "",
    freshnessAcknowledged = false,
    gateDisabledReason = "",
  } = {}) {
    if (!actionType || !actionRecord) {
      return null;
    }

    return buildActionReviewSnapshot({
      phase,
      actionType,
      actionMetadata: actionRecord,
      service: serviceRecord,
      approvalContext:
        approvalContext ||
        getApprovalContextForAction(actionType, actionRecord, serviceRecord),
      requestedBy,
      approvedBy,
      freshnessAcknowledged,
      gateDisabledReason,
      now: Date.now(),
    });
  }

  useEffect(() => {
    if (!selectedService) {
      setLogs(null);
      setLogsFetchedAt(null);
      setLogFilter("");
      setLogAlertOnly(false);
      setLogCopyStatus("");
      setResultCopyStatus("");
      setLogsDisposition(null);
      setLogsError(null);
      setLogsLoading(false);
      setShowRestartForm(false);
      setRestartResult(null);
      setRestartError(null);
      return;
    }

    const logCapability = actionCapability(selectedServiceRecord, "fetch-logs");

    if (selectedServiceRecord && logCapability.supported === false) {
      setLogs(null);
      setLogsFetchedAt(null);
      setLogFilter("");
      setLogAlertOnly(false);
      setLogCopyStatus("");
      setResultCopyStatus("");
      setLogsDisposition(null);
      setLogsLoading(false);
      setLogsError(capabilityMessage(logCapability, "Logs are unavailable for this service."));
      return;
    }

    const controller = new AbortController();
    let isCurrentRequest = true;

    async function loadLogs() {
      setLogsLoading(true);
      setLogsError(null);
      setLogs(null);
      setLogsFetchedAt(null);
      setLogFilter("");
      setLogAlertOnly(false);
      setLogCopyStatus("");
      setResultCopyStatus("");
      setLogsDisposition(null);

      try {
        const res = await fetch(`/api/services/${encodeURIComponent(selectedService)}/logs`, {
          signal: controller.signal,
        });
        const data = await res.json();

        if (!res.ok || !data.ok) {
          throw new Error(getApiErrorMessage(data, "Failed to load service logs"));
        }

        if (isCurrentRequest) {
          setLogs(typeof data.logs === "string" ? data.logs : getLogText(data));
          setLogsFetchedAt(new Date().toISOString());
          setLogsDisposition(null);
        }
      } catch (error) {
        if (error.name === "AbortError" || !isCurrentRequest) {
          return;
        }

        setLogs(null);
        setLogsError(error.message);
      } finally {
        if (isCurrentRequest) {
          setLogsLoading(false);
        }
      }
    }

    loadLogs().catch(() => {});

    return () => {
      isCurrentRequest = false;
      controller.abort();
    };
  }, [selectedService, selectedServiceRecord]);

  useEffect(() => {
    chatRequestIdRef.current += 1;
    setMessages([]);
    setAssistantSelection(null);
    setActiveAssistantPlanChipId("");
    setInput("");
    setChatError(null);
    setChatLoading(false);
  }, [selectedService]);

  function handleServiceSelect(serviceName) {
    setSelectedService(serviceName);
  }

  function handleIncidentSelect(incident) {
    setSelectedIncidentId(incident.id);
    setSelectedService(incident.serviceName || null);
  }

  function handleRestartFormChange(event) {
    const { name, value } = event.target;
    setRestartForm((current) => ({
      ...current,
      [name]: value,
    }));
  }

  function handleRestartCancel() {
    setShowRestartForm(false);
    setRestartSubmitting(false);
    setRestartError(null);
    setRestartResult(null);
    setRestartForm({
      requestedBy: "",
      approvedBy: "",
      reason: "",
    });
  }

  async function createAction(actionType, options = {}) {
    if (!selectedService) {
      return;
    }

    setRestartSubmitting(true);
    setRestartError(null);
    setRestartResult(null);

    try {
      const requestedBy = restartForm.requestedBy.trim();
      if (!requestedBy) {
        throw new Error("requestedBy is required to create an action.");
      }
      const actionRecord = {
        actionType,
        target: selectedService,
        requestedBy,
        input: {
          serviceName: selectedService,
          host: selectedServiceRecord?.host || "unknown",
          manager: getServiceManager(selectedServiceRecord),
          reason: options.reason || "",
        },
      };
      const approvalContext = getApprovalContextForAction(actionType, actionRecord, selectedServiceRecord);
      const approvalDecision = evaluateApprovalFreshnessGate(approvalContext, false);
      const actionReviewSnapshot = buildActionReviewSnapshotPayload({
        phase: "requested",
        actionType,
        actionRecord,
        serviceRecord: selectedServiceRecord,
        approvalContext,
        requestedBy,
        approvedBy: approvalContext?.riskProfile?.requiresApproval ? "" : requestedBy,
        freshnessAcknowledged: false,
        gateDisabledReason: approvalDecision.allowed ? "" : approvalDecision.reason,
      });

      const response = await fetch("/api/actions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          actionType,
          serviceName: selectedService,
          host: selectedServiceRecord?.host || "unknown",
          requestedBy,
          reason: options.reason || "",
          actionReviewSnapshot,
        }),
      });

      const data = await response.json();

      if (!response.ok || !data.ok) {
        throw new Error(getApiErrorMessage(data, "Action request failed"));
      }

      setRestartResult(data);
      if (data.actionId) {
        setApprovalFreshnessAcknowledged(data.actionId, false);
      }
      await refreshAudit();
    } catch (error) {
      setRestartError(error.message);
    } finally {
      setRestartSubmitting(false);
    }
  }

  async function handleRestartSubmit(event) {
    event.preventDefault();
    await createAction("restart-service", {
      reason: restartForm.reason,
    });
  }

  async function approveAction(entry, event) {
    event?.stopPropagation();
    const approvedBy = restartForm.approvedBy.trim();

    if (!approvedBy) {
      setRestartError("approvedBy is required to approve an action.");
      return;
    }

    setActionBusyId(entry.id);
    setRestartError(null);
    setRestartResult(null);

    try {
      const actionServiceRecord = findServiceForAction(entry, serviceItems);
      const freshnessAcknowledged = Boolean(approvalFreshnessAcknowledgements[String(entry.id || "").trim()]);
      const actionRecord = {
        ...entry,
        approvedBy,
      };
      const approvalContext = getApprovalContextForAction(entry.actionType, actionRecord, actionServiceRecord);
      const approvalDecision = evaluateApprovalFreshnessGate(approvalContext, freshnessAcknowledged);
      const actionReviewSnapshot = buildActionReviewSnapshotPayload({
        phase: "approved",
        actionType: entry.actionType,
        actionRecord,
        serviceRecord: actionServiceRecord,
        approvalContext,
        requestedBy: entry.requestedBy,
        approvedBy,
        freshnessAcknowledged,
        gateDisabledReason: approvalDecision.allowed ? "" : approvalDecision.reason,
      });
      const response = await fetch(`/api/actions/${encodeURIComponent(entry.id)}/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          approvedBy,
          actionReviewSnapshot,
        }),
      });
      const data = await response.json();

      if (!response.ok || !data.ok) {
        throw new Error(getApiErrorMessage(data, "Action approval failed"));
      }

      setRestartResult(data);
      await refreshAudit();
    } catch (error) {
      setRestartError(error.message);
    } finally {
      setActionBusyId(null);
    }
  }

  async function applyExecutionResult(entry, data) {
    if (data.services?.items) {
      applyServicePayload(data.services);
    } else {
      await refreshServices();
    }

    if (entry.actionType === "fetch-logs" && typeof data.output?.logs === "string") {
      setLogs(data.output.logs);
      setLogsFetchedAt(new Date().toISOString());
      setLogCopyStatus("");
      setLogsDisposition(null);
      setLogsError(null);
    }

    if (entry.actionType === "health-check") {
      const nextHealthOutput = data.output?.health || data.result?.data || null;

      setHealthOutput(
        nextHealthOutput
          ? {
              ...nextHealthOutput,
              ok: nextHealthOutput.ok ?? data.result?.ok ?? false,
              error: nextHealthOutput.error || data.result?.error || null,
              baseUrl: data.result?.baseUrl || nextHealthOutput.baseUrl || null,
            }
          : null,
      );
      setHealthMeta({
        actionId: data.actionId || entry.id,
        receivedAt: new Date().toISOString(),
        status: data.status || data.action?.status || entry.status,
      });
      setHealthDisposition(null);
    }

    setRestartResult(data);
    await refreshAudit();
  }

  async function runReadOnlyAction(actionType) {
    if (!selectedService) {
      return;
    }

    const capability = actionCapability(selectedServiceRecord, actionType);

    if (capability.supported === false) {
      setRestartError(capabilityMessage(capability, `${actionLabel(actionType)} is unavailable for this service.`));
      return;
    }

    setRestartSubmitting(true);
    setRestartError(null);
    setRestartResult(null);

    try {
      const requestedBy = restartForm.requestedBy.trim();
      if (!requestedBy) {
        throw new Error("requestedBy is required to run an action.");
      }
      const actionRecord = {
        actionType,
        target: selectedService,
        requestedBy,
        approvedBy: requestedBy,
        input: {
          serviceName: selectedService,
          host: selectedServiceRecord?.host || "unknown",
          manager: getServiceManager(selectedServiceRecord),
          reason: "",
        },
      };
      const approvalContext = getApprovalContextForAction(actionType, actionRecord, selectedServiceRecord);
      const actionReviewSnapshot = buildActionReviewSnapshotPayload({
        phase: "requested",
        actionType,
        actionRecord,
        serviceRecord: selectedServiceRecord,
        approvalContext,
        requestedBy,
        approvedBy: requestedBy,
        freshnessAcknowledged: false,
      });

      const createResponse = await fetch("/api/actions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          actionType,
          serviceName: selectedService,
          host: selectedServiceRecord?.host || "unknown",
          requestedBy,
          reason: "",
          actionReviewSnapshot,
        }),
      });
      const created = await createResponse.json();

      if (!createResponse.ok || !created.ok) {
        throw new Error(getApiErrorMessage(created, "Action request failed"));
      }

      const action = created.action || {
        id: created.actionId,
        actionType,
        target: selectedService,
        status: created.status,
      };

      setRestartResult(created);
      setActionBusyId(action.id);
      const executeActionRecord = {
        ...action,
        requestedBy,
        approvedBy: requestedBy,
        input: {
          ...action.input,
          serviceName: action.input?.serviceName || selectedService,
          host: action.input?.host || selectedServiceRecord?.host || "unknown",
          manager: action.input?.manager || getServiceManager(selectedServiceRecord),
        },
      };
      const executeApprovalContext = getApprovalContextForAction(
        actionType,
        executeActionRecord,
        selectedServiceRecord,
      );
      const executionActionReviewSnapshot = buildActionReviewSnapshotPayload({
        phase: "executed",
        actionType,
        actionRecord: executeActionRecord,
        serviceRecord: selectedServiceRecord,
        approvalContext: executeApprovalContext,
        requestedBy,
        approvedBy: requestedBy,
        freshnessAcknowledged: false,
      });

      const executeResponse = await fetch(`/api/actions/${encodeURIComponent(action.id)}/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          actionReviewSnapshot: executionActionReviewSnapshot,
        }),
      });
      const executed = await executeResponse.json();

      if (!executeResponse.ok || !executed.ok) {
        throw new Error(getApiErrorMessage(executed, "Action execution failed"));
      }

      await applyExecutionResult(action, executed);
    } catch (error) {
      setRestartError(error.message);
      await refreshAudit().catch(() => {});
    } finally {
      setActionBusyId(null);
      setRestartSubmitting(false);
    }
  }

  async function executeAction(entry, event) {
    event?.stopPropagation();
    setActionBusyId(entry.id);
    setRestartError(null);
    setRestartResult(null);

    try {
      const actionServiceRecord = findServiceForAction(entry, serviceItems);
      const freshnessAcknowledged = Boolean(approvalFreshnessAcknowledgements[String(entry.id || "").trim()]);
      const approvalContext = getApprovalContextForAction(entry.actionType, entry, actionServiceRecord);
      const approvalDecision = evaluateApprovalFreshnessGate(approvalContext, freshnessAcknowledged);
      const actionReviewSnapshot = buildActionReviewSnapshotPayload({
        phase: "executed",
        actionType: entry.actionType,
        actionRecord: entry,
        serviceRecord: actionServiceRecord,
        approvalContext,
        requestedBy: entry.requestedBy,
        approvedBy: entry.approvedBy,
        freshnessAcknowledged,
        gateDisabledReason: approvalDecision.allowed ? "" : approvalDecision.reason,
      });
      const response = await fetch(`/api/actions/${encodeURIComponent(entry.id)}/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          actionReviewSnapshot,
        }),
      });
      const data = await response.json();

      if (!response.ok || !data.ok) {
        throw new Error(getApiErrorMessage(data, "Action execution failed"));
      }

      await applyExecutionResult(entry, data);
    } catch (error) {
      setRestartError(error.message);
    } finally {
      setActionBusyId(null);
    }
  }

  function toggleAuditItem(id) {
    setExpandedAuditIds((current) => {
      const currentIds = normalizeStringArray(current);
      const normalizedId = String(id || "").trim();

      if (!normalizedId) {
        return currentIds;
      }

      return currentIds.includes(normalizedId)
        ? currentIds.filter((itemId) => itemId !== normalizedId)
        : [...currentIds, normalizedId];
    });
  }

  function handleAuditItemKeyDown(entry, event) {
    if (event.target !== event.currentTarget) {
      return;
    }

    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    event.preventDefault();
    toggleAuditItem(entry.id);
  }

  const sortedAudit = [...auditItems].sort(
    (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  );
  const selectedServiceAudit = selectedService
    ? sortedAudit.filter((entry) => entry.target === selectedService)
    : [];

  const visibleAudit =
    selectedService && auditFilterMode === "service"
      ? sortedAudit.filter((entry) => entry.target === selectedService)
      : sortedAudit;

  const openActionCount = sortedAudit.filter((entry) =>
    ["pending", "approved", "executing"].includes(entry.status),
  ).length;
  const logLineCount = countLogLines(logs);
  const hasLogs = typeof logs === "string" && logs.length > 0;
  const logFilterTerm = logFilter.trim().toLowerCase();
  const logLines = hasLogs ? logs.split(/\r?\n/) : [];
  const hasActiveLogFilter = Boolean(logFilterTerm) || logAlertOnly;
  const visibleLogLines = logLines.filter((line) => {
    const matchesText = !logFilterTerm || line.toLowerCase().includes(logFilterTerm);
    const matchesAlert = !logAlertOnly || ["log-critical", "log-error", "log-warning"].includes(getLogTone(line));
    return matchesText && matchesAlert;
  });
  const visibleLogText = visibleLogLines.join("\n");
  const logSignals = getLogSignals(logs);
  const hasHealthOutput = healthOutput !== null;
  const selectedServiceHost = selectedServiceRecord?.host || "unknown";
  const selectedServiceType = selectedServiceRecord?.classification?.type || inferServiceType(selectedServiceRecord);
  const selectedServiceSeverity =
    selectedServiceRecord?.classification?.severity || deriveServiceSeverity(selectedServiceRecord);
  const selectedServiceSetupHints = selectedServiceRecord?.classification?.setupHints || getServiceSetupHints(selectedServiceRecord);
  const selectedServicePrimarySetupHint = selectedServiceRecord?.classification?.primarySetupHint || selectedServiceSetupHints[0] || "";
  const selectedServiceLogsCapability = actionCapability(selectedServiceRecord, "fetch-logs");
  const selectedServiceHealthCapability = actionCapability(selectedServiceRecord, "health-check");
  const selectedServiceRestartCapability = actionCapability(selectedServiceRecord, "restart-service");
  const selectedServiceCanFetchLogs = selectedServiceLogsCapability.supported === true;
  const selectedServiceCanRunHealthCheck = selectedServiceHealthCapability.supported === true;
  const selectedServiceCanRestart = canRestartService(selectedServiceRecord);
  const selectedServiceStatus = selectedServiceRecord?.status || "unknown";
  const selectedServiceManager = getServiceManager(selectedServiceRecord);
  const selectedServiceProcessName = getServiceProcessName(selectedServiceRecord);
  const selectedServicePort = getServiceLocalPort(selectedServiceRecord);
  const selectedServiceLocalUrl = getServiceLocalUrl(selectedServiceRecord);
  const selectedServiceLocalHealthUrl = getServiceLocalHealthUrl(selectedServiceRecord);
  const selectedServiceLocalReadinessUrl = getServiceLocalReadinessUrl(selectedServiceRecord);
  const selectedServicePublicUrl = getServicePublicUrl(selectedServiceRecord);
  const selectedServiceRuntimeSummary = getServiceRuntimeSummary(selectedServiceRecord);
  const selectedServiceCheckSummary = getServiceLocalCheckSummary(selectedServiceRecord);
  const selectedServiceNotes = getServiceNotes(selectedServiceRecord);
  const selectedServiceRelationshipSections = buildServiceRelationshipSections(selectedServiceRecord, serviceItems);
  const latestVisibleAction = visibleAudit[0] || null;
  const latestResultSource = restartResult || latestVisibleAction;
  const latestActionType = readServiceString(
    restartResult?.action?.actionType,
    restartResult?.actionType,
    restartResult?.result?.actionType,
    latestVisibleAction?.actionType,
    latestVisibleAction?.result?.actionType,
  );
  const latestActionServiceRecord = latestResultSource
    ? findServiceForAction(latestResultSource, serviceItems) || selectedServiceRecord
    : selectedServiceRecord;
  const latestActionRiskProfile = latestActionType
    ? getActionRiskProfile(
        latestActionType,
        latestResultSource,
        getActionRiskContext(latestActionType, latestResultSource, latestActionServiceRecord),
      )
    : null;
  const latestResultClipboardText = formatActionResultClipboard(latestResultSource);
  const latestActionText = restartResult
    ? getActionResultSummary(restartResult)
    : latestVisibleAction
      ? `${actionLabel(latestVisibleAction.actionType)} ${latestVisibleAction.status}`
      : "No action result yet.";
  const latestActionStatus = restartResult?.status || latestVisibleAction?.status || "unknown";
  const latestRestartAction =
    visibleAudit.find((entry) => entry.actionType === "restart-service") || null;
  const latestDiagnosisAudit = selectedServiceAudit[0] || null;
  const latestDiagnosisAction = actionMatchesService(restartResult, selectedService)
    ? restartResult
    : latestDiagnosisAudit;
  const latestDiagnosisActionType = readServiceString(
    latestDiagnosisAction?.action?.actionType,
    latestDiagnosisAction?.actionType,
    latestDiagnosisAction?.result?.actionType,
  );
  const latestDiagnosisActionRiskProfile =
    latestDiagnosisAction && latestDiagnosisActionType
      ? getActionRiskProfile(
          latestDiagnosisActionType,
          latestDiagnosisAction,
          getActionRiskContext(latestDiagnosisActionType, latestDiagnosisAction, selectedServiceRecord),
        )
      : null;
  const latestDiagnosisActionCreatedAt =
    latestDiagnosisAction?.action?.createdAt ||
    latestDiagnosisAction?.createdAt ||
    latestDiagnosisAction?.result?.executedAt ||
    latestDiagnosisAction?.result?.completedAt ||
    null;
  const latestDiagnosisActionText = latestDiagnosisAction
    ? getActionResultSummary(latestDiagnosisAction) ||
      `${actionLabel(latestDiagnosisAction.action?.actionType || latestDiagnosisAction.actionType)} ${
        latestDiagnosisAction.action?.status || latestDiagnosisAction.status || "unknown"
      }`
    : "No action result yet.";
  const restartState = latestRestartAction?.status || (selectedServiceCanRestart ? "supported" : "unsupported");
  const restartStateText = latestRestartAction
    ? `${actionLabel(latestRestartAction.actionType)} Â· ${formatCreatedAt(latestRestartAction.createdAt)}`
    : selectedServiceCanRestart
      ? "Available with approval."
      : capabilityMessage(selectedServiceRestartCapability, "Unavailable for this service.");
  const healthStatusText = getHealthStatusSummary(healthOutput);
  const outputAlertSummary =
    logSignals.alertCount || (hasHealthOutput && !healthOutput.ok)
      ? [
          logSignals.alertCount ? logSignals.summary : null,
          hasHealthOutput && !healthOutput.ok ? "Health check needs attention." : null,
        ]
          .filter(Boolean)
          .join(" ")
      : "No current output alerts.";
  const logEmptyMessage = logsDisposition
    ? `Logs ${logsDisposition.type} from this view at ${formatCreatedAt(logsDisposition.at)}. Fetch logs or reselect the service to load fresh output.`
    : selectedService
      ? "No logs returned for the selected service."
      : "Select a service to view logs.";
  const filteredLogEmptyMessage = hasLogs && hasActiveLogFilter ? "No log lines match the current filters." : logEmptyMessage;
  const healthEmptyMessage = healthDisposition
    ? `Health output ${healthDisposition.type} from this view at ${formatCreatedAt(healthDisposition.at)}. Execute a health-check action to show fresh output.`
    : "No health-check output is visible yet.";
  const selectedServiceHeaderSummary = selectedServiceRecord
    ? [
        selectedServiceHost !== "unknown" ? `${selectedServiceHost} host` : "Unknown host",
        selectedServiceManager,
        selectedServicePort ? `port ${selectedServicePort}` : null,
      ]
        .filter(Boolean)
        .join(" Â· ")
    : "Select a service to inspect logs and actions.";
  const signalAlertCount = logSignals.alertCount + (hasHealthOutput && !healthOutput.ok ? 1 : 0) + (latestActionStatus === "failed" ? 1 : 0);
  const restartDraftAction = selectedServiceRecord
    ? {
        actionType: "restart-service",
        target: selectedServiceRecord.name,
        requestedBy: restartForm.requestedBy.trim() || latestRestartAction?.requestedBy || "",
        approvedBy: restartForm.approvedBy.trim() || latestRestartAction?.approvedBy || "",
        input: {
          serviceName: selectedServiceRecord.name,
          host: selectedServiceHost,
          requiresApproval: requiresApproval("restart-service", latestRestartAction || selectedServiceRestartCapability),
          risk: readServiceString(
            latestRestartAction?.input?.risk,
            latestRestartAction?.input?.riskLevel,
            selectedServiceRestartCapability?.risk,
            selectedServiceRestartCapability?.riskLevel,
          ),
        },
      }
    : null;
  const restartRiskProfile =
    selectedServiceRecord && restartDraftAction
      ? getActionRiskProfile(
          "restart-service",
          restartDraftAction,
          getActionRiskContext("restart-service", restartDraftAction, selectedServiceRecord),
        )
      : null;
  const restartApprovalContext =
    selectedServiceRecord && restartDraftAction
      ? getApprovalContextForAction("restart-service", restartDraftAction, selectedServiceRecord)
      : null;
  const restartApprovalDetails =
    selectedServiceRecord && restartDraftAction && restartRiskProfile
      ? buildActionApprovalDetails("restart-service", restartDraftAction, selectedServiceRecord, {
          riskProfile: restartRiskProfile,
          approvalNote: getRestartConfirmationText(selectedServiceCanRestart),
          lifecycleText: getRestartLifecycleText(latestRestartAction, selectedServiceCanRestart, restartForm.requestedBy.trim()),
        })
      : [];
  const signalDisclosureDefaultOpen = Boolean(selectedServiceRecord);
  const signalDetailItems = selectedServiceRecord
    ? compactDetailItems([
        {
          label: "Alerts",
          value: signalAlertCount ? `${signalAlertCount} signal${signalAlertCount === 1 ? "" : "s"}` : "None",
        },
        {
          label: "Logs",
          value: logSignals.summary,
        },
        {
          label: "Health",
          value: healthStatusText,
        },
        {
          label: "Last fetch",
          value: logsFetchedAt ? formatCreatedAt(logsFetchedAt) : "Not fetched",
        },
        {
          label: "Action",
          value: latestActionText,
        },
        {
          label: "Active actions",
          value: `${openActionCount} active action${openActionCount === 1 ? "" : "s"}`,
        },
        {
          label: "Restart",
          value: selectedServiceCanRestart ? "Available with approval." : "Unavailable for this service.",
        },
      ])
    : [];
  const serviceDetailItems = selectedServiceRecord
    ? compactDetailItems([
        {
          label: "Host",
          value: selectedServiceHost !== "unknown" ? selectedServiceHost : "Unknown",
        },
        {
          label: "Type",
          value: selectedServiceType,
        },
        {
          label: "Severity",
          value: formatStatusLabel(selectedServiceSeverity),
        },
        {
          label: "Manager",
          value: selectedServiceManager || "Not mapped.",
        },
        {
          label: "Process",
          value: selectedServiceProcessName || "Not mapped.",
        },
        {
          label: "Runtime",
          value: selectedServiceRuntimeSummary || "No runtime summary yet.",
        },
        {
          label: "Local",
          value:
            selectedServiceCheckSummary ||
            selectedServiceLocalHealthUrl ||
            selectedServiceLocalUrl ||
            (selectedServicePort ? `port ${selectedServicePort}` : "Not mapped."),
        },
        selectedServiceLocalReadinessUrl
          ? {
              label: "Readiness",
              value: selectedServiceLocalReadinessUrl,
            }
          : null,
        {
          label: "Public",
          value: selectedServicePublicUrl || "Not mapped.",
        },
        {
          label: "Health",
          value: hasHealthOutput ? healthStatusText : healthEmptyMessage,
        },
        selectedServicePrimarySetupHint
          ? {
              label: "Setup hint",
              value: selectedServicePrimarySetupHint,
            }
          : null,
        {
          label: "Latest action",
          value: latestActionText,
        },
        {
          label: "Source",
          value: selectedServiceRecord.source || "memory",
        },
        {
          label: "Last seen",
          value: selectedServiceRecord.lastSeen ? formatCreatedAt(selectedServiceRecord.lastSeen) : "Unknown",
        },
      ])
    : [];
  const diagnosis = selectedService
    ? extractServiceDiagnosis({
        selectedService,
        service: selectedServiceRecord,
        status: selectedServiceStatus,
        host: selectedServiceHost,
        manager: selectedServiceManager,
        processName: selectedServiceProcessName,
        localPort: selectedServicePort,
        localUrl: selectedServiceLocalUrl,
        localHealthUrl: selectedServiceLocalHealthUrl,
        localReadinessUrl: selectedServiceLocalReadinessUrl,
        publicUrl: selectedServicePublicUrl,
        logs,
        visibleLogs: hasActiveLogFilter && visibleLogLines.length ? visibleLogText : logs || "",
        logsFetchedAt,
        logSignals,
        healthOutput,
        healthMeta,
        latestAction: latestDiagnosisAction,
        recentAudit: selectedServiceAudit.slice(0, 5),
        services: serviceItems,
        latestActionText: latestDiagnosisActionText,
        runtimeRestarts: selectedServiceRecord?.runtime?.restarts,
      })
    : null;
  const diagnosisHighlights = normalizeObjectCollection(diagnosis?.highlights);
  const diagnosisLogEvents = normalizeObjectCollection(diagnosis?.logEvents);
  const diagnosisSuggestedActions = normalizeStringArray(diagnosis?.suggestedActions);
  const diagnosisSelectTarget =
    diagnosis?.relatedServiceId && diagnosis.relatedServiceId !== selectedService ? diagnosis.relatedServiceId : "";
  const diagnosisNextStep =
    diagnosis?.suggestedNextStep || diagnosisSuggestedActions[0] || "Review raw logs or run a health check for more context.";
  const diagnosisDetailItems =
    diagnosis && diagnosis.detected
      ? [
          {
            label: "Severity",
            value: formatBadgeLabel(diagnosis.severity),
          },
          {
            label: "Primary issue",
            value: diagnosis.primaryIssue,
          },
          {
            label: "Likely cause",
            value: diagnosis.likelyCause,
          },
          {
            label: "Most relevant error",
            value: diagnosis.mostRelevantError,
          },
          diagnosis.errorType
            ? {
                label: "Error type",
                value: diagnosis.errorType,
              }
            : null,
          diagnosis.filePath
            ? {
                label: "Relevant file",
                value: diagnosis.filePath,
              }
            : null,
          diagnosis.lineNumber
            ? {
                label: "Relevant line",
                value: String(diagnosis.lineNumber),
              }
            : null,
          {
            label: "Source",
            value: formatBadgeLabel(diagnosis.source),
          },
          {
            label: "Affected service",
            value: diagnosis.affectedService || selectedService,
          },
          diagnosis.relatedServiceId
            ? {
                label: "Related service",
                value: diagnosis.relatedServiceName || diagnosis.relatedServiceId,
              }
            : null,
          diagnosis.relatedServiceId
            ? {
                label: "Host / runtime",
                value: [diagnosis.relatedServiceHost, diagnosis.relatedServiceManager].filter(Boolean).join(" / "),
              }
            : null,
          diagnosis.relatedEndpoint
            ? {
                label: "Related endpoint",
                value: diagnosis.relatedEndpoint,
              }
            : null,
          {
            label: "Correlation evidence",
            value: diagnosis?.correlationReason || "No confident match",
          },
          diagnosis.correlationConfidence
            ? {
                label: "Correlation confidence",
                value: formatBadgeLabel(diagnosis.correlationConfidence),
              }
            : null,
          diagnosis.timestamp
            ? {
                label: "Timestamp",
                value: formatCreatedAt(diagnosis.timestamp),
              }
            : null,
        ].filter(Boolean)
      : [];
  const diagnosisSummaryText = !selectedService
    ? "Select a service to generate a diagnosis."
    : diagnosis?.detected
      ? diagnosis.primaryIssue
      : "No critical issue detected from the current logs.";
  const diagnosisSupportText = !selectedService
    ? "Select a service to convert current logs, health, and action context into an operator-ready diagnosis."
    : diagnosis?.detected
      ? diagnosis.likelyCause
      : "Review raw logs or run a health check for more context.";
  const dependencyHealthRollup = buildDependencyHealthRollup(selectedServiceRecord, serviceItems, diagnosis);
  const assistantContext = buildAssistantContext({
    selectedService,
    selectedServiceRecord: selectedServiceRecord
      ? {
          ...selectedServiceRecord,
          runtimeSummary: selectedServiceRuntimeSummary,
        }
      : null,
    services: serviceItems,
    diagnosis,
    diagnosisLogEvents,
    logSummary: {
      hasLogs,
      logsFetchedAt,
      lineCount: logLineCount,
      visibleLineCount: visibleLogLines.length,
      filtered: hasActiveLogFilter,
      alertOnly: logAlertOnly,
      alertCount: logSignals.alertCount,
      criticalCount: logSignals.critical,
      errorCount: logSignals.errors,
      warningCount: logSignals.warnings,
      summary: logSignals.summary,
    },
    inventoryFreshness: serviceInventoryFreshness,
    dependencyRollup: dependencyHealthRollup,
    approvalContext: restartApprovalContext,
    restartRiskProfile,
    latestAction: latestDiagnosisAction
      ? {
          type: latestDiagnosisActionType,
          status: latestDiagnosisAction.action?.status || latestDiagnosisAction.status || "unknown",
          summary: latestDiagnosisActionText,
          createdAt: latestDiagnosisActionCreatedAt,
          riskLabel: latestDiagnosisActionRiskProfile?.label || "",
          riskLevel: latestDiagnosisActionRiskProfile?.riskLevel || "",
          verificationSummary: getVerificationSummary(getActionResult(latestDiagnosisAction)),
        }
      : null,
    capabilities: {
      logs: selectedServiceLogsCapability,
      health: selectedServiceHealthCapability,
      restart: selectedServiceRestartCapability,
    },
      selectedIncident,
  });
  const assistantPlanCards = buildAssistantPlanCards({
    activePlanChipId: activeAssistantPlanChipId,
    assistantContext,
    restartApprovalContext,
    restartRiskProfile,
    auditEntries: selectedService ? selectedServiceAudit : visibleAudit,
    lookupItems: assistantLookupItems,
    selectedLookupItem: selectedAssistantLookupItem,
    healthOutput,
    healthMeta,
  });
  const assistantToneMeta = getAssistantToneMeta(assistantTone);
  const assistantDisplayContext = formatAssistantContextForTone(assistantContext, assistantTone);
  const assistantDisplayPlanCards = assistantPlanCards.map((card) => formatAssistantPlanCardForTone(card, assistantTone));
  const assistantDisplayMessages = chatMessages.map((message) => formatAssistantMessageForTone(message, assistantTone));
  const extractedEventsEmptyMessage = !selectedService
    ? "Select a service to review extracted log events."
    : "No critical issue detected from the current logs. Review raw logs or run a health check for more context.";

  if (selectedServiceNotes[0]) {
    serviceDetailItems.push({
      label: "Notes",
      value: selectedServiceNotes[0],
    });
  }

  const auditPendingCount = visibleAudit.filter((entry) => entry.status === "pending").length;
  const auditFailedCount = visibleAudit.filter((entry) => entry.status === "failed").length;
  const auditRecentCount = visibleAudit.filter(isAuditEntryFresh).length;
  const preferExpandedAudit = typeof window !== "undefined" && window.innerHeight >= 980;
  const auditDisclosureDefaultOpen =
    auditPendingCount > 0 ||
    auditFailedCount > 0 ||
    Boolean(restartResult) ||
    (preferExpandedAudit && visibleAudit.length > 0);
  const auditHeaderSummary = [
    `${visibleAudit.length} entries`,
    auditPendingCount ? `${auditPendingCount} pending` : null,
    auditFailedCount ? `${auditFailedCount} failed` : null,
    auditRecentCount ? `${auditRecentCount} recent` : null,
  ]
    .filter(Boolean)
    .join(" Â· ");
  const incidentsDisclosureDefaultOpen = false;
  const restartDisclosureDefaultOpen =
    selectedServiceCanRestart || Boolean(showRestartForm) || Boolean(restartResult);
  const restartSummaryText = restartStateText;
  const serviceGroups = groupServicesForRail(serviceItems, selectedService);

  function handleDownloadLogs() {
    if (!hasLogs) {
      return;
    }

    const exportedAt = new Date();
    const serviceName = selectedService || "unknown-service";
    const header = [
      "Garage Admin V2 service logs",
      `Service: ${serviceName}`,
      `Exported: ${exportedAt.toISOString()}`,
      `Lines: ${logLineCount}`,
      "",
    ].join("\n");

    downloadFile(
      `${safeFilePart(serviceName)}-logs-${formatFileTimestamp(exportedAt)}.txt`,
      `${header}${logs}`,
    );
  }

  function handleArchiveLogs() {
    if (!hasLogs) {
      return;
    }

    const archivedAt = new Date().toISOString();

    setLogsArchive((current) => [
      {
        id: createId(),
        serviceName: selectedService || "unknown-service",
        archivedAt,
        lineCount: logLineCount,
        size: logs.length,
      },
      ...normalizeObjectCollection(current),
    ]);
    setLogs(null);
    setLogCopyStatus("");
    setLogsDisposition({ type: "archived", at: archivedAt });
  }

  function handleClearLogs() {
    setLogs(null);
    setLogsError(null);
    setLogAlertOnly(false);
    setLogCopyStatus("");
    setLogsDisposition({ type: "cleared", at: new Date().toISOString() });
  }

  function handleClearLogFilters() {
    setLogFilter("");
    setLogAlertOnly(false);
  }

  async function handleCopyLogs() {
    if (!hasLogs) {
      return;
    }

    try {
      await copyText(hasActiveLogFilter ? visibleLogText : logs);
      setLogCopyStatus(hasActiveLogFilter ? `Copied ${visibleLogLines.length} visible lines.` : "Copied logs.");
    } catch (error) {
      setLogCopyStatus(`Copy failed: ${error.message}`);
    }
  }

  async function handleCopyLatestResult(event) {
    event?.stopPropagation();

    if (!latestResultClipboardText) {
      return;
    }

    try {
      await copyText(latestResultClipboardText);
      setResultCopyStatus("Copied latest result.");
    } catch (error) {
      setResultCopyStatus(`Copy failed: ${error.message}`);
    }
  }

  async function handleCopyAuditValue(entry, valueType, event) {
    event?.stopPropagation();
    const value = valueType === "input" ? entry.input : entry.result;

    try {
      await copyText(formatAuditValue(value) || "None");
      setResultCopyStatus(`Copied ${valueType}.`);
    } catch (error) {
      setResultCopyStatus(`Copy failed: ${error.message}`);
    }
  }

  function handleDownloadHealth() {
    if (!hasHealthOutput) {
      return;
    }

    const exportedAt = new Date();
    const payload = {
      exportedAt: exportedAt.toISOString(),
      selectedService: selectedService || null,
      actionId: healthMeta?.actionId || null,
      receivedAt: healthMeta?.receivedAt || null,
      result: healthOutput,
    };

    downloadFile(
      `garage-health-${formatFileTimestamp(exportedAt)}.json`,
      JSON.stringify(payload, null, 2),
      "application/json;charset=utf-8",
    );
  }

  function handleArchiveHealth() {
    if (!hasHealthOutput) {
      return;
    }

    const archivedAt = new Date().toISOString();

    setHealthArchive((current) => [
      {
        id: createId(),
        archivedAt,
        actionId: healthMeta?.actionId || null,
        ok: healthOutput.ok,
        status: healthOutput.status || null,
      },
      ...normalizeObjectCollection(current),
    ]);
    setHealthOutput(null);
    setHealthMeta(null);
    setHealthDisposition({ type: "archived", at: archivedAt });
  }

  function handleClearHealth() {
    setHealthOutput(null);
    setHealthMeta(null);
    setHealthDisposition({ type: "cleared", at: new Date().toISOString() });
  }

  function appendAssistantContent(content) {
    setMessages((current) => [
      ...normalizeObjectCollection(current),
      {
        id: createId(),
        role: "assistant",
        content,
      },
    ]);
  }

  async function submitChatMessage(messageText, options = {}) {
    const trimmed = messageText.trim();

    if (!trimmed || chatLoading) {
      return;
    }

    const requestId = ++chatRequestIdRef.current;

    const userMessage = {
      id: createId(),
      role: "user",
      content: trimmed,
    };

    setMessages((current) => [...normalizeObjectCollection(current), userMessage]);
    setInput("");
    setChatLoading(true);
    setChatError(null);

    try {
      const response = await fetch("/api/chat/plan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          buildAssistantRequestPayload({
            message: trimmed,
            context: assistantContext,
            lookupRequest: options.lookupRequest || null,
          }),
        ),
      });

      const data = await response.json();

      if (!response.ok || !data.ok) {
        throw new Error(data.error || "Failed to analyze context");
      }

      if (requestId !== chatRequestIdRef.current) {
        return;
      }

      const lookupItems = normalizeObjectCollection(data.lookup?.items);

      if (!assistantSelection && lookupItems.length === 1) {
        setAssistantSelection(createAssistantSelection(lookupItems[0]));
      }

      setMessages((current) => [
        ...normalizeObjectCollection(current),
        {
          id: createId(),
          role: "assistant",
          summary: data.summary,
          suggestions: data.suggestions || [],
          proposedAction: data.proposedAction || null,
          lookup: data.lookup || null,
        },
      ]);
    } catch (error) {
      if (requestId !== chatRequestIdRef.current) {
        return;
      }

      setChatError(error.message);
      setMessages((current) => [
        ...normalizeObjectCollection(current),
        {
          id: createId(),
          role: "assistant",
          content: `Chat analysis failed: ${error.message}`,
        },
      ]);
    } finally {
      if (requestId === chatRequestIdRef.current) {
        setChatLoading(false);
      }
    }
  }

  async function handleChatSubmit(event) {
    event.preventDefault();
    await submitChatMessage(input);
  }

  function handleQuickPrompt(prompt) {
    submitChatMessage(prompt).catch(() => {});
  }

  function handleAssistantPlanChip(chipId) {
    setActiveAssistantPlanChipId((current) => (current === chipId ? "" : chipId));
  }

  function handleAssistantLookupAction(actionId, overrides = {}) {
    const invocation = buildAssistantLookupInvocation(actionId, {
      input,
      selection: assistantSelection,
      selectedService,
      ...overrides,
    });

    if (invocation.error) {
      setChatError(invocation.error);
      appendAssistantContent(invocation.error);
      return;
    }

    submitChatMessage(invocation.message, {
      lookupRequest: invocation.lookupRequest,
    }).catch(() => {});
  }

  function handleSelectAssistantItem(item) {
    const selection = createAssistantSelection(item);

    setAssistantSelection(selection);

    if (!input.trim()) {
      setInput(selection.relativePath || selection.title || selection.serviceName || "");
    }
  }

  function handlePreviewAssistantItem(item) {
    handleSelectAssistantItem(item);
    handleAssistantLookupAction("read-file", {
      title: item.title,
      path: item.path,
      reportId: item.reportId,
    });
  }

  function handleExplainAssistantItem(item) {
    handleSelectAssistantItem(item);
    handleAssistantLookupAction("explain-report", {
      title: item.title,
      query: item.title,
      reportId: item.reportId,
    });
  }

  function runAssistantPlanAction(action, event) {
    event?.stopPropagation?.();

    if (!action || typeof action !== "object") {
      return;
    }

    if (action.serviceName && action.serviceName !== selectedService) {
      setSelectedService(action.serviceName);
    }

    if (action.id === "refresh-inventory") {
      handleRefreshInventory(event);
      return;
    }

    if (action.id === "open-service-actions") {
      setShowRestartForm(true);
      setRestartError(null);
      return;
    }

    if (action.id === "query-logs") {
      handleAssistantLookupAction("logs-query", {
        service: action.serviceName || selectedService,
      });
      return;
    }

    if (action.id === "find-report") {
      handleAssistantLookupAction("reports", {
        input: action.query || "",
        title: action.query || "",
      });
      return;
    }

    if (action.id === "search-files") {
      handleAssistantLookupAction("search-files", {
        input: action.query || "",
      });
      return;
    }

    if ((action.id === "open-report-preview" || action.id === "open-safe-file-preview") && action.item) {
      handlePreviewAssistantItem(action.item);
    }
  }

  function applySuggestedAction(proposedAction) {
    if (!proposedAction || proposedAction.type !== "restart-service") {
      return;
    }

    setSelectedService(proposedAction.serviceName);
    setShowRestartForm(true);
    setRestartError(null);
    setRestartResult(null);
    setRestartForm((current) => ({
      ...current,
      reason: proposedAction.reason || "",
    }));
  }

  function handleOpenAssistantExpanded() {
    setAssistantMode(ASSISTANT_MODES.EXPANDED);
  }

  function handleDockAssistant() {
    setAssistantMode(ASSISTANT_MODES.DOCKED);
  }

  function handleMinimizeAssistant() {
    setAssistantMode(ASSISTANT_MODES.MINIMIZED);
  }

  function handleCloseAssistant() {
    setAssistantSeenResponseCount(assistantResponseCount);
    setAssistantMode(ASSISTANT_MODES.MINIMIZED);
  }

  function handleCycleAssistantLauncherPosition() {
    setAssistantLauncherPosition((current) => getNextAssistantLauncherPosition(current));
  }

  const isAssistantMinimized = assistantMode === ASSISTANT_MODES.MINIMIZED;
  const isAssistantDocked = assistantMode === ASSISTANT_MODES.DOCKED;
  const isAssistantExpanded = assistantMode === ASSISTANT_MODES.EXPANDED;
  const assistantUnreadCount =
    assistantMode === ASSISTANT_MODES.MINIMIZED ? Math.max(0, assistantResponseCount - assistantSeenResponseCount) : 0;
  const assistantServiceLabel = selectedServiceRecord?.displayName || selectedServiceRecord?.name || selectedService || "";
  const assistantHostOwnershipLabel = formatAssistantHostOwnership(selectedServiceRecord?.host || assistantContext?.service?.host);
  const assistantSafetyText = formatAssistantText(
    "Read-only chat only. Chat cannot execute restarts, approvals, file writes, or destructive actions.",
    {
      tone: assistantTone,
      category: "safety",
      riskLevel: "dangerous",
      surface: "safety",
    },
  );
  const assistantNeedsAttention =
    Boolean(chatError) ||
    restartApprovalContext?.gate?.blockedUntilRefresh === true ||
    ["stale", "unknown"].includes(String(assistantContext?.inventory?.freshness?.bucket || "").toLowerCase()) ||
    assistantLookupItems.some((item) => lookupText(item?.safetyStatus).toLowerCase() === "blocked");
  const assistantAttentionState = buildAssistantAttentionState({
    hasSelectedService: Boolean(selectedService),
    unreadCount: assistantUnreadCount,
    diagnosisDetected: assistantContext?.diagnosis?.detected === true,
    needsAttention: assistantNeedsAttention,
  });
  const assistantLauncherSummary = assistantAttentionState.summary;
  const assistantLauncherPositionMeta =
    ASSISTANT_LAUNCHER_POSITION_META[assistantLauncherPosition] ||
    ASSISTANT_LAUNCHER_POSITION_META[ASSISTANT_LAUNCHER_POSITIONS.RIGHT_CENTER];
  const assistantLauncherNextPosition = getNextAssistantLauncherPosition(assistantLauncherPosition);
  const assistantLauncherNextPositionMeta =
    ASSISTANT_LAUNCHER_POSITION_META[assistantLauncherNextPosition] ||
    ASSISTANT_LAUNCHER_POSITION_META[ASSISTANT_LAUNCHER_POSITIONS.RIGHT_CENTER];
  const assistantLauncherNotificationBadge =
    assistantUnreadCount > 0
      ? {
          className: "assistant-launcher-badge-unread",
          label: assistantUnreadCount > 99 ? "99+" : String(assistantUnreadCount),
          title: assistantUnreadCount === 1 ? "1 unread assistant response" : `${assistantUnreadCount} unread assistant responses`,
        }
      : assistantNeedsAttention
        ? {
            className: "assistant-launcher-badge-alert",
            label: "!",
            title: "Assistant context needs attention",
          }
        : null;
  const showAssistantContextBadge = Boolean(assistantServiceLabel) && !assistantLauncherNotificationBadge;
  const assistantLauncherTooltip = [
    assistantServiceLabel ? `Selected service: ${assistantServiceLabel}` : "No service selected",
    assistantHostOwnershipLabel ? `Host: ${assistantHostOwnershipLabel}` : "",
    assistantLauncherSummary,
  ]
    .filter(Boolean)
    .join(" Â· ");
  const assistantLauncherAriaLabel = [
    "Open assistant",
    assistantServiceLabel ? `selected service ${assistantServiceLabel}` : "no service selected",
    assistantAttentionState.labels.length ? assistantAttentionState.labels.join(", ") : "ready when needed",
  ].join(". ") + ".";
  const assistantEmptyStateText = formatAssistantText(
    selectedService
      ? "Ask one of the quick prompts or type a question grounded in the selected service."
      : "Select a service first, then ask a grounded question about its status, logs, or plan.",
    {
      tone: assistantTone,
      category: selectedService ? "empty-state" : "no-service",
      surface: "empty-state",
    },
  );
  const assistantLoadingText = formatAssistantText("Analyzing current context...", {
    tone: assistantTone,
    surface: "loading",
  });
  const assistantPanelContent = (
    <section
      className={`chat-panel assistant-panel-window ${
        isAssistantExpanded ? "assistant-panel-window-expanded" : "assistant-panel-window-docked"
      }`}
      role={isAssistantExpanded ? "dialog" : "complementary"}
      aria-modal={isAssistantExpanded ? "true" : undefined}
      aria-label="Assistant"
    >
      <div className="chat-header assistant-window-header">
        <div className="assistant-window-heading">
          <span className="section-title">Assistant</span>
          <div className="assistant-window-title-row">
            <h2>Context Chat</h2>
            {chatLoading ? <span className="count-pill">Analyzing</span> : null}
          </div>
          <div
            className={`assistant-window-context-row ${
              assistantServiceLabel ? "" : "assistant-window-context-row-muted"
            }`}
          >
            {assistantServiceLabel ? <strong>{assistantServiceLabel}</strong> : <span>No service selected</span>}
            {assistantServiceLabel ? (
              <span className={`status-badge ${statusClassName(selectedServiceStatus)}`} title={selectedServiceStatus}>
                {formatStatusLabel(selectedServiceStatus)}
              </span>
            ) : null}
            {assistantHostOwnershipLabel ? (
              <span className="status-badge status-info">{assistantHostOwnershipLabel}</span>
            ) : null}
          </div>
          <div className="assistant-tone-row">
            <label className="assistant-tone-control">
              <span className="detail-label">Tone</span>
              <select
                className="assistant-tone-select"
                value={assistantTone}
                onChange={(event) => setAssistantTone(normalizeAssistantTone(event.target.value))}
                aria-label="Assistant tone"
              >
                {ASSISTANT_TONE_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <span className="status-badge status-info assistant-tone-indicator">{assistantToneMeta.label}</span>
          </div>
          <div className="assistant-tone-note">{ASSISTANT_TONE_HELPER_TEXT}</div>
        </div>
        <div className="assistant-window-controls">
          {isAssistantExpanded ? (
            <button type="button" className="mini-button assistant-window-control" onClick={handleDockAssistant}>
              Dock
            </button>
          ) : (
            <button type="button" className="mini-button assistant-window-control" onClick={handleOpenAssistantExpanded}>
              Pop out
            </button>
          )}
          <button type="button" className="mini-button assistant-window-control" onClick={handleMinimizeAssistant}>
            Minimize
          </button>
          {isAssistantExpanded ? (
            <button
              type="button"
              className="mini-button assistant-window-control assistant-window-control-close"
              onClick={handleCloseAssistant}
            >
              Close
            </button>
          ) : null}
        </div>
      </div>
      {isAssistantExpanded ? <div className="assistant-window-safety">{assistantSafetyText}</div> : null}
      {chatError ? <div className="banner error-banner">Chat analysis failed: {chatError}</div> : null}
      <div className="messages">
        <div className="assistant-context-card">
          <div className="assistant-context-header">
            <span className="detail-label">Grounded Context</span>
            <span
              className={`status-badge signal-freshness-badge signal-freshness-badge-${
                assistantContext.inventory.freshness.bucket || "unknown"
              }`}
              title={assistantContext.inventory.freshness.provenanceText || assistantContext.inventory.freshness.label}
            >
              {assistantContext.inventory.freshness.label}
            </span>
          </div>
          <div className="assistant-context-summary">{assistantDisplayContext.openingMessage}</div>
          {assistantContext.panelFacts.length ? (
            <div className="assistant-context-facts">
              {assistantContext.panelFacts.map((fact) => (
                <span
                  key={fact.key}
                  className={`assistant-context-fact assistant-context-fact-${fact.tone || "neutral"}`}
                  title={`${fact.label}: ${fact.value}`}
                >
                  <strong>{fact.label}:</strong> {fact.value}
                </span>
              ))}
            </div>
          ) : null}
          <div className="assistant-context-section">
            <div className="assistant-context-section-copy">
              <span className="detail-label">Quick prompts</span>
              <span className="assistant-context-section-note">Grounded in the selected service and current operator context.</span>
            </div>
            <div className="assistant-prompt-chips">
              {assistantDisplayContext.quickPrompts.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  className="assistant-prompt-chip"
                  onClick={() => handleQuickPrompt(prompt)}
                  disabled={chatLoading || !selectedService}
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
          <div className="assistant-context-section">
            <div className="assistant-context-section-copy">
              <span className="detail-label">Operator plans</span>
              <span className="assistant-context-section-note">Read-only planning only. Restart and approval paths stay inside Service Actions.</span>
            </div>
            <div className="assistant-plan-chip-row">
              {ASSISTANT_PLAN_CHIPS.map((chip) => (
                <button
                  key={chip.id}
                  type="button"
                  className={`assistant-prompt-chip assistant-plan-chip ${
                    activeAssistantPlanChipId === chip.id ? "assistant-plan-chip-active" : ""
                  }`}
                  onClick={() => handleAssistantPlanChip(chip.id)}
                >
                  {chip.label}
                </button>
              ))}
            </div>
          </div>
          <div className="assistant-context-section">
            <div className="assistant-context-section-copy">
              <span className="detail-label">Safe lookups</span>
              <span className="assistant-context-section-note">Windows repo/docs, Fedora safe API surfaces, and registered cross-host docs only.</span>
            </div>
            <div className="assistant-lookup-chip-row">
              {ASSISTANT_LOOKUP_CHIPS.map((chip) => (
                <button
                  key={chip.id}
                  type="button"
                  className="assistant-prompt-chip assistant-lookup-chip"
                  onClick={() => handleAssistantLookupAction(chip.id)}
                  disabled={chatLoading}
                >
                  {chip.label}
                </button>
              ))}
            </div>
          </div>
          {assistantSelection ? (
            <div className="inline-note assistant-selection-note">
              Selected target: {assistantSelection.title || assistantSelection.relativePath || assistantSelection.serviceName || "None"}
            </div>
          ) : null}
        </div>
        <AssistantPlanCards cards={assistantDisplayPlanCards} onRunAction={runAssistantPlanAction} />
        {!chatMessages.length && !chatLoading ? (
          <div className="message system">{assistantEmptyStateText}</div>
        ) : null}
        {assistantDisplayMessages.map((m) => (
          <div key={m.id} className={`message ${m.role}`}>
            {m.content ? <div>{m.content}</div> : null}
            {m.summary ? (
              <div className="chat-plan">
                <div className="chat-summary">
                  <span className="detail-label">Summary</span>
                  <div>{m.summary}</div>
                </div>
                {m.lookup ? (
                  <div>
                    <span className="detail-label">Lookup Results</span>
                    <AssistantLookupResults
                      lookup={m.lookup}
                      selection={assistantSelection}
                      onSelectItem={handleSelectAssistantItem}
                      onPreviewItem={handlePreviewAssistantItem}
                      onExplainItem={handleExplainAssistantItem}
                    />
                  </div>
                ) : null}
                <div>
                  <span className="detail-label">Suggestions</span>
                  <ul className="suggestion-list">
                    {(Array.isArray(m.suggestions) ? m.suggestions : []).map((suggestion) => (
                      <li key={suggestion}>{suggestion}</li>
                    ))}
                  </ul>
                </div>
                {m.proposedAction ? (
                  <div className="suggested-action-card">
                    <span className="detail-label">
                      Suggested Action: Restart {m.proposedAction.serviceName || "selected service"}
                    </span>
                    <div>{m.proposedAction.reason || "No reason provided."}</div>
                    <button
                      type="button"
                      className="secondary-button assistant-window-action-link"
                      onClick={() => applySuggestedAction(m.proposedAction)}
                    >
                      Open in Actions Panel
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
        {chatLoading ? <div className="message system">{assistantLoadingText}</div> : null}
      </div>

      <form className="composer" onSubmit={handleChatSubmit}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about diagnosis, logs, host ownership, reports, or safe file lookup..."
        />
        <button disabled={chatLoading}>{chatLoading ? "Analyzing..." : "Send"}</button>
      </form>
    </section>
  );

  return (
    <>
      <div
        className={`app-shell ${isAssistantDocked ? "app-shell-assistant-docked" : "app-shell-assistant-collapsed"} ${
          isAssistantMinimized ? "app-shell-assistant-minimized" : ""
        }`}
      >
      <aside className="sidebar">
        <div className="sidebar-header">
          <span className="eyebrow">Garage Admin V2</span>
          <h1>Operations</h1>
          <p>Host-aware control plane with approval-bound restarts.</p>
        </div>

        <section className="rail-section">
          <div className="section-heading">
            <div className="section-heading-copy">
              <h2>Services</h2>
              {!initialLoading ? (
                <div className="service-inventory-freshness" title={serviceInventoryFreshness.title || serviceInventoryFreshness.label}>
                  <span className={`signal-freshness-badge signal-freshness-badge-${serviceInventoryFreshness.bucket}`}>
                    {serviceInventoryFreshness.label}
                  </span>
                  {serviceInventoryFreshness.ageHint ? (
                    <span className="signal-freshness-summary">{serviceInventoryFreshness.ageHint}</span>
                  ) : null}
                  {serviceInventoryFreshness.provenanceText ? (
                    <span className="service-inventory-provenance">{serviceInventoryFreshness.provenanceText}</span>
                  ) : null}
                  <div
                    className="service-inventory-sources"
                    title={
                      serviceInventoryFreshness.sourceBreakdownTitle ||
                      serviceInventoryFreshness.sourceBreakdownSummary ||
                      "Sources: unknown"
                    }
                  >
                    <span className="service-inventory-sources-label">Sources:</span>
                    {serviceInventoryFreshness.sourceBreakdown.length ? (
                      serviceInventoryFreshness.sourceBreakdown.map((source) => (
                        <span
                          key={source.key}
                          className={`signal-freshness-badge signal-freshness-badge-${source.bucket} service-inventory-source-chip`}
                          title={source.title || source.compactLabel}
                        >
                          {source.compactLabel}
                        </span>
                      ))
                    ) : (
                      <span className="service-inventory-sources-empty">unknown</span>
                    )}
                  </div>
                  {serviceInventoryFreshness.sourceHint ? (
                    <span
                      className="service-inventory-hint service-inventory-source-hint"
                      title={serviceInventoryFreshness.sourceHintTitle || serviceInventoryFreshness.sourceHint}
                    >
                      {serviceInventoryFreshness.sourceHint}
                    </span>
                  ) : null}
                  {serviceInventoryFreshness.hint ? (
                    <span className="service-inventory-hint">{serviceInventoryFreshness.hint}</span>
                  ) : null}
                </div>
              ) : null}
            </div>
            <span className="count-pill">{serviceItems.length}</span>
          </div>
          <div className="list service-rail-list">
            {initialLoading ? <div className="empty-state">Loading services...</div> : null}
            {!initialLoading && !serviceItems.length ? (
              <div className="empty-state">No services discovered.</div>
            ) : null}
            {!initialLoading
              ? serviceGroups.map((group) => (
                  <ServiceGroupDisclosure
                    key={group.key}
                    title={group.title}
                    summary={group.summary}
                    defaultOpen={group.containsSelectedService || group.attentionCount > 0 || group.key === "api"}
                    forceOpen={group.containsSelectedService}
                    className={group.attentionCount ? "service-group-disclosure-attention" : ""}
                  >
                    <div className="service-group-list">
                      {group.services.map((service) => (
                        <button
                          key={service.name}
                          type="button"
                          className={`list-item interactive-item service-card service-severity-${
                            service.classification?.severity || "unknown"
                          } ${selectedService === service.name ? "selected" : ""}`}
                          onClick={() => handleServiceSelect(service.name)}
                        >
                          <span className="service-row">
                            <strong title={service.displayName}>{service.displayName}</strong>
                            <span className={`status-badge ${statusClassName(service.status)}`} title={service.status}>
                              {formatStatusLabel(service.status)}
                            </span>
                          </span>
                          <span className="service-chip-row">
                            <span className="service-type-pill">{service.classification?.type || "Unknown"}</span>
                            <span
                              className={`service-severity-pill service-severity-pill-${
                                service.classification?.severity || "unknown"
                              }`}
                            >
                              {formatStatusLabel(service.classification?.severity || "unknown")}
                            </span>
                          </span>
                          <span className="service-meta" title={getCompactServiceMeta(service)}>
                            {getCompactServiceMeta(service)}
                          </span>
                          {service.classification?.primarySetupHint ? (
                            <span className="service-hint" title={service.classification.primarySetupHint}>
                              {service.classification.primarySetupHint}
                            </span>
                          ) : null}
                        </button>
                      ))}
                    </div>
                  </ServiceGroupDisclosure>
                ))
              : null}
          </div>
        </section>

      </aside>

      <main className="ops-workspace">
        {initialError ? (
          <div className="banner error-banner">Initial load failed: {initialError}</div>
        ) : null}

        <section className="workspace-header">
          <div className="workspace-title">
            <span className="eyebrow">Operator console</span>
            <div className="workspace-title-row">
              <h1 title={selectedServiceRecord?.displayName || selectedService || "No service selected"}>
                {selectedServiceRecord?.displayName || selectedService || "No service selected"}
              </h1>
              {selectedService ? (
                <span className={`status-badge ${statusClassName(selectedServiceStatus)}`} title={selectedServiceStatus}>
                  {formatStatusLabel(selectedServiceStatus)}
                </span>
              ) : null}
            </div>
            <p title={selectedServiceRecord ? selectedServiceHeaderSummary : undefined}>
              {selectedServiceHeaderSummary}
            </p>
            {selectedServiceRecord ? (
              <div className="workspace-summary">
                <span title={outputAlertSummary}>{outputAlertSummary}</span>
              </div>
            ) : null}
          </div>
          {ENABLE_EXPERIMENTAL_LAYOUT_CUSTOMIZATION ? (
            <div className="workspace-actions">
              <span className={`count-pill incident-count-pill ${incidentItems.length ? "incident-count-pill-active" : ""}`}>
                {incidentItems.length} incident{incidentItems.length === 1 ? "" : "s"}
              </span>
              <button type="button" className="layout-reset-button" onClick={handleResetLayout}>
                Reset layout
              </button>
            </div>
          ) : (
            <div className="workspace-actions">
              <span className={`count-pill incident-count-pill ${incidentItems.length ? "incident-count-pill-active" : ""}`}>
                {incidentItems.length} incident{incidentItems.length === 1 ? "" : "s"}
              </span>
            </div>
          )}
        </section>

        <nav className="workspace-tabs" aria-label="Garage workspace tabs">
          {WORKSPACE_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`workspace-tab ${activeWorkspaceTab === tab.id ? "is-active" : ""}`}
              onClick={() => setActiveWorkspaceTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <div className={`workspace-scroll workspace-scroll-tab-${activeWorkspaceTab}`}>
          <DisclosureSection
            title="Incidents"
            summary={`${incidentItems.length} incident${incidentItems.length === 1 ? "" : "s"}`}
            defaultOpen={incidentsDisclosureDefaultOpen}
            className="incidents-disclosure incidents-workspace-card"
            key={`incidents-${incidentItems.length}-${initialLoading ? "loading" : "ready"}`}
          >
            <div className="list">
              {initialLoading ? <div className="empty-state">Loading incidents...</div> : null}
              {!initialLoading && !incidentItems.length ? (
                <div className="empty-state">No incidents recorded.</div>
              ) : null}
              {incidentItems.map((incident) => (
                <button
                  key={incident.id}
                  type="button"
                  className={`list-item interactive-item ${
                    selectedIncidentId === incident.id ? "selected incident-selected" : ""
                  }`}
                  onClick={() => handleIncidentSelect(incident)}
                >
                  <strong title={incident.title}>{incident.title}</strong>
                  <span title={`${incident.status}${incident.serviceName ? ` Â· ${incident.serviceName}` : ""}`}>
                    {incident.status}
                    {incident.serviceName ? ` Â· ${incident.serviceName}` : ""}
                  </span>
                </button>
              ))}
            </div>
          </DisclosureSection>

          {activeWorkspaceTab === "workers" ? (
            <section className="workspace-tab-panel workspace-tab-panel--workers">
              <div className="workspace-tab-heading">
                <span className="section-title">Workers</span>
                <h2>Worker Evidence</h2>
                <p>
                  Read-only worker evidence stays separate from Service Actions. Workers collect proof, not approvals,
                  restarts, rebuilds, repairs, migrations, deletes, or writes.
                </p>
              </div>
              <WorkerEvidencePanel />
            </section>
          ) : activeWorkspaceTab === "assistant" ? (
            <section className="workspace-tab-panel workspace-tab-panel--assistant">
              <div className="workspace-tab-heading">
                <span className="section-title">Assistant</span>
                <h2>Assistant Workspace</h2>
                <p>
                  Use the assistant for grounded operator plans and explanations. Chat cannot execute restarts, approvals,
                  file writes, destructive actions, or worker jobs.
                </p>
              </div>
              <div className="workspace-tab-card-grid">
                <article className="panel workspace-tab-card">
                  <span className="detail-label">Current context</span>
                  <h3>{selectedServiceRecord?.displayName || selectedService || "No service selected"}</h3>
                  <p className="inline-note">
                    {selectedServiceRecord
                      ? selectedServiceHeaderSummary
                      : "Select a service from the rail to ground assistant context."}
                  </p>
                  <div className="inline-badges">
                    <span className={`status-badge ${statusClassName(selectedServiceStatus)}`}>
                      {formatStatusLabel(selectedServiceStatus)}
                    </span>
                    <span className="status-badge status-info">{formatAssistantHostOwnership(selectedServiceRecord?.host) || "Host unknown"}</span>
                  </div>
                </article>
                <article className="panel workspace-tab-card">
                  <span className="detail-label">Assistant mode</span>
                  <h3>{isAssistantExpanded ? "Expanded" : isAssistantDocked ? "Docked" : "Minimized"}</h3>
                  <p className="inline-note">
                    The expanded assistant keeps the dashboard available while giving chat more room for plans, lookup results, and evidence cards.
                  </p>
                  <div className="panel-actions">
                    <button type="button" className="secondary-button" onClick={handleOpenAssistantExpanded}>
                      Open Assistant
                    </button>
                    <button type="button" className="secondary-button" onClick={() => setAssistantMode(ASSISTANT_MODES.DOCKED)}>
                      Dock Assistant
                    </button>
                  </div>
                </article>
              </div>
            </section>
          ) : (
          <SelectedServiceWorkspaceBoundary
            resetKey={`${selectedService || "none"}-${selectedServiceRecord?.lastSeen || "na"}`}
            serviceName={selectedServiceRecord?.displayName || selectedService || ""}
          >
          <div className={`workspace-columns workspace-columns-tab-${activeWorkspaceTab} ${isAssistantMinimized ? "workspace-columns-assistant-minimized" : ""}`}>
            <div className="workspace-main-column">
          {selectedServiceRecord ? (
            <DisclosureSection
              title="Details"
              summary="Service metadata, runtime, and notes"
              className="service-details"
              key={`details-${selectedService || "none"}`}
            >
              <div className="service-details-grid">
                {serviceDetailItems.map((item) => (
                  <div key={item.label} className="detail-item">
                    <span className="detail-label">{item.label}</span>
                    <span className="detail-value" title={item.value}>
                      {item.value}
                    </span>
                  </div>
                ))}
              </div>
              <div className="service-relationship-section">
                <div>
                  <span className="detail-label">Relationships</span>
                  <p className="service-relationship-copy">Declared provide and dependency metadata used for diagnosis correlation.</p>
                </div>
                {selectedServiceRelationshipSections.length ? (
                  <div className="service-relationship-list">
                    {selectedServiceRelationshipSections.map((section) => (
                      <div key={section.label} className="service-relationship-row">
                        <span className="detail-label">{section.label}</span>
                        <div className="relationship-chip-row">
                          {section.items.map((item) =>
                            item.serviceId ? (
                              <button
                                key={item.key}
                                type="button"
                                className="relationship-chip relationship-chip-button"
                                title={item.title}
                                onClick={() => setSelectedService(item.serviceId)}
                                disabled={item.serviceId === selectedService}
                              >
                                <span className="relationship-chip-value">{item.value}</span>
                                {item.meta ? <span className="relationship-chip-meta">{item.meta}</span> : null}
                              </button>
                            ) : (
                              <span key={item.key} className="relationship-chip" title={item.title}>
                                <span className="relationship-chip-value">{item.value}</span>
                                {item.meta ? <span className="relationship-chip-meta">{item.meta}</span> : null}
                              </span>
                            ),
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="service-relationship-empty">No declared service relationships.</div>
                )}
              </div>
            </DisclosureSection>
          ) : null}

          {selectedServiceRecord ? (
            <DisclosureSection
              title="Current Signals"
              summary={outputAlertSummary}
              defaultOpen={signalDisclosureDefaultOpen}
              className="signal-details"
              key={`signals-${selectedService || "none"}-${signalAlertCount}-${signalDisclosureDefaultOpen ? "open" : "closed"}-${
                latestVisibleAction?.id || "none"
              }`}
            >
              <div className="service-details-grid signal-details-grid">
                {signalDetailItems.map((item) => (
                  <div key={item.label} className="detail-item">
                    <span className="detail-label">{item.label}</span>
                    <span className="detail-value" title={item.value}>
                      {item.value}
                    </span>
                  </div>
                ))}
              </div>
              {dependencyHealthRollup ? (
                <div className="signal-dependency-section">
                  <div>
                    <span className="detail-label">Dependencies</span>
                    <p className="service-relationship-copy">Declared dependency status from current service inventory and health metadata.</p>
                  </div>
                  <div className="signal-dependency-summary">
                    <span className="status-badge status-unknown">
                      {dependencyHealthRollup.declaredCount} dependenc{dependencyHealthRollup.declaredCount === 1 ? "y" : "ies"} declared
                    </span>
                    <span className="status-badge status-healthy">
                      {dependencyHealthRollup.counts.healthy} healthy / running
                    </span>
                    <span className="status-badge status-warning">{dependencyHealthRollup.counts.warning} warning</span>
                    <span className="status-badge status-failed">{dependencyHealthRollup.counts.failed} failed</span>
                    <span className="status-badge status-unknown">{dependencyHealthRollup.counts.unknown} unknown</span>
                    <span className="signal-freshness-summary">Status freshness: {dependencyHealthRollup.freshnessSummary}</span>
                  </div>
                  <div className="relationship-chip-row">
                    {dependencyHealthRollup.items.map((item) =>
                      item.serviceId && item.hasInventoryService ? (
                        <button
                          key={item.key}
                          type="button"
                          className={`relationship-chip relationship-chip-button signal-dependency-chip ${
                            item.diagnosisRelated ? "signal-dependency-chip-related" : ""
                          }`}
                          title={item.title}
                          onClick={() => setSelectedService(item.serviceId)}
                          disabled={item.serviceId === selectedService}
                        >
                          <span className="signal-dependency-chip-header">
                            <span className="relationship-chip-value">{item.label}</span>
                            <span className="signal-dependency-chip-statuses">
                              <span className={`status-badge ${statusClassName(item.status)}`}>{formatStatusLabel(item.status)}</span>
                              <span
                                className={`signal-freshness-badge signal-freshness-badge-${item.freshness}`}
                                title={
                                  item.freshnessTimestamp
                                    ? `${formatDependencyFreshnessLabel(item.freshness)} via ${item.freshnessTimestampSource || "timestamp"} at ${formatCreatedAt(item.freshnessTimestamp)}`
                                    : "Unknown freshness from current service inventory"
                                }
                              >
                                {formatDependencyFreshnessLabel(item.freshness)}
                              </span>
                            </span>
                          </span>
                          {item.endpoint ? <span className="relationship-chip-meta">Endpoint: {item.endpoint}</span> : null}
                          {item.confidence ? <span className="relationship-chip-meta">Confidence: {formatStatusLabel(item.confidence)}</span> : null}
                          {item.diagnosisLabel ? <span className="signal-dependency-chip-note">{item.diagnosisLabel}</span> : null}
                          {item.diagnosisFreshnessLabel ? (
                            <span className="signal-dependency-chip-note signal-dependency-chip-note-muted">{item.diagnosisFreshnessLabel}</span>
                          ) : null}
                        </button>
                      ) : (
                        <span
                          key={item.key}
                          className={`relationship-chip signal-dependency-chip ${item.diagnosisRelated ? "signal-dependency-chip-related" : ""}`}
                          title={item.title}
                        >
                          <span className="signal-dependency-chip-header">
                            <span className="relationship-chip-value">{item.label}</span>
                            <span className="signal-dependency-chip-statuses">
                              <span className={`status-badge ${statusClassName(item.status)}`}>{formatStatusLabel(item.status)}</span>
                              <span
                                className={`signal-freshness-badge signal-freshness-badge-${item.freshness}`}
                                title={
                                  item.freshnessTimestamp
                                    ? `${formatDependencyFreshnessLabel(item.freshness)} via ${item.freshnessTimestampSource || "timestamp"} at ${formatCreatedAt(item.freshnessTimestamp)}`
                                    : "Unknown freshness from current service inventory"
                                }
                              >
                                {formatDependencyFreshnessLabel(item.freshness)}
                              </span>
                            </span>
                          </span>
                          {item.endpoint ? <span className="relationship-chip-meta">Endpoint: {item.endpoint}</span> : null}
                          {item.confidence ? <span className="relationship-chip-meta">Confidence: {formatStatusLabel(item.confidence)}</span> : null}
                          {item.diagnosisLabel ? <span className="signal-dependency-chip-note">{item.diagnosisLabel}</span> : null}
                          {item.diagnosisFreshnessLabel ? (
                            <span className="signal-dependency-chip-note signal-dependency-chip-note-muted">{item.diagnosisFreshnessLabel}</span>
                          ) : null}
                        </span>
                      ),
                    )}
                  </div>
                </div>
              ) : null}
            </DisclosureSection>
          ) : null}

          <DisclosureSection
            title="Diagnosis"
            summary={diagnosisSummaryText}
            defaultOpen={true}
            className="diagnosis-section"
            key={`diagnosis-${selectedService || "none"}-${diagnosis?.detected ? diagnosis.primaryIssue : "clear"}-${
              diagnosis?.timestamp || "none"
            }`}
          >
            <div className="diagnosis-panel">
              <div className="diagnosis-heading-row">
                <div className="diagnosis-heading-copy">
                  <span className="section-title">Diagnosis</span>
                  <p>{diagnosisSupportText}</p>
                </div>
                {selectedService ? (
                  <div className="diagnosis-badges">
                    <span className={`status-badge status-severity-${diagnosis?.severity || "info"}`}>
                      Severity: {formatBadgeLabel(diagnosis?.severity || "info")}
                    </span>
                    <span className={`status-badge status-confidence-${diagnosis?.confidence || "low"}`}>
                      Confidence: {formatBadgeLabel(diagnosis?.confidence || "low")}
                    </span>
                    <span className="status-badge status-risk-unknown">Source: {formatBadgeLabel(diagnosis?.source || "none")}</span>
                  </div>
                ) : null}
              </div>

              {!selectedService ? (
                <div className="empty-state output-empty">Select a service to generate a diagnosis.</div>
              ) : (
                <div className="diagnosis-content">
                  <div className="diagnosis-signal-strip">
                    <span className="detail-label">Extracted signals</span>
                    <div className="diagnosis-signal-grid">
                      {diagnosisHighlights.map((item) => (
                        <div key={`${item.label}-${item.value}`} className="detail-item diagnosis-signal-item">
                          <span className="detail-label">{item.label}</span>
                          <span className="detail-value diagnosis-detail-value" title={item.value}>
                            {item.value}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {diagnosis?.detected ? (
                    <>
                      <div className="diagnosis-next-step-block">
                        <span className="detail-label">Suggested next safe step</span>
                        <strong>{diagnosisNextStep}</strong>
                      </div>

                      <div className="diagnosis-grid">
                        {diagnosisDetailItems.map((item) => (
                          <div key={item.label} className="detail-item">
                            <span className="detail-label">{item.label}</span>
                            <span className="detail-value diagnosis-detail-value" title={item.value}>
                              {item.value}
                            </span>
                          </div>
                        ))}
                      </div>

                      {diagnosisSelectTarget ? (
                        <div className="diagnosis-related-actions">
                          <button
                            type="button"
                            className="mini-button relationship-select-button"
                            onClick={() => setSelectedService(diagnosisSelectTarget)}
                          >
                            Select related service
                          </button>
                        </div>
                      ) : null}

                      {diagnosis.suggestedCommand ? (
                        <div className="diagnosis-command-block">
                          <span className="detail-label">Suggested safe command</span>
                          <pre className="diagnosis-command" tabIndex={0}>
                            {diagnosis.suggestedCommand}
                          </pre>
                        </div>
                      ) : null}

                      <div className="diagnosis-actions-block">
                        <span className="detail-label">Suggested actions</span>
                        <ul className="suggestion-list diagnosis-suggestion-list">
                          {(Array.isArray(diagnosis?.suggestedActions) ? diagnosis.suggestedActions : []).map((action) => (
                            <li key={action}>{action}</li>
                          ))}
                        </ul>
                      </div>
                    </>
                  ) : (
                    <div className="diagnosis-clear-state">
                      <div className="diagnosis-clear-copy">
                        <strong>{diagnosisSummaryText}</strong>
                        <span>
                          Service status: {formatStatusLabel(selectedServiceStatus)} Â· {outputAlertSummary}
                        </span>
                      </div>
                      <div className="diagnosis-actions-block">
                        <span className="detail-label">Suggested safe actions</span>
                        <ul className="suggestion-list diagnosis-suggestion-list">
                          {diagnosisSuggestedActions.map((action) => (
                            <li key={action}>{action}</li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </DisclosureSection>

          <section className="panel logs-panel">
            <div className="panel-heading">
              <div>
                <span className="section-title">Logs</span>
                <h2>Service Logs</h2>
                <p>
                  {selectedService
                    ? `${logLineCount} lines Â· ${formatBytes(logs || "")}${
                        hasActiveLogFilter ? ` Â· ${visibleLogLines.length} shown` : ""
                      }`
                    : "No service selected"}
                </p>
              </div>
              <div className="panel-actions">
                <input
                  className="log-filter-input"
                  value={logFilter}
                  onChange={(event) => setLogFilter(event.target.value)}
                  placeholder="Filter logs"
                  disabled={!hasLogs}
                />
                <button
                  type="button"
                  className={`toggle-button ${logAlertOnly ? "toggle-active" : ""}`}
                  onClick={() => setLogAlertOnly((current) => !current)}
                  disabled={!hasLogs || !logSignals.alertCount}
                >
                  Alerts
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={handleClearLogFilters}
                  disabled={!hasActiveLogFilter}
                >
                  Clear Filter
                </button>
                <button type="button" className="secondary-button" onClick={handleCopyLogs} disabled={!hasLogs}>
                  {hasActiveLogFilter ? "Copy Visible" : "Copy Logs"}
                </button>
                <button type="button" className="secondary-button" onClick={handleDownloadLogs} disabled={!hasLogs}>
                  Download .txt
                </button>
                <button type="button" className="secondary-button" onClick={handleArchiveLogs} disabled={!hasLogs}>
                  Archive
                </button>
                <button type="button" className="secondary-button" onClick={handleClearLogs} disabled={!hasLogs && !logsError}>
                  Clear
                </button>
              </div>
            </div>

            {logsLoading ? <div className="empty-state output-empty">Loading logs...</div> : null}
            {logsError ? <div className="error-text">Logs unavailable: {logsError}</div> : null}
            {logCopyStatus ? <div className="inline-note">{logCopyStatus}</div> : null}
            {!logsLoading && !logsError ? (
              <>
                <div className="log-highlight-section">
                  <div className="log-highlight-section-heading">
                    <div>
                      <span className="detail-label">Extracted events</span>
                      <p>Important log signatures are surfaced here before the raw stream.</p>
                    </div>
                    {diagnosisLogEvents.length ? (
                      <span className="count-pill">{diagnosisLogEvents.length}</span>
                    ) : null}
                  </div>
                  <LogEventHighlights
                    events={diagnosisLogEvents}
                    emptyMessage={extractedEventsEmptyMessage}
                    onSelectService={setSelectedService}
                    selectedServiceId={selectedService}
                  />
                </div>
                <LogViewer lines={hasLogs ? visibleLogLines : null} emptyMessage={filteredLogEmptyMessage} />
              </>
            ) : null}
            {logsArchiveItems.length ? (
              <div className="archive-note">
                {logsArchiveItems.length} log archive{logsArchiveItems.length === 1 ? "" : "s"} this session. Latest:{" "}
                {logsArchiveItems[0].serviceName} Â· {logsArchiveItems[0].lineCount} lines Â·{" "}
                {formatCreatedAt(logsArchiveItems[0].archivedAt)}
              </div>
            ) : null}
          </section>

            </div>

            <div className="workspace-side-column">
              <section
                className={`ops-grid ${isAssistantMinimized ? "ops-grid-assistant-minimized" : ""}`}
                ref={opsGridRef}
                style={{
                  "--right-top-track": `${rightPanelSplit}fr`,
                  "--right-bottom-track": `${1 - rightPanelSplit}fr`,
                }}
              >
          <section className="panel actions-panel" style={{ gridArea: rightPanelGridAreas.actions }}>
            <div className="panel-heading">
              <div>
                <span className="section-title">Actions</span>
                <h2>Service Actions</h2>
                <p>
                  {selectedServiceRecord
                    ? selectedServiceRecord.displayName
                    : "Select a service to create actions."}
                </p>
              </div>
              {ENABLE_EXPERIMENTAL_LAYOUT_CUSTOMIZATION ? (
                <LayoutCardControls
                  cardId="actions"
                  label="Actions"
                  order={rightPanelOrder}
                  onMove={moveRightPanelCard}
                />
              ) : null}
            </div>

            <div className="panel-scroll actions-panel-scroll">
            {selectedService ? (
              <div className="action-block">
                <div className="action-form two-column compact-fields">
                  <label>
                    <span className="detail-label">Requested by</span>
                    <input
                      name="requestedBy"
                      value={restartForm.requestedBy}
                      onChange={handleRestartFormChange}
                      placeholder="operator name"
                      required
                    />
                  </label>
                  <label>
                    <span className="detail-label">Approved by</span>
                    <input
                      name="approvedBy"
                      value={restartForm.approvedBy}
                      onChange={handleRestartFormChange}
                      placeholder="approval operator"
                    />
                  </label>
                </div>

                <div className="run-action-grid">
                  <button
                    type="button"
                    className="run-action-button"
                    onClick={() => runReadOnlyAction("fetch-logs")}
                    disabled={restartSubmitting || !selectedServiceCanFetchLogs}
                    title={capabilityMessage(selectedServiceLogsCapability, getActionRiskProfile("fetch-logs").detail)}
                  >
                    <strong>Fetch Logs</strong>
                    <span>{actionSupportSummary("fetch-logs", selectedServiceLogsCapability)}</span>
                    <span
                      className={`status-badge status-risk-${getActionRiskProfile("fetch-logs").riskLevel} action-risk-badge`}
                      title={getActionRiskProfile("fetch-logs").detail}
                    >
                      {getActionRiskProfile("fetch-logs").label}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="run-action-button"
                    onClick={() => runReadOnlyAction("health-check")}
                    disabled={restartSubmitting || !selectedServiceCanRunHealthCheck}
                    title={capabilityMessage(selectedServiceHealthCapability, getActionRiskProfile("health-check").detail)}
                  >
                    <strong>Run Health Check</strong>
                    <span>{actionSupportSummary("health-check", selectedServiceHealthCapability)}</span>
                    <span
                      className={`status-badge status-risk-${getActionRiskProfile("health-check").riskLevel} action-risk-badge`}
                      title={getActionRiskProfile("health-check").detail}
                    >
                      {getActionRiskProfile("health-check").label}
                    </span>
                  </button>
                </div>

                {!selectedServiceCanFetchLogs || !selectedServiceCanRunHealthCheck ? (
                  <div className="action-support-notes">
                    {!selectedServiceCanFetchLogs ? (
                      <div className="inline-note">
                        Fetch Logs: {capabilityMessage(selectedServiceLogsCapability, "Unavailable for this service.")}
                      </div>
                    ) : null}
                    {!selectedServiceCanRunHealthCheck ? (
                      <div className="inline-note">
                        Run Health Check: {capabilityMessage(selectedServiceHealthCapability, "Unavailable for this service.")}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                <div className="health-inline">
                  <div className="inline-status-block">
                    <span className="detail-label">Health</span>
                    <div className="inline-status-row">
                      <span className={`status-badge ${hasHealthOutput && healthOutput.ok ? "status-completed" : hasHealthOutput ? "status-failed" : "status-unknown"}`}>
                        {hasHealthOutput ? (healthOutput.ok ? "ok" : "attention") : "none"}
                      </span>
                      <span>
                        {healthMeta?.receivedAt
                          ? `${healthStatusText} Â· ${formatCreatedAt(healthMeta.receivedAt)}`
                          : "Run a health check to load current output."}
                      </span>
                    </div>
                  </div>
                  <div className="mini-actions">
                    <button type="button" className="mini-button" onClick={handleDownloadHealth} disabled={!hasHealthOutput}>
                      JSON
                    </button>
                    <button type="button" className="mini-button" onClick={handleArchiveHealth} disabled={!hasHealthOutput}>
                      Archive
                    </button>
                    <button type="button" className="mini-button" onClick={handleClearHealth} disabled={!hasHealthOutput}>
                      Clear
                    </button>
                  </div>
                </div>

                <div
                  className={`approval-details-card approval-details-card-risk-${
                    restartRiskProfile?.riskLevel || "unknown"
                  } ${selectedServiceCanRestart ? "" : "approval-details-card-unsupported"}`}
                >
                  <div className="approval-details-header">
                    <div>
                      <span className="section-title">Approval</span>
                      <h3>Restart Approval Details</h3>
                    </div>
                    <span
                      className={`status-badge status-risk-${restartRiskProfile?.riskLevel || "unknown"}`}
                      title={restartRiskProfile?.detail || "Review before running."}
                    >
                      {restartRiskProfile?.label || "Unknown"}
                    </span>
                  </div>
                  <div className="approval-details-grid">
                    {restartApprovalDetails.map((item) => (
                      <div key={item.label} className="detail-item">
                        <span className="detail-label">{item.label}</span>
                        <span className="detail-value approval-detail-value" title={item.value}>
                          {item.value}
                        </span>
                      </div>
                    ))}
                  </div>
                  <ApprovalFreshnessSection
                    approvalContext={restartApprovalContext}
                    onRefreshInventory={handleRefreshInventory}
                    refreshBusy={inventoryRefreshBusy}
                    refreshError={inventoryRefreshError}
                  />
                </div>

                <DisclosureSection
                  title="Restart"
                  summary={restartSummaryText}
                  defaultOpen={restartDisclosureDefaultOpen}
                  className={`restart-disclosure ${selectedServiceCanRestart ? "" : "restart-disclosure-quiet"}`}
                  key={`restart-${selectedService || "none"}-${selectedServiceCanRestart ? "supported" : "unsupported"}-${
                    showRestartForm ? "form" : "summary"
                  }-${restartResult?.action?.id || "none"}`}
                >
                  {showRestartForm && selectedServiceCanRestart ? (
                    <form className="action-form" onSubmit={handleRestartSubmit}>
                      <label>
                        <span className="detail-label">Reason</span>
                        <input
                          name="reason"
                          value={restartForm.reason}
                          onChange={handleRestartFormChange}
                          placeholder="optional reason"
                        />
                      </label>
                      <div className="action-row">
                        <button type="submit" className="action-button" disabled={restartSubmitting}>
                          {restartSubmitting ? "Creating..." : "Create Restart Action"}
                        </button>
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={handleRestartCancel}
                          disabled={restartSubmitting}
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  ) : (
                    <div className={`restart-state-row ${selectedServiceCanRestart ? "" : "quiet-state"}`}>
                      <div className="inline-status-block">
                        <span className="detail-label">Restart</span>
                        <div className="inline-badges">
                          <span
                            className={`status-badge status-risk-${restartRiskProfile?.riskLevel || "unknown"} action-risk-badge`}
                            title={restartRiskProfile?.detail || "Review before running."}
                          >
                            {restartRiskProfile?.label || "Unknown"}
                          </span>
                        </div>
                        <div className="inline-status-row">
                          <span className={`status-badge ${statusClassName(restartState)}`} title={restartState}>
                            {formatStatusLabel(restartState)}
                          </span>
                          <span>{restartStateText}</span>
                        </div>
                      </div>
                      <button
                        type="button"
                        className={`secondary-button restart-button ${
                          selectedServiceCanRestart ? "" : "guarded-restart"
                        }`}
                        onClick={() => {
                          setShowRestartForm(true);
                          setRestartError(null);
                          setRestartResult(null);
                        }}
                        disabled={restartSubmitting || !selectedServiceCanRestart}
                      >
                        {selectedServiceCanRestart ? "Prepare Restart" : "Restart unavailable"}
                      </button>
                    </div>
                  )}
                </DisclosureSection>

                {restartError ? <div className="error-text">Action failed: {restartError}</div> : null}
                {resultCopyStatus ? <div className="inline-note">{resultCopyStatus}</div> : null}
                {restartResult ? (
                  <div className="latest-action-strip">
                    <div className="compact-result-header">
                      <span className={`status-badge ${statusClassName(latestActionStatus)}`} title={latestActionStatus}>
                        {formatStatusLabel(latestActionStatus)}
                      </span>
                      <strong>{actionLabel(restartResult.action?.actionType || restartResult.result?.actionType)}</strong>
                      {latestActionRiskProfile ? (
                        <span
                          className={`status-badge status-risk-${latestActionRiskProfile.riskLevel}`}
                          title={latestActionRiskProfile.detail}
                        >
                          {latestActionRiskProfile.label}
                        </span>
                      ) : null}
                      <button
                        type="button"
                        className="mini-button compact-copy-button"
                        onClick={handleCopyLatestResult}
                        disabled={!latestResultClipboardText}
                      >
                        Copy Result
                      </button>
                    </div>
                    <div>{getActionResultSummary(restartResult)}</div>
                    <VerificationSummary result={getActionResult(restartResult)} />
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="empty-state output-empty">Select a service to prepare actions.</div>
            )}
            </div>
          </section>

          <div
            className={`right-stack-resizer ${rightPanelResizing ? "resizing" : ""}`}
            role="separator"
            aria-label={`Resize ${topRightPanelLabel} and ${bottomRightPanelLabel} panels`}
            aria-orientation="horizontal"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(rightPanelSplit * 100)}
            aria-valuetext={`${Math.round(rightPanelSplit * 100)}% ${topRightPanelLabel}, ${Math.round(
              (1 - rightPanelSplit) * 100,
            )}% ${bottomRightPanelLabel}`}
            tabIndex={0}
            onPointerDown={handleRightResizerPointerDown}
            onPointerMove={handleRightResizerPointerMove}
            onPointerUp={handleRightResizerPointerEnd}
            onPointerCancel={handleRightResizerPointerEnd}
            onLostPointerCapture={handleRightResizerPointerEnd}
            onKeyDown={handleRightResizerKeyDown}
          />

          <section
            className={`panel audit-panel ${visibleAudit.length ? "" : "audit-panel-empty"}`}
            style={{ gridArea: rightPanelGridAreas.audit }}
          >
            <div className="panel-heading">
              <div>
                <span className="section-title">History</span>
              </div>
              <div className="audit-toolbar">
                {ENABLE_EXPERIMENTAL_LAYOUT_CUSTOMIZATION ? (
                  <LayoutCardControls
                    cardId="audit"
                    label="Recent Audit"
                    order={rightPanelOrder}
                    onMove={moveRightPanelCard}
                  />
                ) : null}
                <div className="filter-toggle">
                  <button
                    type="button"
                    className={`toggle-button ${auditFilterMode === "all" ? "toggle-active" : ""}`}
                    onClick={() => setAuditFilterMode("all")}
                  >
                    All
                  </button>
                  <button
                    type="button"
                    className={`toggle-button ${auditFilterMode === "service" ? "toggle-active" : ""}`}
                    onClick={() => setAuditFilterMode("service")}
                    disabled={!selectedService}
                  >
                    Service
                  </button>
                </div>
                <button type="button" className="secondary-button" onClick={() => refreshAudit().catch(() => {})}>
                  {auditLoading ? "Refreshing..." : "Refresh"}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={handleCopyLatestResult}
                  disabled={!latestResultClipboardText}
                >
                  Copy Latest
                </button>
              </div>
            </div>

            {auditError ? <div className="error-text">Audit refresh failed: {auditError}</div> : null}
            <div className="panel-scroll audit-panel-scroll">
            <DisclosureSection
              title="Audit"
              summary={auditHeaderSummary || "0 entries"}
              defaultOpen={auditDisclosureDefaultOpen}
              className="audit-disclosure"
              key={`audit-${selectedService || "all"}-${auditFilterMode}-${visibleAudit.length}-${auditPendingCount}-${auditFailedCount}-${
                visibleAudit[0]?.id || "none"
              }`}
            >
              {!visibleAudit.length ? (
                <div className="empty-state output-empty subtle-empty">
                  {selectedService && auditFilterMode === "service"
                    ? "No audit entries for the selected service."
                    : "No audit entries yet."}
                </div>
              ) : null}
              <div className="audit-list">
                {visibleAudit.map((entry) => {
                  const isExpanded = expandedAuditItemIds.includes(String(entry.id || "").trim());
                  const reason =
                    entry.input && typeof entry.input === "object" && "reason" in entry.input
                      ? entry.input.reason
                      : "";
                  const auditServiceRecord = findServiceForAction(entry, serviceItems);
                  const auditRiskContext = getActionRiskContext(entry.actionType, entry, auditServiceRecord);
                  const auditRiskProfile = getActionRiskProfile(
                    entry.actionType,
                    entry,
                    auditRiskContext,
                  );
                  const auditNeedsApprovalContext =
                    entry.status === "pending" ||
                    auditRiskProfile.riskLevel === "caution" ||
                    auditRiskProfile.riskLevel === "dangerous";
                  const auditApprovalContext = auditNeedsApprovalContext
                    ? getApprovalContextForAction(entry.actionType, entry, auditServiceRecord)
                    : null;
                  const auditReviewSnapshot = selectActionReviewSnapshot(
                    entry.actionReview || entry.input?.actionReview,
                    preferredActionReviewPhaseForStatus(entry.status),
                  );
                  const auditPersistedApprovalContext = buildActionApprovalContextFromReviewSnapshot(auditReviewSnapshot);
                  const auditDisplayApprovalContext = auditPersistedApprovalContext || auditApprovalContext;
                  const auditUsesPersistedActionReview = shouldUsePersistedActionReview(auditReviewSnapshot);
                  const auditReviewDetails = auditUsesPersistedActionReview
                    ? buildPersistedActionReviewDetails(auditReviewSnapshot)
                    : shouldShowActionApprovalPreview(entry.actionType, entry, auditRiskContext)
                      ? buildActionApprovalDetails(entry.actionType, entry, auditServiceRecord, {
                          riskProfile: auditRiskProfile,
                        })
                      : [];
                  const auditReviewSourceLabel = auditUsesPersistedActionReview
                    ? `Persisted ${formatStatusLabel(auditReviewSnapshot?.phase)} snapshot`
                    : "Computed fallback context";
                  const auditFreshnessAcknowledged = Boolean(
                    approvalFreshnessAcknowledgements[String(entry.id || "").trim()],
                  );
                  const auditApprovalDecision = auditApprovalContext
                    ? evaluateApprovalFreshnessGate(auditApprovalContext, auditFreshnessAcknowledged)
                    : { allowed: true, reason: "" };
                  const unsupportedRestart = getUnsupportedRestartMessage(entry.result);
                  const verification = getVerification(entry.result);
                  const formattedInput = formatAuditValue(entry.input) || "None";
                  const formattedResult = formatAuditValue(entry.result) || "None";
                  const auditSummary = getCompactAuditSummary(entry);
                  const actionBusy = actionBusyId === entry.id;
                  const approveButtonDisabled =
                    actionBusy ||
                    !restartForm.approvedBy.trim() ||
                    !auditApprovalDecision.allowed;

                  return (
                    <div
                      key={entry.id}
                      role="button"
                      tabIndex={0}
                      className="audit-item interactive-item"
                      onClick={() => toggleAuditItem(entry.id)}
                      onKeyDown={(event) => handleAuditItemKeyDown(entry, event)}
                    >
                      <div className="audit-header">
                        <div className="audit-title-group">
                          <div className="audit-title-row">
                            <strong className="audit-action-title">{actionLabel(entry.actionType)}</strong>
                            <span
                              className={`status-badge status-risk-${auditRiskProfile.riskLevel}`}
                              title={auditRiskProfile.detail}
                            >
                              {auditRiskProfile.label}
                            </span>
                          </div>
                          <span title={entry.target}>{entry.target}</span>
                        </div>
                        <span className={`status-badge status-${entry.status}`} title={entry.status}>
                          {formatStatusLabel(entry.status)}
                        </span>
                      </div>
                      <div className="audit-meta">
                        <span title={`Requested: ${entry.requestedBy || "Unknown"}`}>
                          Requested: {entry.requestedBy || "Unknown"}
                        </span>
                        <span title={`Approved: ${entry.approvedBy || "None"}`}>
                          Approved: {entry.approvedBy || "None"}
                        </span>
                        <span title={`Risk: ${auditRiskProfile.label}`}>Risk: {auditRiskProfile.label}</span>
                        <span title={formatCreatedAt(entry.createdAt)}>{formatCreatedAt(entry.createdAt)}</span>
                      </div>

                      {unsupportedRestart ? <div className="known-failure">{unsupportedRestart}</div> : null}
                      {auditSummary ? (
                        <div className="audit-summary" title={auditSummary}>
                          {auditSummary}
                        </div>
                      ) : null}
                      {verification ? <VerificationSummary result={entry.result} /> : null}

                      {canApproveAction(entry) || canExecuteAction(entry) ? (
                        <div className="audit-actions">
                          {canApproveAction(entry) && auditApprovalContext?.gate?.requiresAcknowledgement ? (
                            <label
                              className="approval-acknowledgement"
                              onClick={(event) => event.stopPropagation()}
                            >
                              <input
                                type="checkbox"
                                checked={auditFreshnessAcknowledged}
                                onChange={(event) => setApprovalFreshnessAcknowledged(entry.id, event.target.checked)}
                              />
                              <span>{auditApprovalContext.gate.acknowledgementLabel}</span>
                            </label>
                          ) : null}
                          {canApproveAction(entry) && auditApprovalDecision.reason ? (
                            <div className="inline-note approval-gate-note">{auditApprovalDecision.reason}</div>
                          ) : null}
                          {canApproveAction(entry) ? (
                            <button
                              type="button"
                              className="secondary-button"
                              onClick={(event) => approveAction(entry, event)}
                              disabled={approveButtonDisabled}
                              title={approveButtonDisabled && auditApprovalDecision.reason ? auditApprovalDecision.reason : undefined}
                            >
                              {actionBusy ? "Approving..." : "Approve"}
                            </button>
                          ) : null}
                          {canApproveAction(entry) && auditApprovalContext?.gate?.blockedUntilRefresh ? (
                            <button
                              type="button"
                              className="mini-button"
                              onClick={handleRefreshInventory}
                              disabled={inventoryRefreshBusy}
                            >
                              {inventoryRefreshBusy ? "Refreshing..." : "Refresh Inventory"}
                            </button>
                          ) : null}
                          {canExecuteAction(entry) ? (
                            <button
                              type="button"
                              className="action-button"
                              onClick={(event) => executeAction(entry, event)}
                              disabled={actionBusy}
                            >
                              {actionBusy ? "Executing..." : "Execute"}
                            </button>
                          ) : null}
                        </div>
                      ) : null}

                      {isExpanded ? (
                        <div className="audit-details" onClick={(event) => event.stopPropagation()}>
                          {reason ? (
                            <div>
                              <span className="detail-label">Reason</span>
                              <div>{reason}</div>
                            </div>
                          ) : null}
                          {auditReviewDetails.length ? (
                            <div className="audit-approval-preview">
                              <div className="detail-header">
                                <span className="detail-label">Action review</span>
                                <span className="inline-note audit-review-origin-note">{auditReviewSourceLabel}</span>
                              </div>
                              <div className="approval-details-grid audit-approval-grid">
                                {auditReviewDetails.map((item) => (
                                  <div key={`${entry.id}-${item.label}`} className="detail-item">
                                    <span className="detail-label">{item.label}</span>
                                    <span className="detail-value approval-detail-value" title={item.value}>
                                      {item.value}
                                    </span>
                                  </div>
                                ))}
                              </div>
                              <ApprovalFreshnessSection
                                approvalContext={auditDisplayApprovalContext}
                                onRefreshInventory={handleRefreshInventory}
                                refreshBusy={inventoryRefreshBusy}
                                refreshError={inventoryRefreshError}
                              />
                            </div>
                          ) : null}
                          <div>
                            <div className="detail-header">
                              <span className="detail-label">Input</span>
                              <button
                                type="button"
                                className="mini-button"
                                onClick={(event) => handleCopyAuditValue(entry, "input", event)}
                              >
                                Copy
                              </button>
                            </div>
                            <pre className="audit-block audit-input-block" tabIndex={0}>{formattedInput}</pre>
                          </div>
                          <div>
                            <div className="detail-header">
                              <span className="detail-label">Result</span>
                              <button
                                type="button"
                                className="mini-button"
                                onClick={(event) => handleCopyAuditValue(entry, "result", event)}
                              >
                                Copy
                              </button>
                            </div>
                            <pre className="audit-block audit-result-block" tabIndex={0}>{formattedResult}</pre>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </DisclosureSection>
            </div>
          </section>
              </section>
            </div>
          </div>
          </SelectedServiceWorkspaceBoundary>
          )}
        </div>
      </main>

        {isAssistantDocked ? assistantPanelContent : null}
      </div>
      {isAssistantExpanded ? (
        <div className="assistant-overlay" aria-hidden="false">
          <div className="assistant-overlay-backdrop" />
          <div className="assistant-overlay-panel">{assistantPanelContent}</div>
        </div>
      ) : null}
      {!isAssistantDocked && !isAssistantExpanded ? (
        <div className={`assistant-launcher-cluster assistant-launcher-cluster-${assistantLauncherPosition}`}>
          <button
            type="button"
            className={`assistant-launcher ${assistantNeedsAttention ? "assistant-launcher-attention" : ""}`}
            onClick={handleOpenAssistantExpanded}
            aria-label={assistantLauncherAriaLabel}
            title={assistantLauncherTooltip}
          >
            <span className="assistant-launcher-mark" aria-hidden="true">
              AI
            </span>
            <span className="assistant-launcher-label">Assistant</span>
            <span className="assistant-launcher-status">
              {showAssistantContextBadge ? (
                <span className="assistant-launcher-badge assistant-launcher-badge-context" title={assistantLauncherTooltip}>
                  CTX
                </span>
              ) : null}
              {assistantLauncherNotificationBadge ? (
                <span
                  className={`assistant-launcher-badge ${assistantLauncherNotificationBadge.className}`}
                  title={assistantLauncherNotificationBadge.title}
                >
                  {assistantLauncherNotificationBadge.label}
                </span>
              ) : null}
            </span>
          </button>
          <button
            type="button"
            className="assistant-launcher-position"
            onClick={handleCycleAssistantLauncherPosition}
            aria-label={`Move assistant launcher. Current position ${assistantLauncherPositionMeta.label}. Next position ${assistantLauncherNextPositionMeta.label}.`}
            title={`Launcher position: ${assistantLauncherPositionMeta.label}. Click to move to ${assistantLauncherNextPositionMeta.label}.`}
          >
            {assistantLauncherPositionMeta.shortLabel}
          </button>
        </div>
      ) : null}
    </>
  );
}


