const fs = require("fs");
const path = require("path");

const serviceOperations = require("./serviceOperations");
const {
  PROJECTS_ROOT,
  REPO_ROOT,
  REPORT_REGISTRY,
  getAssistantReport,
  listAssistantReports,
} = require("../assistantReports");

const fsp = fs.promises;

const MAX_FILE_PREVIEW_BYTES = 12 * 1024;
const MAX_FILE_SEARCH_RESULTS = 12;
const MAX_FILE_SEARCH_CONTENT_BYTES = 128 * 1024;
const MAX_LOG_LINES = 80;
const MAX_SCANNED_DIRECTORIES = 1500;
const MAX_SCANNED_FILES = 5000;
const BINARY_SAMPLE_BYTES = 4096;

const ROOT_DEFINITIONS = Object.freeze([
  {
    label: "repo-docs",
    path: path.join(REPO_ROOT, "docs"),
    sourceLabel: "Windows local repo/docs",
    description: "Garage Admin V2 repo docs folder",
    hostContext: "windows",
  },
  {
    label: "repo",
    path: REPO_ROOT,
    sourceLabel: "Windows local repo/docs",
    description: "Garage Admin V2 repo root",
    hostContext: "windows",
  },
  {
    label: "projects",
    path: PROJECTS_ROOT,
    sourceLabel: "Windows local project roots",
    description: "Approved Windows projects root",
    hostContext: "windows",
  },
]);

const SKIP_DIRECTORY_NAMES = new Set(
  [
    "node_modules",
    "dist",
    "build",
    ".git",
    ".next",
    ".nuxt",
    ".cache",
    ".turbo",
    ".parcel-cache",
    "coverage",
    ".tmp-chrome-cdp",
    ".tmp-chrome-cdp2",
    ".tmp-chrome-profile",
    ".tmp-chrome-profile3",
    ".tmp-edge-cdp",
    ".tmp-edge-profile",
    "tmp",
    "temp",
  ].map((value) => value.toLowerCase()),
);

const SAFE_TEXT_EXTENSIONS = new Set(
  [
    ".md",
    ".txt",
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".json",
    ".cjs",
    ".mjs",
    ".css",
    ".html",
    ".sql",
    ".yml",
    ".yaml",
    ".ps1",
    ".psm1",
    ".psd1",
    ".sh",
    ".bat",
    ".cmd",
    ".ini",
    ".toml",
  ].map((value) => value.toLowerCase()),
);

const SENSITIVE_EXTENSIONS = new Set(
  [
    ".pem",
    ".key",
    ".crt",
    ".cer",
    ".pfx",
    ".p12",
    ".p7b",
    ".der",
    ".jks",
    ".keystore",
    ".kdb",
    ".ppk",
    ".ovpn",
    ".asc",
    ".gpg",
  ].map((value) => value.toLowerCase()),
);

const DUMP_EXTENSIONS = new Set([".dump", ".bak", ".sqlite", ".sqlite3", ".db", ".rdb"]);

