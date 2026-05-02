const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "../..");
const PROJECTS_ROOT = path.resolve(REPO_ROOT, "..");

function cleanText(value) {
  return String(value || "").trim();
}

function fileExists(filePath) {
  return Boolean(filePath && fs.existsSync(filePath));
}

function normalizeTags(value) {
  return Array.isArray(value)
    ? Array.from(new Set(value.map((entry) => cleanText(entry)).filter(Boolean)))
    : [];
}

function withAvailability(entry) {
  const localPath = fileExists(entry.localPath) ? entry.localPath : null;

  return {
    ...entry,
    tags: normalizeTags(entry.tags),
    localPath,
    available: Boolean(localPath),
  };
}

const REPORT_REGISTRY = Object.freeze(
  [
    {
      id: "aibry-control-plane-runbook",
      title: "AIBRY Current Server and Control-Plane Runbook",
      description:
        "Windows-side operator runbook for the authenticated Garage control-plane path and the current Fedora-backed admin endpoints.",
      hostContext: "cross-host",
      tags: ["aibry", "control-plane", "fedora", "windows", "runbook", "garage-tools"],
      localPath: path.join(REPO_ROOT, "tools", "garage-tools", "README.md"),
      updatedDate: null,
      safetyNotes: [
        "Read-only operator documentation only.",
        "Uses authenticated control-plane APIs instead of direct Fedora filesystem access.",
      ],
    },
    {
      id: "garage-admin-v2-project-runbook",
      title: "Garage Admin V2 Project Runbook",
      description:
        "Primary Garage Admin V2 repo runbook covering Windows PM2 runtime, build/start flow, inventory model, and safe operator workflow.",
      hostContext: "windows",
      tags: ["garage-admin-v2", "windows", "pm2", "runbook", "operator"],
      localPath: path.join(REPO_ROOT, "README.md"),
      updatedDate: null,
      safetyNotes: [
        "Local repo documentation only.",
        "Does not grant secret or control-plane access beyond documented safe APIs.",
      ],
    },
    {
      id: "garage-admin-v2-memory-update-log",
      title: "Garage Admin V2 Memory / Update Log",
      description:
        "Recent Garage Admin V2 live verification and update notes for relationship metadata, diagnosis display, and runtime checks.",
      hostContext: "windows",
      tags: ["garage-admin-v2", "verification", "update-log", "windows", "ui"],
      localPath: path.join(REPO_ROOT, "docs", "garage-admin-v2-live-verification-log-2026-04-30.txt"),
      updatedDate: "2026-04-30",
      safetyNotes: [
        "Read-only text summary captured after live verification.",
        "Confirms no production restart was performed in that session.",
      ],
    },
    {
      id: "garage-admin-v2-ui-review",
      title: "Garage Admin V2 UI Review",
      description:
        "UI review and live verification notes focused on relationship rendering, diagnosis display, and read-only log behavior.",
      hostContext: "windows",
      tags: ["garage-admin-v2", "ui-review", "verification", "windows", "diagnosis"],
      localPath: path.join(REPO_ROOT, "docs", "garage-admin-v2-live-verification-log-2026-04-30.txt"),
      updatedDate: "2026-04-30",
      safetyNotes: [
        "Safe text report under the repo docs folder.",
        "Describes observed UI/runtime behavior without exposing secrets.",
      ],
    },
    {
      id: "aibry-migration-status-forward-plan",
      title: "AIBRY Migration Status and Forward Plan",
      description:
        "Cross-host status document for the current Windows/Fedora split, TrackMaster runtime cutover, and the remaining least-privilege hardening follow-up.",
      hostContext: "cross-host",
      tags: ["aibry", "migration", "trackmaster", "windows", "fedora", "forward-plan"],
      localPath: path.join(REPO_ROOT, "docs", "trackmaster-runtime-status.md"),
      updatedDate: "2026-04-29",
      safetyNotes: [
        "Cross-host documentation only.",
        "Fedora ownership is described as control-plane state, not direct Windows filesystem access.",
      ],
    },
    {
      id: "windows-repo-sync-log",
      title: "Windows Repo Sync Log",
      description:
        "No dedicated Windows repo sync log was found under the current allowlisted roots. Use the registry entry as a safe placeholder until a local doc is added.",
      hostContext: "windows",
      tags: ["windows", "repo-sync", "placeholder", "docs"],
      localPath: null,
      updatedDate: null,
      safetyNotes: [
        "No allowlisted local file is currently registered for this report.",
        "Avoid inferring repo-sync state from unrelated runtime or shell artifacts.",
      ],
    },
    {
      id: "mastersocialmedia-migration-planning-log",
      title: "MasterSocialMedia Fedora/Postgres Migration Planning Log",
      description:
        "No explicit Fedora/Postgres migration planning log was found under the current allowlisted roots for MasterSocialMedia.",
      hostContext: "docs",
      tags: ["mastersocialmedia", "migration", "fedora", "postgres", "planning", "placeholder"],
      localPath: null,
      updatedDate: null,
      safetyNotes: [
        "No allowlisted planning log is currently available.",
        "Do not infer Fedora/Postgres migration readiness from app source files alone.",
      ],
    },
    {
      id: "masterclass-landing-chordmaster-update-log",
      title: "Masterclass Landing / ChordMaster Update Log",
      description:
        "Current documentation for the AIBRY Masterclass landing project, including the ChordMaster showcase and hosting notes.",
      hostContext: "cross-host",
      tags: ["masterclass-landing", "chordmaster", "update-log", "docs", "showcase"],
      localPath: path.join(PROJECTS_ROOT, "aibry-masterclass-landing", "README.md"),
      updatedDate: null,
      safetyNotes: [
        "Read-only project documentation only.",
        "Raw dev/prod log files stay outside the default safe preview path.",
      ],
    },
  ].map(withAvailability),
);

function listAssistantReports(query = "") {
  const normalizedQuery = cleanText(query).toLowerCase();

  if (!normalizedQuery) {
    return REPORT_REGISTRY;
  }

  return REPORT_REGISTRY.filter((entry) => {
    const haystack = [
      entry.id,
      entry.title,
      entry.description,
      entry.hostContext,
      entry.updatedDate,
      ...(entry.tags || []),
      ...(entry.safetyNotes || []),
    ]
      .map((value) => cleanText(value).toLowerCase())
      .filter(Boolean)
      .join("\n");

    return haystack.includes(normalizedQuery);
  });
}

function getAssistantReport(id) {
  const normalizedId = cleanText(id);

  if (!normalizedId) {
    return null;
  }

  return REPORT_REGISTRY.find((entry) => entry.id === normalizedId) || null;
}

module.exports = {
  PROJECTS_ROOT,
  REPO_ROOT,
  REPORT_REGISTRY,
  getAssistantReport,
  listAssistantReports,
};