function cleanText(value) {
  return String(value || "").trim();
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function getAllowlistedRoots() {
  return ROOT_DEFINITIONS.filter((root) => fs.existsSync(root.path));
}

function getAllowlistedRootsMetadata() {
  return getAllowlistedRoots().map((root) => ({
    label: root.label,
    path: root.path,
    sourceLabel: root.sourceLabel,
    description: root.description,
    hostContext: root.hostContext,
  }));
}

function normalizeRootSelection(rootLabels) {
  const allowlistedRoots = getAllowlistedRoots();

  if (!Array.isArray(rootLabels) || !rootLabels.length) {
    return {
      ok: true,
      roots: allowlistedRoots,
      invalidLabels: [],
    };
  }

  const requestedLabels = Array.from(new Set(rootLabels.map((value) => cleanText(value)).filter(Boolean)));
  const selectedRoots = allowlistedRoots.filter((root) => requestedLabels.includes(root.label));
  const invalidLabels = requestedLabels.filter((label) => !selectedRoots.some((root) => root.label === label));

  if (invalidLabels.length) {
    return {
      ok: false,
      invalidLabels,
      roots: [],
    };
  }

  return {
    ok: true,
    roots: selectedRoots,
    invalidLabels: [],
  };
}

function isPathInsideRoot(absolutePath, rootPath) {
  const relative = path.relative(rootPath, absolutePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function chooseBestRoot(absolutePath, roots = getAllowlistedRoots()) {
  return (
    roots
      .filter((root) => isPathInsideRoot(absolutePath, root.path))
      .sort((left, right) => right.path.length - left.path.length)[0] || null
  );
}

function formatTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function getHostLabel(hostContext, root = null) {
  if (hostContext === "fedora") {
    return "Fedora control-plane log/status via safe API";
  }

  if (hostContext === "cross-host") {
    return "Cross-host documentation";
  }

  if (hostContext === "docs") {
    return "Documentation registry";
  }

  if (root?.label === "projects") {
    return "Windows local project roots";
  }

  return "Windows local repo/docs";
}

function isSensitiveBaseName(filePath) {
  const baseName = path.basename(filePath).toLowerCase();

  return (
    /^\.env(?:\.|$)/.test(baseName) ||
    /(^|[-_.])(token|secret|credential|credentials|password|passwd|private|api[-_.]?key)([-_.]|$)/i.test(baseName) ||
    /^id_(rsa|dsa|ecdsa|ed25519)(?:\.|$)/i.test(baseName)
  );
}

function isDatabaseDump(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const baseName = path.basename(filePath).toLowerCase();

  if (DUMP_EXTENSIONS.has(extension)) {
    return true;
  }

  return /(^|[-_.])(dump|backup|snapshot)([-_.]|$)/i.test(baseName) && extension !== ".sql";
}

function isRawPrivateLogFile(filePath) {
  return path.extname(filePath).toLowerCase() === ".log";
}

function getBlockedReadReason(filePath) {
  const extension = path.extname(filePath).toLowerCase();

  if (isSensitiveBaseName(filePath)) {
    return {
      code: "sensitive_path_blocked",
      message: "This read was blocked because it looks like an env/secret file.",
    };
  }

  if (SENSITIVE_EXTENSIONS.has(extension)) {
    return {
      code: "sensitive_certificate_or_key_blocked",
      message: "This read was blocked because it looks like a key, certificate, token, or credential file.",
    };
  }

  if (isDatabaseDump(filePath)) {
    return {
      code: "database_dump_blocked",
      message: "This read was blocked because it looks like a database dump or backup artifact.",
    };
  }

  if (isRawPrivateLogFile(filePath)) {
    return {
      code: "raw_private_log_blocked",
      message: "This read was blocked because raw private log files are not exposed through file preview.",
    };
  }

  return null;
}

function hasTraversalSegments(value) {
  return cleanText(value)
    .split(/[\\/]+/)
    .some((segment) => segment === "..");
}

function shouldSkipDirectory(entryName) {
  return SKIP_DIRECTORY_NAMES.has(cleanText(entryName).toLowerCase());
}

function isSafeTextExtension(filePath) {
  return SAFE_TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isPreviewLikelyBlocked(filePath) {
  return Boolean(getBlockedReadReason(filePath) || !isSafeTextExtension(filePath));
}

function createItemId(prefix, value) {
  return `${prefix}:${cleanText(value).toLowerCase()}`;
}

function buildBlockedItem({
  kind = "blocked",
  title,
  path: itemPath = "",
  relativePath = "",
  root = null,
  hostContext = "windows",
  blockedReason,
  reportId = null,
  serviceName = null,
  preview = "",
}) {
  return {
    id: createItemId(kind, itemPath || title || reportId || serviceName || blockedReason),
    kind,
    title: cleanText(title) || "Blocked result",
    path: cleanText(itemPath),
    relativePath: cleanText(relativePath),
    rootLabel: root?.label || "",
    sourceLabel: root?.sourceLabel || (hostContext === "fedora" ? "Fedora-safe API" : "Allowlisted lookup"),
    hostContext,
    hostLabel: getHostLabel(hostContext, root),
    safetyStatus: "blocked",
    blockedReason: cleanText(blockedReason) || "Blocked by policy.",
    preview,
    snippet: preview,
    truncated: false,
    size: null,
    modifiedTime: null,
    updatedDate: null,
    matchType: "",
    reportId,
    serviceName,
    previewAvailable: false,
    explainable: Boolean(reportId),
  };
}

function buildReportItem(entry) {
  const root = entry.localPath ? chooseBestRoot(entry.localPath) : null;

  return {
    id: createItemId("report", entry.id),
    kind: "report",
    title: entry.title,
    path: entry.localPath || "",
    relativePath: root && entry.localPath ? path.relative(root.path, entry.localPath) : "",
    rootLabel: root?.label || "",
    sourceLabel: root?.sourceLabel || "Registry metadata",
    hostContext: entry.hostContext,
    hostLabel: getHostLabel(entry.hostContext, root),
    safetyStatus: entry.available ? "safe" : "warning",
    blockedReason: entry.available ? "" : "No allowlisted local file is currently registered for this report.",
    preview: "",
    snippet: entry.description,
    truncated: false,
    size: null,
    modifiedTime: null,
    updatedDate: entry.updatedDate || null,
    matchType: "registry",
    reportId: entry.id,
    serviceName: null,
    tags: entry.tags || [],
    safetyNotes: entry.safetyNotes || [],
    previewAvailable: entry.available,
    explainable: true,
  };
}

function buildFileItem({ absolutePath, root, stat, matchType, snippet }) {
  const hostContext = root?.hostContext || "windows";

  return {
    id: createItemId("file", absolutePath),
    kind: "file",
    title: path.basename(absolutePath),
    path: absolutePath,
    relativePath: root ? path.relative(root.path, absolutePath) : absolutePath,
    rootLabel: root?.label || "",
    sourceLabel: root?.sourceLabel || "Allowlisted filesystem",
    hostContext,
    hostLabel: getHostLabel(hostContext, root),
    safetyStatus: isPreviewLikelyBlocked(absolutePath) ? "warning" : "safe",
    blockedReason: "",
    preview: "",
    snippet: snippet || "",
    truncated: false,
    size: Number.isFinite(Number(stat?.size)) ? Number(stat.size) : null,
    modifiedTime: stat?.mtime ? formatTimestamp(stat.mtime) : null,
    updatedDate: null,
    matchType,
    reportId: null,
    serviceName: null,
    previewAvailable: !isPreviewLikelyBlocked(absolutePath),
    explainable: false,
  };
}

function buildPreviewItem({ absolutePath, root, stat, content, truncated, report = null }) {
  const hostContext = report?.hostContext || root?.hostContext || "windows";

  return {
    id: createItemId("preview", absolutePath),
    kind: "file-preview",
    title: report?.title || path.basename(absolutePath),
    path: absolutePath,
    relativePath: root ? path.relative(root.path, absolutePath) : absolutePath,
    rootLabel: root?.label || "",
    sourceLabel: root?.sourceLabel || "Allowlisted filesystem",
    hostContext,
    hostLabel: getHostLabel(hostContext, root),
    safetyStatus: "safe",
    blockedReason: "",
    preview: content,
    snippet: report?.description || "",
    truncated: truncated === true,
    size: Number.isFinite(Number(stat?.size)) ? Number(stat.size) : null,
    modifiedTime: stat?.mtime ? formatTimestamp(stat.mtime) : null,
    updatedDate: report?.updatedDate || null,
    matchType: report ? "report-preview" : "preview",
    reportId: report?.id || null,
    serviceName: null,
    tags: report?.tags || [],
    safetyNotes: report?.safetyNotes || [],
    previewAvailable: true,
    explainable: Boolean(report),
  };
}

function buildLogItem({
  serviceName,
  displayName,
  host,
  executor,
  processName,
  manager,
  filter,
  lines,
  matchedLineCount,
  totalLineCount,
  truncated,
  logTarget,
  baseUrl,
}) {
  const hostContext = executor === "fedora-bridge" || cleanText(host).toLowerCase() === "fedora" ? "fedora" : "windows";
  const preview = lines.join("\n");

  return {
    id: createItemId("logs", serviceName),
    kind: "log-preview",
    title: `${displayName || serviceName || "Selected service"} logs`,
    path: "",
    relativePath: "",
    rootLabel: "",
    sourceLabel:
      hostContext === "fedora" ? "Fedora-safe service log path" : "Windows PM2 read-only logs",
    hostContext,
    hostLabel: getHostLabel(hostContext),
    safetyStatus: "safe",
    blockedReason: "",
    preview,
    snippet: filter
      ? `Filtered ${matchedLineCount} matching line${matchedLineCount === 1 ? "" : "s"} from ${totalLineCount} available lines.`
      : `Showing ${lines.length} line${lines.length === 1 ? "" : "s"} from the capped log preview.`,
    truncated: truncated === true,
    size: null,
    modifiedTime: null,
    updatedDate: null,
    matchType: filter ? "filtered-logs" : "logs",
    reportId: null,
    serviceName: serviceName || null,
    processName: processName || null,
    manager: manager || null,
    logTarget: logTarget || null,
    baseUrl: baseUrl || null,
    totalLineCount,
    matchedLineCount,
    filter: cleanText(filter),
    previewAvailable: true,
    explainable: false,
  };
}

function success(payload, status = 200) {
  return {
    ok: true,
    status,
    ...payload,
  };
}

function failure(status, code, message, extra = {}) {
  return {
    ok: false,
    status,
    code,
    error: message,
    message,
    ...extra,
  };
}

function blocked(code, message, extra = {}) {
  return failure(403, code, message, {
    blocked: true,
    ...extra,
  });
}

async function safeReadBuffer(filePath, maxBytes) {
  const fileHandle = await fsp.open(filePath, "r");

  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await fileHandle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await fileHandle.close();
  }
}

function isProbablyBinary(buffer) {
  if (!buffer || buffer.length === 0) {
    return false;
  }

  let controlCount = 0;

  for (const byte of buffer) {
    if (byte === 0) {
      return true;
    }

    if (byte < 7 || (byte > 13 && byte < 32)) {
      controlCount += 1;
    }
  }

  return controlCount / buffer.length > 0.15;
}

function snippetAroundMatch(content, query, maxLength = 200) {
  const normalizedContent = String(content || "");
  const normalizedQuery = cleanText(query).toLowerCase();

  if (!normalizedContent) {
    return "";
  }

  if (!normalizedQuery) {
    return normalizedContent.slice(0, maxLength);
  }

  const matchIndex = normalizedContent.toLowerCase().indexOf(normalizedQuery);

  if (matchIndex < 0) {
    return normalizedContent.slice(0, maxLength);
  }

  const start = Math.max(matchIndex - Math.floor(maxLength / 3), 0);
  const end = Math.min(start + maxLength, normalizedContent.length);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < normalizedContent.length ? "..." : "";

  return `${prefix}${normalizedContent.slice(start, end)}${suffix}`;
}

async function resolveRequestedFilePath(requestPath, selectedRoots = getAllowlistedRoots()) {
  const normalizedPath = cleanText(requestPath);

  if (!normalizedPath) {
    return failure(400, "path_required", "path is required");
  }

  if (normalizedPath.includes("\0") || hasTraversalSegments(normalizedPath)) {
    return blocked("path_traversal_blocked", "Path traversal is blocked for assistant file lookup.");
  }

  if (path.isAbsolute(normalizedPath)) {
    const absolutePath = path.resolve(normalizedPath);
    const root = chooseBestRoot(absolutePath, selectedRoots);

    if (!root) {
      return blocked("path_outside_allowlist", "The requested path is outside the allowlisted assistant roots.");
    }

    try {
      const stat = await fsp.stat(absolutePath);

      if (!stat.isFile()) {
        return failure(404, "file_not_found", "The requested path is not a file.");
      }

      return success({
        absolutePath,
        root,
        stat,
      });
    } catch (_error) {
      return failure(404, "file_not_found", "The requested path was not found under the allowlisted roots.");
    }
  }

  const matches = [];

  for (const root of selectedRoots) {
    const candidatePath = path.resolve(root.path, normalizedPath);

    if (!isPathInsideRoot(candidatePath, root.path)) {
      continue;
    }

    try {
      const stat = await fsp.stat(candidatePath);

      if (!stat.isFile()) {
        continue;
      }

      matches.push({
        absolutePath: candidatePath,
        root,
        stat,
      });
    } catch (_error) {
      // Ignore missing candidates and continue checking other roots.
    }
  }

  if (!matches.length) {
    return failure(404, "file_not_found", "No allowlisted file matched the requested path.");
  }

  if (matches.length > 1) {
    return failure(
      409,
      "ambiguous_path",
      "More than one allowlisted file matched the requested relative path. Use a full path or a specific search result.",
      {
        matches: matches.slice(0, 5).map((match) => ({
          path: match.absolutePath,
          rootLabel: match.root.label,
        })),
      },
    );
  }

  return success(matches[0]);
}

async function listReports({ query = "" } = {}) {
  const items = listAssistantReports(query).map(buildReportItem);

  return success({
    query: cleanText(query),
    totalCount: REPORT_REGISTRY.length,
    count: items.length,
    allowlistedRoots: getAllowlistedRootsMetadata(),
    items,
  });
}

async function getReportDetail(id) {
  const report = getAssistantReport(id);

  if (!report) {
    return failure(404, "report_not_found", `No assistant report is registered for id "${cleanText(id)}".`);
  }

  return success({
    item: buildReportItem(report),
    allowlistedRoots: getAllowlistedRootsMetadata(),
  });
}

async function searchFiles({
  query = "",
  rootLabels = null,
  searchContent = false,
  limit = MAX_FILE_SEARCH_RESULTS,
} = {}) {
  const normalizedQuery = cleanText(query);

  if (!normalizedQuery) {
    return failure(400, "query_required", "query is required");
  }

  const rootSelection = normalizeRootSelection(rootLabels);

  if (!rootSelection.ok) {
    return blocked("invalid_root_labels", `Unknown assistant root label(s): ${rootSelection.invalidLabels.join(", ")}.`);
  }

  const roots = rootSelection.roots;
  const normalizedLimit = clampNumber(limit, 1, MAX_FILE_SEARCH_RESULTS, MAX_FILE_SEARCH_RESULTS);
  const includeContentSearch = searchContent === true;
  const results = [];
  const resultKeys = new Set();
  const directPathQuery = /[\\/]|^[A-Za-z]:/.test(normalizedQuery);
  const shouldStopState = {
    scannedDirectories: 0,
    scannedFiles: 0,
    limitReached: false,
    scanLimitReached: false,
  };

  async function maybePushFileResult(absolutePath, root, stat, matchType, snippet) {
    const resultKey = absolutePath.toLowerCase();

    if (resultKeys.has(resultKey)) {
      return;
    }

    resultKeys.add(resultKey);
    results.push(
      buildFileItem({
        absolutePath,
        root,
        stat,
        matchType,
        snippet,
      }),
    );

    if (results.length >= normalizedLimit) {
      shouldStopState.limitReached = true;
    }
  }

  if (directPathQuery) {
    const directResolution = await resolveRequestedFilePath(normalizedQuery, roots);

    if (directResolution.ok) {
      await maybePushFileResult(
        directResolution.absolutePath,
        directResolution.root,
        directResolution.stat,
        "path",
        `Direct path match under ${directResolution.root.sourceLabel}.`,
      );

      return success({
        query: normalizedQuery,
        searchContent: includeContentSearch,
        count: results.length,
        limit: normalizedLimit,
        allowlistedRoots: getAllowlistedRootsMetadata(),
        resultCapReached: shouldStopState.limitReached,
        scanCapReached: false,
        scannedDirectories: 0,
        scannedFiles: 1,
        items: results,
      });
    } else if (directResolution.blocked === true || directResolution.code === "ambiguous_path") {
      return {
        ...directResolution,
        items: [
          buildBlockedItem({
            title: "Blocked file search",
            blockedReason: directResolution.error,
          }),
        ],
        allowlistedRoots: getAllowlistedRootsMetadata(),
      };
    }
  }

  async function walkDirectory(root, directoryPath, excludedRootPaths = []) {
    if (shouldStopState.limitReached || shouldStopState.scanLimitReached) {
      return;
    }

    if (shouldStopState.scannedDirectories >= MAX_SCANNED_DIRECTORIES) {
      shouldStopState.scanLimitReached = true;
      return;
    }

    shouldStopState.scannedDirectories += 1;

    let entries = [];

    try {
      entries = await fsp.readdir(directoryPath, { withFileTypes: true });
    } catch (_error) {
      return;
    }

    for (const entry of entries) {
      if (shouldStopState.limitReached || shouldStopState.scanLimitReached) {
        return;
      }

      const entryPath = path.join(directoryPath, entry.name);

      if (excludedRootPaths.some((excludedRoot) => isPathInsideRoot(entryPath, excludedRoot))) {
        continue;
      }

      if (entry.isDirectory()) {
        if (shouldSkipDirectory(entry.name)) {
          continue;
        }

        await walkDirectory(root, entryPath, excludedRootPaths);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (shouldStopState.scannedFiles >= MAX_SCANNED_FILES) {
        shouldStopState.scanLimitReached = true;
        return;
      }

      shouldStopState.scannedFiles += 1;

      if (isSensitiveBaseName(entry.name) || isDatabaseDump(entry.name)) {
        continue;
      }

      let stat;

      try {
        stat = await fsp.stat(entryPath);
      } catch (_error) {
        continue;
      }

      const relativePath = path.relative(root.path, entryPath);
      const searchHaystack = [entry.name, relativePath].join("\n").toLowerCase();
      const queryLower = normalizedQuery.toLowerCase();
      let matched = false;

      if (searchHaystack.includes(queryLower)) {
        matched = true;
        await maybePushFileResult(entryPath, root, stat, "filename", `Matched filename/path: ${relativePath}`);
      }

      if (
        includeContentSearch &&
        !matched &&
        isSafeTextExtension(entryPath) &&
        Number(stat.size || 0) <= MAX_FILE_SEARCH_CONTENT_BYTES
      ) {
        let content = "";

        try {
          content = await fsp.readFile(entryPath, "utf8");
        } catch (_error) {
          content = "";
        }

        if (content && content.toLowerCase().includes(queryLower)) {
          await maybePushFileResult(
            entryPath,
            root,
            stat,
            "content",
            snippetAroundMatch(content, normalizedQuery),
          );
        }
      }
    }
  }

  const priorRootPaths = [];

  for (const root of roots) {
    await walkDirectory(root, root.path, priorRootPaths);
    priorRootPaths.push(root.path);

    if (shouldStopState.limitReached || shouldStopState.scanLimitReached) {
      break;
    }
  }

  return success({
    query: normalizedQuery,
    searchContent: includeContentSearch,
    count: results.length,
    limit: normalizedLimit,
    allowlistedRoots: getAllowlistedRootsMetadata(),
    resultCapReached: shouldStopState.limitReached,
    scanCapReached: shouldStopState.scanLimitReached,
    scannedDirectories: shouldStopState.scannedDirectories,
    scannedFiles: shouldStopState.scannedFiles,
    items: results,
  });
}

async function readFilePreview({ path: requestedPath = "", reportId = "", maxBytes = MAX_FILE_PREVIEW_BYTES } = {}) {
  const normalizedReportId = cleanText(reportId);
  let report = null;
  let resolvedFile;

  if (normalizedReportId) {
    report = getAssistantReport(normalizedReportId);

    if (!report) {
      return failure(404, "report_not_found", `No assistant report is registered for id "${normalizedReportId}".`);
    }

    if (!report.localPath) {
      return failure(
        404,
        "report_file_unavailable",
        `Report "${report.title}" does not have an allowlisted local file path.`,
        {
          items: [
            buildBlockedItem({
              title: report.title,
              reportId: report.id,
              blockedReason: "This report currently has metadata only and no allowlisted local file path.",
              hostContext: report.hostContext,
            }),
          ],
          allowlistedRoots: getAllowlistedRootsMetadata(),
        },
      );
    }

    resolvedFile = await resolveRequestedFilePath(report.localPath, getAllowlistedRoots());
  } else {
    resolvedFile = await resolveRequestedFilePath(requestedPath, getAllowlistedRoots());
  }

  if (!resolvedFile.ok) {
    return {
      ...resolvedFile,
      items: [
        buildBlockedItem({
          title: normalizedReportId ? report?.title || "Blocked report preview" : "Blocked file preview",
          blockedReason: resolvedFile.error,
          hostContext: report?.hostContext || "windows",
          reportId: report?.id || null,
        }),
      ],
      allowlistedRoots: getAllowlistedRootsMetadata(),
    };
  }

  const blockedReason = getBlockedReadReason(resolvedFile.absolutePath);

  if (blockedReason) {
    return blocked(blockedReason.code, blockedReason.message, {
      items: [
        buildBlockedItem({
          title: report?.title || path.basename(resolvedFile.absolutePath),
          path: resolvedFile.absolutePath,
          relativePath: path.relative(resolvedFile.root.path, resolvedFile.absolutePath),
          root: resolvedFile.root,
          hostContext: report?.hostContext || resolvedFile.root.hostContext,
          blockedReason: blockedReason.message,
          reportId: report?.id || null,
        }),
      ],
      allowlistedRoots: getAllowlistedRootsMetadata(),
    });
  }

  if (!isSafeTextExtension(resolvedFile.absolutePath)) {
    return blocked("binary_or_unsupported_preview_blocked", "Binary or unsupported file preview is blocked.", {
      items: [
        buildBlockedItem({
          title: report?.title || path.basename(resolvedFile.absolutePath),
          path: resolvedFile.absolutePath,
          relativePath: path.relative(resolvedFile.root.path, resolvedFile.absolutePath),
          root: resolvedFile.root,
          hostContext: report?.hostContext || resolvedFile.root.hostContext,
          blockedReason: "Binary or unsupported file preview is blocked.",
          reportId: report?.id || null,
        }),
      ],
      allowlistedRoots: getAllowlistedRootsMetadata(),
    });
  }

  const previewBytes = clampNumber(maxBytes, 256, MAX_FILE_PREVIEW_BYTES, MAX_FILE_PREVIEW_BYTES);
  const sampleBuffer = await safeReadBuffer(resolvedFile.absolutePath, Math.min(BINARY_SAMPLE_BYTES, previewBytes));

  if (isProbablyBinary(sampleBuffer)) {
    return blocked("binary_preview_blocked", "Binary file preview is blocked for assistant lookup.", {
      items: [
        buildBlockedItem({
          title: report?.title || path.basename(resolvedFile.absolutePath),
          path: resolvedFile.absolutePath,
          relativePath: path.relative(resolvedFile.root.path, resolvedFile.absolutePath),
          root: resolvedFile.root,
          hostContext: report?.hostContext || resolvedFile.root.hostContext,
          blockedReason: "Binary file preview is blocked for assistant lookup.",
          reportId: report?.id || null,
        }),
      ],
      allowlistedRoots: getAllowlistedRootsMetadata(),
    });
  }

  const previewBuffer = await safeReadBuffer(resolvedFile.absolutePath, previewBytes);
  const content = previewBuffer.toString("utf8");
  const truncated = Number(resolvedFile.stat.size || 0) > previewBuffer.length;

  return success({
    count: 1,
    allowlistedRoots: getAllowlistedRootsMetadata(),
    items: [
      buildPreviewItem({
        absolutePath: resolvedFile.absolutePath,
        root: resolvedFile.root,
        stat: resolvedFile.stat,
        content,
        truncated,
        report,
      }),
    ],
  });
}

async function queryLogs({ service = "", lines = 40, filter = "" } = {}) {
  const normalizedService = cleanText(service);

  if (!normalizedService) {
    return failure(400, "service_required", "service is required");
  }

  const normalizedFilter = cleanText(filter);
  const normalizedLines = clampNumber(lines, 1, MAX_LOG_LINES, 40);
  const response = await serviceOperations.fetchServiceLogs(normalizedService);

  if (!response.ok) {
    const hostContext = cleanText(response.data?.host).toLowerCase() === "fedora" ? "fedora" : "windows";

    return failure(response.status || 500, response.data?.code || "logs_query_failed", response.error || "Log query failed.", {
      items: [
        buildBlockedItem({
          kind: "log-preview",
          title: `${response.data?.displayName || normalizedService} logs`,
          hostContext,
          blockedReason: response.error || "Log query failed.",
          serviceName: normalizedService,
        }),
      ],
      allowlistedRoots: getAllowlistedRootsMetadata(),
    });
  }

  const rawLogs =
    typeof response.data?.preview === "string" && response.data.preview
      ? response.data.preview
      : typeof response.data?.logs === "string"
        ? response.data.logs
        : "";
  const allLines = rawLogs.split(/\r?\n/).filter(Boolean);
  const filteredLines = normalizedFilter
    ? allLines.filter((line) => line.toLowerCase().includes(normalizedFilter.toLowerCase()))
    : allLines;
  const cappedLines = filteredLines.slice(-normalizedLines);

  return success({
    count: 1,
    allowlistedRoots: getAllowlistedRootsMetadata(),
    items: [
      buildLogItem({
        serviceName: response.data?.serviceName || normalizedService,
        displayName: response.data?.displayName || normalizedService,
        host: response.data?.host || "",
        executor: response.executor || response.data?.executor || "",
        processName: response.data?.processName || "",
        manager: response.data?.manager || "",
        filter: normalizedFilter,
        lines: cappedLines,
        matchedLineCount: filteredLines.length,
        totalLineCount: allLines.length,
        truncated: filteredLines.length > cappedLines.length,
        logTarget: response.data?.logTarget || "",
        baseUrl: response.baseUrl || response.data?.baseUrl || "",
      }),
    ],
  });
}

module.exports = {
  MAX_FILE_PREVIEW_BYTES,
  MAX_FILE_SEARCH_RESULTS,
  MAX_LOG_LINES,
  getAllowlistedRootsMetadata,
  getReportDetail,
  listReports,
  queryLogs,
  readFilePreview,
  searchFiles,
};
