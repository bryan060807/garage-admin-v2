import { useEffect, useRef, useState } from "react";

const HISTORY_LIMIT = 10;
const TRANSCRIPT_LIMIT = 60;
const PM2_HIGH_RESTART_THRESHOLD = 20;
const PM2_WARN_RESTART_THRESHOLD = 5;
const COMMAND_ALIASES = Object.freeze({
  health: "windows.garage-admin.health",
  status: "windows.runtime.service-status",
  bridge: "windows.bridge.health",
  pm2: "windows.runtime.pm2.list",
  repos: "windows.runtime.repo-status",
  memory: "windows.runtime.memory-self-check",
  fedora: "fedora.control-plane.system-pulse",
  containers: "fedora.control-plane.container-inventory",
  listeners: "fedora.observability.listeners",
  systemd: "fedora.observability.systemd-units",
  timers: "fedora.observability.systemd-timers",
  podman: "fedora.observability.podman-inspect",
  backups: "fedora.observability.backup-artifacts",
});
const COMMAND_SHORTCUTS = Object.freeze(Object.keys(COMMAND_ALIASES));
const BUILT_IN_COMMANDS = Object.freeze(["help", "clear", "actions", "ssh fedora"]);
const INFRASTRUCTURE_SHORTCUTS = Object.freeze(["listeners", "systemd", "timers", "podman", "backups"]);

function toPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function textFromValue(value) {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }

  if (value instanceof Error) {
    return value.message || value.name || "";
  }

  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch (_error) {
      return "";
    }
  }

  return String(value);
}

function readText(...values) {
  for (const value of values) {
    if (value == null) {
      continue;
    }

    const text = textFromValue(value).trim();
    if (text) {
      return text;
    }
  }

  return "";
}

function formatCreatedAt(value) {
  if (!value) {
    return "Not recorded";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString();
}

function formatDuration(durationMs) {
  const value = Number(durationMs);
  if (!Number.isFinite(value) || value < 0) {
    return "Unknown";
  }

  if (value < 1000) {
    return `${value} ms`;
  }

  return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)} s`;
}

function formatPm2Duration(seconds) {
  const value = Number(seconds);

  if (!Number.isFinite(value) || value < 0) {
    return "Unknown";
  }

  const total = Math.trunc(value);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainingSeconds = total % 60;

  if (days > 0) {
    return `${days}d ${hours}h`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }

  return `${remainingSeconds}s`;
}

function formatBytes(value) {
  const bytes = Number(value);

  if (!Number.isFinite(bytes) || bytes < 0) {
    return "Unknown";
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KiB", "MiB", "GiB", "TiB"];
  let amount = bytes / 1024;
  let unitIndex = 0;

  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }

  return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatPercent(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return "Unknown";
  }

  return `${number.toFixed(number >= 10 ? 0 : 1)}%`;
}

function formatOutput(value) {
  if (value == null || value === "") {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch (_error) {
    return String(value);
  }
}

function buildCommandCopyText(entry) {
  return getRawDebugText(entry);
}

function getRawDebugText(entry) {
  const stdout = formatOutput(entry?.stdout ?? entry?.result?.stdout ?? null);
  const stderr = formatOutput(entry?.stderr ?? entry?.result?.stderr ?? null);
  const rawText = [stdout, stderr].filter(Boolean).join(stdout && stderr ? "\n" : "");

  if (rawText) {
    return rawText;
  }

  return formatOutput({
    command: entry?.command || "",
    title: entry?.title || "",
    summary: entry?.summary || "",
    status: entry?.status || "",
    exitStatus: entry?.result?.exitStatus || entry?.exitStatus || "",
    output: entry?.output ?? null,
  });
}

function isPm2ListCandidate(value) {
  if (typeof value === "string") {
    return value.includes("│") && /\bpm2\b|\bname\b/i.test(value);
  }

  if (Array.isArray(value)) {
    return value.some((item) => typeof item === "string" && item.includes("│"));
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Boolean(value.statuses || value.processes || Array.isArray(value.items) || value.manager === "pm2" || value.pm2);
}

function parsePm2UptimeSeconds(value) {
  const text = readText(value).toLowerCase();
  const match = text.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/);

  if (!match) {
    return null;
  }

  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) {
    return null;
  }

  const unit = match[2] || "s";
  if (unit === "ms") {
    return Math.round(amount / 1000);
  }

  if (unit === "m") {
    return Math.round(amount * 60);
  }

  if (unit === "h") {
    return Math.round(amount * 3600);
  }

  if (unit === "d") {
    return Math.round(amount * 86400);
  }

  return Math.round(amount);
}

function parsePm2MemoryBytes(value) {
  const text = readText(value).toLowerCase();
  const match = text.match(/^(\d+(?:\.\d+)?)(b|kb|kib|mb|mib|gb|gib)?$/);

  if (!match) {
    return null;
  }

  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) {
    return null;
  }

  const unit = match[2] || "b";
  if (unit === "kb" || unit === "kib") {
    return Math.round(amount * 1024);
  }

  if (unit === "mb" || unit === "mib") {
    return Math.round(amount * 1024 * 1024);
  }

  if (unit === "gb" || unit === "gib") {
    return Math.round(amount * 1024 * 1024 * 1024);
  }

  return Math.round(amount);
}

function parsePm2Percent(value) {
  const number = Number(readText(value).replace(/%$/, ""));
  return Number.isFinite(number) ? number : null;
}

function parsePm2TableRow(line, index) {
  const cells = String(line || "")
    .split("│")
    .slice(1, -1)
    .map((cell) => cell.trim());

  if (cells.length < 9 || !/^\d+$/.test(cells[0])) {
    return null;
  }

  return {
    id: cells[0],
    name: readText(cells[1], `Process ${index + 1}`),
    mode: readText(cells[4], "fork"),
    pid: Number.isFinite(Number(cells[5])) ? Number(cells[5]) : null,
    uptimeSeconds: parsePm2UptimeSeconds(cells[6]),
    restarts: Number.isFinite(Number(cells[7])) ? Number(cells[7]) : null,
    status: readText(cells[8], "unknown"),
    cpu: parsePm2Percent(cells[9]),
    memoryBytes: parsePm2MemoryBytes(cells[10]),
  };
}

function extractPm2RowsFromTableText(value) {
  const lines = Array.isArray(value) ? value : String(value || "").split(/\r?\n/);

  return lines
    .map((line, index) => parsePm2TableRow(line, index))
    .filter(Boolean);
}

function buildPm2Row(rawProcess, snapshot, index, key) {
  const processInfo = toPlainObject(rawProcess);
  const snapshotInfo = toPlainObject(snapshot);
  const pm2Env = toPlainObject(processInfo.pm2_env);
  const monit = toPlainObject(processInfo.monit);
  const restartCount = snapshotInfo.restarts ?? snapshotInfo.restartCount ?? pm2Env.restart_time ?? null;
  const pid = snapshotInfo.pid ?? processInfo.pid ?? null;
  const uptimeSeconds =
    snapshotInfo.uptimeSeconds ??
    (Number.isFinite(Number(pm2Env.pm_uptime)) ? Math.max(0, Math.round((Date.now() - Number(pm2Env.pm_uptime)) / 1000)) : null);
  const mode = readText(
    snapshotInfo.mode,
    snapshotInfo.pm2Mode,
    pm2Env.exec_mode,
    processInfo.exec_mode,
    pm2Env.instances && Number(pm2Env.instances) > 1 ? "cluster" : "",
    "fork",
  );
  const status = readText(snapshotInfo.status, snapshotInfo.pm2Status, pm2Env.status, processInfo.status, "unknown");
  const name = readText(snapshotInfo.name, snapshotInfo.processName, processInfo.name, key, `Process ${index + 1}`);
  const id = readText(snapshotInfo.id, snapshotInfo.pmId, processInfo.pm_id, key, String(index + 1));

  return {
    id,
    name,
    mode,
    pid: Number.isFinite(Number(pid)) ? Number(pid) : null,
    uptimeSeconds: Number.isFinite(Number(uptimeSeconds)) ? Number(uptimeSeconds) : null,
    restarts: Number.isFinite(Number(restartCount)) ? Number(restartCount) : null,
    status,
    cpu: Number.isFinite(Number(snapshotInfo.cpuPercent ?? monit.cpu)) ? Number(snapshotInfo.cpuPercent ?? monit.cpu) : null,
    memoryBytes: Number.isFinite(Number(snapshotInfo.memoryBytes ?? monit.memory)) ? Number(snapshotInfo.memoryBytes ?? monit.memory) : null,
  };
}

function extractPm2RowsFromCandidate(candidate) {
  if (typeof candidate === "string") {
    return extractPm2RowsFromTableText(candidate);
  }

  if (Array.isArray(candidate)) {
    const tableRows = extractPm2RowsFromTableText(candidate);
    if (tableRows.length) {
      return tableRows;
    }

    return candidate.map((item, index) => buildPm2Row(item, null, index, String(index + 1)));
  }

  const value = toPlainObject(candidate);
  const rows = [];

  if (Array.isArray(value.items)) {
    return value.items.map((item, index) => buildPm2Row(item, null, index, String(index + 1)));
  }

  const processes = toPlainObject(value.processes);
  const statuses = toPlainObject(value.statuses);

  Object.entries(statuses).forEach(([key, snapshot], index) => {
    rows.push(buildPm2Row(processes[key] || processes[snapshot?.name] || null, snapshot, index, key));
  });

  if (rows.length > 0) {
    return rows;
  }

  Object.entries(processes).forEach(([key, processInfo], index) => {
    rows.push(buildPm2Row(processInfo, null, index, key));
  });

  return rows;
}

function extractPm2Rows(entry) {
  const candidates = [
    entry?.output?.result?.evidence?.output,
    entry?.output?.result?.evidence?.detectedRows,
    entry?.result?.output?.result?.evidence?.output,
    entry?.result?.output?.result?.evidence?.detectedRows,
    entry?.output?.result,
    entry?.output?.data,
    entry?.output,
    entry?.result?.output,
    entry?.result?.data,
    entry?.result,
    entry,
  ];

  for (const candidate of candidates) {
    if (!isPm2ListCandidate(candidate)) {
      continue;
    }

    const rows = extractPm2RowsFromCandidate(candidate);
    if (rows.length) {
      return rows;
    }
  }

  return [];
}

function getResultPayload(entry) {
  return (
    entry?.output?.result?.result ??
    entry?.output?.result?.output ??
    entry?.output?.result?.data ??
    entry?.output?.result ??
    entry?.result?.output?.result?.result ??
    entry?.result?.output?.result?.output ??
    entry?.result?.output?.result?.data ??
    entry?.result?.output?.result ??
    entry?.output?.data ??
    entry?.output ??
    entry?.result?.data ??
    entry?.result ??
    null
  );
}

function extractArrayByKeys(value, keys) {
  if (Array.isArray(value)) {
    return value;
  }

  const data = toPlainObject(value);
  for (const key of keys) {
    if (Array.isArray(data[key])) {
      return data[key];
    }
  }

  const nestedCandidates = [data.result, data.output, data.data, data.evidence].filter(Boolean);
  for (const candidate of nestedCandidates) {
    const rows = extractArrayByKeys(candidate, keys);
    if (rows.length) {
      return rows;
    }
  }

  return [];
}

function readRowText(row, keys, fallback = "") {
  const data = toPlainObject(row);
  for (const key of keys) {
    const value = data[key];
    if (value != null && value !== "") {
      return String(value);
    }
  }

  return fallback;
}

function readRowNumber(row, keys) {
  const text = readRowText(row, keys);
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function classifyListenerAddress(address) {
  const text = String(address || "").trim().toLowerCase();

  if (!text) {
    return { label: "unknown", tone: "status-unknown" };
  }

  if (
    text === "0.0.0.0" ||
    text === "*" ||
    text === "::" ||
    text === "[::]" ||
    text.includes("0.0.0.0:") ||
    text.includes("[::]:") ||
    text.startsWith(":::")
  ) {
    return { label: "exposed", tone: "status-warning" };
  }

  if (
    text === "127.0.0.1" ||
    text === "localhost" ||
    text === "::1" ||
    text === "[::1]" ||
    text.startsWith("127.") ||
    text.includes("127.0.0.1:") ||
    text.includes("localhost:") ||
    text.includes("[::1]:")
  ) {
    return { label: "local", tone: "status-supported" };
  }

  return { label: "bound", tone: "status-info" };
}

function normalizeListenerRows(entry) {
  return extractArrayByKeys(getResultPayload(entry), ["listeners", "items", "rows", "sockets"]).map((row, index) => {
    const address = readRowText(row, ["localAddress", "address", "addr", "listenAddress", "host", "local"], "");
    const port = readRowText(row, ["localPort", "port", "listenPort"], "");
    const exposure = classifyListenerAddress(address);

    return {
      id: `${address || "listener"}-${port || index}`,
      proto: readRowText(row, ["protocol", "proto", "netid"], "unknown"),
      state: readRowText(row, ["state", "status"], "unknown"),
      address: address || "unknown",
      port: port || "unknown",
      process: readRowText(row, ["process", "processName", "program", "users", "pid"], "unknown"),
      exposure,
    };
  });
}

function normalizeSystemdRows(entry) {
  return extractArrayByKeys(getResultPayload(entry), ["units", "items", "rows"]).map((row, index) => ({
    id: readRowText(row, ["unit", "name", "id"], `unit-${index}`),
    unit: readRowText(row, ["unit", "name", "id"], "unknown"),
    load: readRowText(row, ["load", "loadState"], "unknown"),
    active: readRowText(row, ["active", "activeState"], "unknown"),
    sub: readRowText(row, ["sub", "subState"], "unknown"),
    description: readRowText(row, ["description", "desc"], ""),
  }));
}

function normalizeTimerRows(entry) {
  return extractArrayByKeys(getResultPayload(entry), ["timers", "items", "rows"]).map((row, index) => ({
    id: readRowText(row, ["unit", "timer", "name", "id"], `timer-${index}`),
    timer: readRowText(row, ["unit", "timer", "name", "id"], "unknown"),
    next: readRowText(row, ["next", "nextElapse", "nextRun"], "unknown"),
    left: readRowText(row, ["left", "remaining"], "unknown"),
    last: readRowText(row, ["last", "lastRun", "lastTrigger"], "unknown"),
    service: readRowText(row, ["activates", "service", "trigger"], "unknown"),
  }));
}

function normalizeContainerRows(entry) {
  const payload = getResultPayload(entry);
  const rows = extractArrayByKeys(payload, ["containers", "items", "rows"]);
  const sourceRows = rows.length ? rows : [payload].filter((value) => value && typeof value === "object");

  return sourceRows.map((row, index) => ({
    id: readRowText(row, ["id", "containerId"], `container-${index}`),
    name: readRowText(row, ["name", "containerName", "Names"], "unknown"),
    image: readRowText(row, ["image", "Image", "configImage"], "unknown"),
    state: readRowText(row, ["state", "status", "State"], "unknown"),
    created: readRowText(row, ["created", "Created"], "unknown"),
    ports: readRowText(row, ["ports", "Ports", "portBindings"], "unknown"),
  }));
}

function normalizeBackupRows(entry) {
  return extractArrayByKeys(getResultPayload(entry), ["artifacts", "backups", "items", "rows"]).map((row, index) => ({
    id: readRowText(row, ["name", "file", "filename", "id"], `artifact-${index}`),
    name: readRowText(row, ["name", "file", "filename", "id"], "unknown"),
    kind: readRowText(row, ["kind", "type", "category"], "unknown"),
    size: readRowNumber(row, ["sizeBytes", "bytes", "size"]),
    modified: readRowText(row, ["modified", "mtime", "updatedAt", "createdAt"], "unknown"),
    status: readRowText(row, ["status", "state"], "recorded"),
  }));
}

function getFedoraObservationKind(entry) {
  const actionId = readText(entry?.action?.id, entry?.result?.action?.id);

  if (actionId === "fedora.observability.listeners") return "listeners";
  if (actionId === "fedora.observability.systemd-units") return "systemd";
  if (actionId === "fedora.observability.systemd-timers") return "timers";
  if (actionId === "fedora.observability.podman-inspect") return "podman";
  if (actionId === "fedora.observability.backup-artifacts") return "backups";

  return "";
}

function CommandLineObservationTable({ entry }) {
  const kind = getFedoraObservationKind(entry);
  const tableClassName = "command-line-pm2-table command-line-observation-table";
  const empty = <div className="empty-state">No table rows were reported for this read-only task. Raw debug output remains available.</div>;

  if (kind === "listeners") {
    const rows = normalizeListenerRows(entry);
    if (!rows.length) return empty;

    return (
      <div className="command-line-pm2-block">
        <div className="command-line-pm2-table-wrap">
          <table className={tableClassName}>
            <thead>
              <tr>
                <th>Proto</th>
                <th>State</th>
                <th>Address</th>
                <th>Port</th>
                <th>Exposure</th>
                <th>Process</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.proto}</td>
                  <td>{row.state}</td>
                  <td>{row.address}</td>
                  <td>{row.port}</td>
                  <td><span className={`status-badge ${row.exposure.tone}`}>{row.exposure.label}</span></td>
                  <td>{row.process}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="inline-note">Broad-bound listeners are flagged as exposed; loopback listeners are flagged as local.</p>
      </div>
    );
  }

  if (kind === "systemd") {
    const rows = normalizeSystemdRows(entry);
    if (!rows.length) return empty;

    return (
      <div className="command-line-pm2-block">
        <div className="command-line-pm2-table-wrap">
          <table className={tableClassName}>
            <thead>
              <tr>
                <th>Unit</th>
                <th>Load</th>
                <th>Active</th>
                <th>Sub</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.unit}</td>
                  <td>{row.load}</td>
                  <td>{row.active}</td>
                  <td>{row.sub}</td>
                  <td>{row.description || "n/a"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  if (kind === "timers") {
    const rows = normalizeTimerRows(entry);
    if (!rows.length) return empty;

    return (
      <div className="command-line-pm2-block">
        <div className="command-line-pm2-table-wrap">
          <table className={tableClassName}>
            <thead>
              <tr>
                <th>Timer</th>
                <th>Next</th>
                <th>Left</th>
                <th>Last</th>
                <th>Activates</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.timer}</td>
                  <td>{row.next}</td>
                  <td>{row.left}</td>
                  <td>{row.last}</td>
                  <td>{row.service}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  if (kind === "podman") {
    const rows = normalizeContainerRows(entry);
    if (!rows.length) return empty;

    return (
      <div className="command-line-pm2-block">
        <div className="command-line-pm2-table-wrap">
          <table className={tableClassName}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Image</th>
                <th>State</th>
                <th>Created</th>
                <th>Ports</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.name}</td>
                  <td>{row.image}</td>
                  <td>{row.state}</td>
                  <td>{row.created}</td>
                  <td>{row.ports}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  if (kind === "backups") {
    const rows = normalizeBackupRows(entry);
    if (!rows.length) return empty;

    return (
      <div className="command-line-pm2-block">
        <div className="command-line-pm2-table-wrap">
          <table className={tableClassName}>
            <thead>
              <tr>
                <th>Artifact</th>
                <th>Kind</th>
                <th>Size</th>
                <th>Modified</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.name}</td>
                  <td>{row.kind}</td>
                  <td>{row.size == null ? "Unknown" : formatBytes(row.size)}</td>
                  <td>{row.modified}</td>
                  <td>{row.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return null;
}

function getPm2StatusTone(status) {
  const value = String(status || "").toLowerCase();

  if (value === "online" || value === "running" || value === "launching") {
    return "status-supported";
  }

  if (value === "stopped" || value === "errored" || value === "error" || value === "missing") {
    return "status-failed";
  }

  if (value === "warn" || value === "warning" || value === "degraded") {
    return "status-warning";
  }

  return "status-unknown";
}

function getRestartTone(restarts) {
  const value = Number(restarts);

  if (!Number.isFinite(value)) {
    return "status-unknown";
  }

  if (value >= PM2_HIGH_RESTART_THRESHOLD) {
    return "status-failed";
  }

  if (value >= PM2_WARN_RESTART_THRESHOLD) {
    return "status-warning";
  }

  return "status-supported";
}

function CommandLineResultBody({ entry, compact = false, showRawFallback = true }) {
  const pm2Rows = extractPm2Rows(entry);
  const observationKind = getFedoraObservationKind(entry);
  const rawText = getRawDebugText(entry);

  return (
    <>
      {observationKind ? (
        <CommandLineObservationTable entry={entry} />
      ) : pm2Rows.length ? (
        <div className="command-line-pm2-block">
          <div className="command-line-pm2-table-wrap">
            <table className="command-line-pm2-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Name</th>
                  <th>Mode</th>
                  <th>PID</th>
                  <th>Uptime</th>
                  <th>Restarts</th>
                  <th>Status</th>
                  <th>CPU</th>
                  <th>Memory</th>
                </tr>
              </thead>
              <tbody>
                {pm2Rows.map((row, index) => (
                  <tr key={`${row.id}-${row.name}-${index}`}>
                    <td>{row.id}</td>
                    <td className="command-line-pm2-name">{row.name}</td>
                    <td>{row.mode}</td>
                    <td>{row.pid ?? "Unknown"}</td>
                    <td>{formatPm2Duration(row.uptimeSeconds)}</td>
                    <td>
                      <span className={`status-badge ${getRestartTone(row.restarts)}`}>{row.restarts ?? "Unknown"}</span>
                    </td>
                    <td>
                      <span className={`status-badge ${getPm2StatusTone(row.status)}`}>{row.status}</span>
                    </td>
                    <td>{formatPercent(row.cpu)}</td>
                    <td>{formatBytes(row.memoryBytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="inline-note">
            PM2 output is shown from the structured worker payload. Raw output remains available in the debug details.
          </p>
        </div>
      ) : rawText && showRawFallback ? (
        <pre
          className={`command-line-output-block command-line-output-block-structured ${compact ? "command-line-output-block-compact" : ""}`}
        >
          {rawText}
        </pre>
      ) : null}
    </>
  );
}

function getAvailabilityTone(action) {
  if (!action?.supported) {
    return "status-unknown";
  }

  if (action.available) {
    return "status-supported";
  }

  if (action.availability === "approval_required") {
    return "status-warning";
  }

  return "status-failed";
}

function getResultTone(result) {
  if (!result) {
    return "status-unknown";
  }

  return result.ok ? "status-completed" : "status-failed";
}

function createTranscriptEntry(input = {}) {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: new Date().toISOString(),
    tone: "info",
    status: "info",
    command: "",
    title: "",
    summary: "",
    output: null,
    ...input,
  };
}

function defaultCapabilities() {
  return {
    ok: true,
    modes: {
      ssh: {
        available: false,
        reason:
          "SSH terminal is not configured on this host. Configure a server-side SSH profile; do not paste keys into the browser.",
        profiles: [
          {
            id: "fedora",
            label: "Fedora control-plane",
            available: false,
          },
        ],
      },
    },
    builtIns: ["help", "clear", "actions"],
    shortcuts: [
      "health",
      "status [serviceName]",
      "bridge",
      "pm2",
      "repos",
      "memory",
      "fedora",
      "containers",
      "listeners",
      "systemd",
      "timers",
      "podman [taskmaster-db|pgadmin]",
      "backups",
      "ssh fedora",
    ],
  };
}

function buildHelpText(actions, capabilities) {
  const availableActions = actions.filter((action) => action.available);
  return [
    "Safe built-ins:",
    "  help                  Show this command guide.",
    "  clear                 Clear this terminal transcript.",
    "  actions               List backend allowlisted actions.",
    "",
    "Allowlisted command aliases:",
    "  health                Garage Admin V2 backend health.",
    "  status [serviceName]  Windows service status using an allowlisted service name.",
    "  bridge                Windows bridge health.",
    "  pm2                   Windows PM2 process list through the runtime worker.",
    "  repos                 Windows repo status summary.",
    "  memory                Windows memory self-check summary.",
    "  fedora                Fedora control-plane system pulse.",
    "  containers            Fedora container inventory.",
    "  listeners             Fedora listener inventory.",
    "  systemd               Fedora systemd service inventory.",
    "  timers                Fedora systemd timer inventory.",
    "  podman [name]         Fedora Podman inspect for taskmaster-db or pgadmin.",
    "  backups               Fedora backup artifact inventory.",
    "",
    "SSH:",
    `  ssh fedora            ${capabilities?.modes?.ssh?.reason || defaultCapabilities().modes.ssh.reason}`,
    "",
    `Backend actions available now: ${availableActions.length}`,
  ].join("\n");
}

export default function CommandLinePanel() {
  const [actions, setActions] = useState([]);
  const [capabilities, setCapabilities] = useState(defaultCapabilities);
  const [actionsLoading, setActionsLoading] = useState(true);
  const [actionsError, setActionsError] = useState("");
  const [selectedActionId, setSelectedActionId] = useState("");
  const [paramValues, setParamValues] = useState({});
  const [commandInput, setCommandInput] = useState("help");
  const [activeResult, setActiveResult] = useState(null);
  const [history, setHistory] = useState([]);
  const [commandHistory, setCommandHistory] = useState([]);
  const [historyCursor, setHistoryCursor] = useState(null);
  const [transcript, setTranscript] = useState(() => [
    createTranscriptEntry({
      tone: "system",
      status: "ready",
      title: "Garage Admin terminal ready",
      summary:
        "Type help for safe commands. This terminal launches backend-allowlisted actions only; it does not expose a raw shell.",
    }),
  ]);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState("");
  const terminalEndRef = useRef(null);

  useEffect(() => {
    let active = true;

    async function loadActions() {
      setActionsLoading(true);
      setActionsError("");

      try {
        const [actionsResponse, capabilitiesResponse] = await Promise.all([
          fetch("/api/command-line/actions"),
          fetch("/api/command-line/capabilities"),
        ]);
        const actionsPayload = await actionsResponse.json().catch(() => null);
        const capabilitiesPayload = await capabilitiesResponse.json().catch(() => null);
        const actionsData = toPlainObject(actionsPayload);
        const capabilitiesData = toPlainObject(capabilitiesPayload);

        if (!actionsResponse.ok || actionsData.ok === false) {
          throw new Error(readText(actionsData.message, actionsData.error, "Command actions request failed."));
        }

        if (!active) {
          return;
        }

        const items = Array.isArray(actionsData.items) ? actionsData.items : [];
        setActions(items);
        setCapabilities(capabilitiesResponse.ok && capabilitiesData.ok !== false ? capabilitiesData : defaultCapabilities());
        setSelectedActionId((current) => current || items[0]?.id || "");
      } catch (error) {
        if (active) {
          setActionsError(error?.message || "Command actions request failed.");
          setCapabilities(defaultCapabilities());
        }
      } finally {
        if (active) {
          setActionsLoading(false);
        }
      }
    }

    loadActions();

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ block: "end" });
  }, [transcript]);

  const selectedAction = actions.find((action) => action.id === selectedActionId) || actions[0] || null;
  const sshCapability = capabilities?.modes?.ssh || defaultCapabilities().modes.ssh;

  const commandSuggestions = [...BUILT_IN_COMMANDS, ...COMMAND_SHORTCUTS].map((shortcut) => {
    const action = actions.find((item) => item.id === COMMAND_ALIASES[shortcut]);
    const builtInDescriptions = {
      help: "Show the safe command guide.",
      clear: "Clear the current terminal transcript.",
      actions: "List the backend allowlisted actions.",
      "ssh fedora": sshCapability.reason || "Configured named SSH profile only.",
    };

    return {
      label: shortcut,
      command: shortcut,
      actionLabel: action?.label || shortcut,
      description:
        action?.description ||
        builtInDescriptions[shortcut] ||
        (shortcut === "status [serviceName]" ? "Query an allowlisted Windows service." : "Open the related action."),
      available: shortcut === "ssh fedora" ? sshCapability.available === true : action?.available !== false,
    };
  });
  const infrastructureSuggestions = commandSuggestions.filter((item) => INFRASTRUCTURE_SHORTCUTS.includes(item.command));

  function appendTranscript(entry) {
    setTranscript((current) => [...current, createTranscriptEntry(entry)].slice(-TRANSCRIPT_LIMIT));
  }

  function updateTranscriptEntry(entryId, patch) {
    setTranscript((current) =>
      current.map((entry) => (entry.id === entryId ? createTranscriptEntry({ ...entry, ...patch, id: entry.id, createdAt: entry.createdAt }) : entry)),
    );
  }

  async function copyText(text) {
    const value = String(text || "").trim();

    if (!value) {
      return;
    }

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      }
    } catch (_error) {
      // Copy is a convenience. The raw text remains visible.
    }
  }

  function resolveCommand(input) {
    const rawInput = String(input || "").trim();
    const [commandToken = "", ...args] = rawInput.split(/\s+/).filter(Boolean);
    const normalized = commandToken.toLowerCase();

    if (!rawInput) {
      return {
        ok: false,
        error: "Empty command. Type help for available safe commands.",
      };
    }

    if (normalized === "help") {
      return { ok: true, kind: "help" };
    }

    if (normalized === "clear") {
      return { ok: true, kind: "clear" };
    }

    if (normalized === "actions") {
      return { ok: true, kind: "actions" };
    }

    if (normalized === "ssh") {
      const profile = String(args[0] || "").toLowerCase();
      if (profile !== "fedora" || args.length > 1) {
        return {
          ok: false,
          error: "Only the named command ssh fedora is recognized. Browser-supplied SSH hosts/users are not accepted.",
        };
      }

      return { ok: true, kind: "ssh", profile };
    }

    const actionId =
      COMMAND_ALIASES[normalized] || actions.find((action) => action.id.toLowerCase() === rawInput.toLowerCase())?.id || "";

    if (!actionId) {
      return {
        ok: false,
        error: `Unknown command: ${rawInput}. Nothing was sent to the backend. Type help for safe commands.`,
      };
    }

    const action = actions.find((item) => item.id === actionId);
    if (!action) {
      return {
        ok: false,
        error: `Unknown action id: ${actionId}. Nothing was sent to the backend.`,
      };
    }

    const params = {};
    if (action.id === "windows.runtime.service-status" && args[0]) {
      const serviceName = args[0];
      const serviceParam = (action.params || []).find((param) => param.id === "serviceName");
      const allowedOption = (serviceParam?.options || []).find((option) => option.value === serviceName);

      if (!allowedOption) {
        return {
          ok: false,
          error: `Unsupported service for status: ${serviceName}. Pick an allowlisted service from the inspector.`,
        };
      }

      params.serviceName = serviceName;
    } else if (action.id === "fedora.observability.podman-inspect" && args[0]) {
      const containerName = args[0];
      const containerParam = (action.params || []).find((param) => param.id === "containerName");
      const allowedOption = (containerParam?.options || []).find((option) => option.value === containerName);

      if (!allowedOption) {
        return {
          ok: false,
          error: `Unsupported container for podman inspect: ${containerName}. Pick taskmaster-db or pgadmin.`,
        };
      }

      params.containerName = containerName;
    } else if (args.length) {
      return {
        ok: false,
        error: `${commandToken} does not accept free-form arguments in this MVP. Nothing was sent to the backend.`,
      };
    }

    return { ok: true, kind: "action", actionId, params };
  }

  useEffect(() => {
    if (!selectedAction) {
      setParamValues({});
      return;
    }

    setParamValues((current) => {
      const next = {};
      (selectedAction.params || []).forEach((param) => {
        const currentValue = current[param.id];
        if (currentValue != null && currentValue !== "") {
          next[param.id] = currentValue;
          return;
        }

        next[param.id] = param.defaultValue ?? param.options?.[0]?.value ?? "";
      });
      return next;
    });
  }, [selectedActionId, selectedAction]);

  function runLocalCommand(commandText, resolved) {
    setRunError("");

    if (resolved.kind === "help") {
      appendTranscript({
        command: commandText,
        tone: "system",
        status: "ok",
        title: "Help",
        summary: "Available safe commands.",
        output: buildHelpText(actions, capabilities),
      });
      return;
    }

    if (resolved.kind === "clear") {
      setTranscript([
        createTranscriptEntry({
          command: commandText,
          tone: "system",
          status: "ok",
          title: "Transcript cleared",
          summary: "Command history is still available in this session.",
        }),
      ]);
      setActiveResult(null);
      return;
    }

    if (resolved.kind === "actions") {
      appendTranscript({
        command: commandText,
        tone: "system",
        status: "ok",
        title: "Allowlisted actions",
        summary: "Backend actions currently advertised by /api/command-line/actions.",
        output: actions.map((action) => `${action.available ? "ready" : "blocked"}  ${action.id}  ${action.label}`).join("\n"),
      });
      return;
    }

    if (resolved.kind === "ssh") {
      appendTranscript({
        command: commandText,
        tone: "warning",
        status: "unsupported",
        title: "SSH terminal unavailable",
        summary:
          sshCapability.reason ||
          "SSH terminal is not configured on this host. Configure a server-side SSH profile; do not paste keys into the browser.",
      });
    }
  }

  async function executeAction(actionIdOverride = "", paramOverrides = {}, commandText = "") {
    const actionId = actionIdOverride || selectedAction?.id;
    const action = actions.find((item) => item.id === actionId) || selectedAction;
    const displayCommand = commandText || action?.id || "run";

    if (!action) {
      return;
    }

    if (!action.available) {
      const message = action.availabilityMessage || "That command is unavailable.";
      setRunError(message);
      appendTranscript({
        command: displayCommand,
        tone: "error",
        status: "blocked",
        title: action.label || action.id,
        summary: message,
      });
      return;
    }

    const runParams = {};
    (action.params || []).forEach((param) => {
      runParams[param.id] =
        paramOverrides[param.id] ?? paramValues[param.id] ?? param.defaultValue ?? param.options?.[0]?.value ?? "";
    });

    setSelectedActionId(action.id);
    if (Object.keys(paramOverrides).length) {
      setParamValues((current) => ({
        ...current,
        ...paramOverrides,
      }));
    }
    setRunning(true);
    setRunError("");
    const pendingEntryId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    appendTranscript({
      id: pendingEntryId,
      command: displayCommand,
      tone: "pending",
      status: "running",
      title: action.label,
      summary: "Running through backend allowlist...",
    });

    try {
      const response = await fetch("/api/command-line/run", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          actionId: action.id,
          params: runParams,
        }),
      });
      const payload = await response.json().catch(() => null);
      const data = toPlainObject(payload);

      if (!response.ok || (data.ok === false && !data.action)) {
        throw new Error(readText(data.message, data.error?.message, "Command execution failed."));
      }

      const resultData = {
        ...data,
        command: displayCommand,
      };

      setActiveResult(resultData);
      setHistory((current) => [resultData, ...current.filter((entry) => entry.startedAt !== resultData.startedAt)].slice(0, HISTORY_LIMIT));
      updateTranscriptEntry(pendingEntryId, {
        command: displayCommand,
        tone: data.ok ? "success" : "error",
        status: data.exitStatus || data.status || (data.ok ? "ok" : "failed"),
        title: data.action?.label || action.label,
        summary: data.summary || "No summary returned.",
        output: data.output ?? data.stdout ?? data.stderr ?? null,
        result: resultData,
      });
    } catch (error) {
      const message = error?.message || "Command execution failed.";
      setRunError(message);
      updateTranscriptEntry(pendingEntryId, {
        command: displayCommand,
        tone: "error",
        status: "failed",
        title: action.label || action.id,
        summary: message,
      });
    } finally {
      setRunning(false);
    }
  }

  function runResolvedCommand(commandText, resolved) {
    if (resolved.kind === "action") {
      executeAction(resolved.actionId, resolved.params, commandText);
      return;
    }

    runLocalCommand(commandText, resolved);
  }

  function handlePromptSubmit(event) {
    event.preventDefault();
    const commandText = commandInput.trim();
    const resolved = resolveCommand(commandText);

    if (commandText) {
      setCommandHistory((current) => [...current.filter((entry) => entry !== commandText), commandText].slice(-HISTORY_LIMIT));
      setHistoryCursor(null);
    }

    if (!resolved.ok) {
      setRunError(resolved.error);
      appendTranscript({
        command: commandText,
        tone: "error",
        status: "blocked",
        title: "Command rejected",
        summary: resolved.error,
      });
      return;
    }

    runResolvedCommand(commandText, resolved);
  }

  function handlePromptKeyDown(event) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
      return;
    }

    if (!commandHistory.length) {
      return;
    }

    event.preventDefault();
    if (event.key === "ArrowUp") {
      const nextCursor = historyCursor == null ? commandHistory.length - 1 : Math.max(0, historyCursor - 1);
      setHistoryCursor(nextCursor);
      setCommandInput(commandHistory[nextCursor] || "");
      return;
    }

    const nextCursor = historyCursor == null ? commandHistory.length : Math.min(commandHistory.length, historyCursor + 1);
    setHistoryCursor(nextCursor >= commandHistory.length ? null : nextCursor);
    setCommandInput(nextCursor >= commandHistory.length ? "" : commandHistory[nextCursor] || "");
  }

  function handleInspectorRun() {
    executeAction(selectedAction?.id || "", {}, selectedAction?.id || "selected action");
  }

  const activeResultLabel = activeResult?.action?.label || activeResult?.action?.id || "No recent result selected";
  const activeResultSummary =
    activeResult?.summary || "Run an allowlisted command to populate the recent result preview.";
  const activeResultTone = getResultTone(activeResult);

  return (
    <section className="workspace-tab-panel workspace-tab-panel--command-line">
      <div className="workspace-tab-heading command-line-heading">
        <div>
          <span className="section-title">Command Line</span>
          <h2>Controlled Operator Terminal</h2>
          <p>
            Backend-allowlisted commands only. Windows runtime actions and Fedora control-plane evidence stay visibly
            separate. No raw shell, arbitrary host input, browser secrets, restarts, or approval bypasses.
          </p>
        </div>
        <div className="inline-badges command-line-heading-badges">
          <span className="status-badge status-risk-safe">Read-only actions</span>
          <span className="status-badge status-info">backend auth only</span>
          <span className="status-badge status-unknown">SSH gated</span>
        </div>
      </div>

      <section className="command-line-workbench">
        <article className="panel command-line-terminal-card">
          <div className="command-line-terminal-header">
            <div>
              <span className="detail-label">Terminal</span>
              <h3>GA operator session</h3>
            </div>
            <div className="inline-badges">
              <span className={`status-badge ${running ? "status-warning" : "status-supported"}`}>
                {running ? "running" : "ready"}
              </span>
              <span className="status-badge status-info">Windows runtime / Fedora evidence</span>
            </div>
          </div>

          <div className="command-line-output-pane" aria-live="polite">
            {transcript.map((entry) => (
              <article key={entry.id} className={`command-line-output-entry command-line-output-entry-${entry.tone}`}>
                <div className="command-line-output-header">
                  <div className="command-line-output-meta">
                    <span className="command-line-output-time">{formatCreatedAt(entry.createdAt)}</span>
                    <span className={`status-badge ${entry.tone === "error" ? "status-failed" : entry.tone === "warning" ? "status-warning" : "status-info"}`}>
                      {entry.status}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="secondary-button command-line-copy-button"
                    onClick={() => copyText(buildCommandCopyText(entry))}
                  >
                    Copy raw
                  </button>
                </div>
                {entry.command ? (
                  <div className="command-line-echo">
                    <span>GA&gt;</span>
                    <strong>{entry.command}</strong>
                  </div>
                ) : null}
                <div className="command-line-output-title">{entry.title}</div>
                {entry.summary ? <p>{entry.summary}</p> : null}
                <CommandLineResultBody entry={entry} />
                {entry.result ? (
                  <div className="command-line-result-strip">
                    <span>Exit: {entry.result.exitStatus || entry.result.status || "unknown"}</span>
                    <span>Duration: {formatDuration(entry.result.durationMs)}</span>
                    <span>Host: {entry.result.action?.host || "unknown"}</span>
                  </div>
                ) : null}
              </article>
            ))}
            <div ref={terminalEndRef} />
          </div>

          <form className="command-line-prompt" onSubmit={handlePromptSubmit}>
            <span className="command-line-prompt-prefix">GA&gt;</span>
            <input
              className="command-line-prompt-input"
              value={commandInput}
              onChange={(event) => setCommandInput(event.target.value)}
              onKeyDown={handlePromptKeyDown}
              placeholder="Type help, health, status garage-admin-v2, ssh fedora, or an exact action id"
              spellCheck="false"
              autoComplete="off"
            />
            <button type="submit" className="secondary-button" disabled={running || actionsLoading || !actions.length}>
              {running ? "Running..." : "Run"}
            </button>
          </form>
          {runError ? <div className="banner error-banner command-line-error">Command rejected: {runError}</div> : null}
        </article>

        <aside className="command-line-sidecar">
          <section className="panel command-line-help-card command-line-infra-card">
            <div className="panel-heading">
              <div>
                <span className="detail-label">Infrastructure</span>
                <h3>Exposure inventory</h3>
              </div>
              <span className="count-pill">{infrastructureSuggestions.length}</span>
            </div>
            <div className="command-line-suggestions command-line-shortcuts-grid" aria-label="Infrastructure shortcuts">
              {infrastructureSuggestions.map((item) => (
                <button
                  key={`infra-${item.command}`}
                  type="button"
                  className={`command-line-suggestion ${item.available ? "" : "command-line-suggestion-disabled"}`}
                  onClick={() => {
                    setCommandInput(item.command);
                    if (COMMAND_ALIASES[item.command]) {
                      setSelectedActionId(COMMAND_ALIASES[item.command]);
                    }
                  }}
                  title={item.actionLabel}
                >
                  <span className="command-line-suggestion-label">{item.label}</span>
                  <span className="command-line-suggestion-description">{item.description}</span>
                </button>
              ))}
            </div>
            <p className="inline-note">Fedora control-plane evidence only. No restart, write, or arbitrary task controls are exposed here.</p>
          </section>

          <section className="panel command-line-help-card">
            <div className="panel-heading">
              <div>
                <span className="detail-label">Shortcuts</span>
                <h3>Safe commands</h3>
              </div>
              <span className="count-pill">{commandSuggestions.length}</span>
            </div>
            <div className="command-line-suggestions command-line-shortcuts-grid" aria-label="Command shortcuts">
              {commandSuggestions.map((item) => (
                <button
                  key={item.command}
                  type="button"
                  className={`command-line-suggestion ${item.available ? "" : "command-line-suggestion-disabled"}`}
                  onClick={() => {
                    setCommandInput(item.command);
                    if (COMMAND_ALIASES[item.command]) {
                      setSelectedActionId(COMMAND_ALIASES[item.command]);
                    }
                  }}
                  title={item.actionLabel}
                >
                  <span className="command-line-suggestion-label">{item.label}</span>
                  <span className="command-line-suggestion-description">{item.description}</span>
                </button>
              ))}
            </div>
            <p className="inline-note">
              `ssh fedora` is intentionally disabled until a named server-side SSH profile is configured. Never paste keys
              or tokens into this terminal.
            </p>
          </section>

          <section className="panel command-line-inspector-card">
            <div className="panel-heading">
              <div>
                <span className="detail-label">Inspector</span>
                <h3>Action details</h3>
              </div>
              <span className={`status-badge ${selectedAction ? getAvailabilityTone(selectedAction) : "status-unknown"}`}>
                {selectedAction
                  ? selectedAction.available
                    ? "ready"
                    : selectedAction.supported
                      ? selectedAction.availability.replace(/_/g, " ")
                      : "not wired"
                  : "select action"}
              </span>
            </div>

            {actionsError ? <div className="banner error-banner">Command actions failed to load: {actionsError}</div> : null}

            <div className="command-line-form-grid">
              <label className="worker-evidence-select-label">
                <span className="detail-label">Action</span>
                <select
                  className="worker-evidence-select"
                  value={selectedActionId}
                  onChange={(event) => setSelectedActionId(event.target.value)}
                  disabled={actionsLoading || !actions.length}
                >
                  {actions.map((action) => (
                    <option key={action.id} value={action.id}>
                      {action.label}
                    </option>
                  ))}
                </select>
              </label>

              {selectedAction?.params?.map((param) => (
                <label key={param.id} className="worker-evidence-select-label">
                  <span className="detail-label">{param.label}</span>
                  {param.type === "select" ? (
                    <select
                      className="worker-evidence-select"
                      value={paramValues[param.id] ?? ""}
                      onChange={(event) =>
                        setParamValues((current) => ({
                          ...current,
                          [param.id]: event.target.value,
                        }))
                      }
                      disabled={!selectedAction.available || running}
                    >
                      {(param.options || []).map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  {param.description ? <span className="inline-note">{param.description}</span> : null}
                </label>
              ))}
            </div>

            {selectedAction ? (
              <div className="command-line-action-meta">
                <div className="detail-item">
                  <span className="detail-label">Host / scope</span>
                  <span className="detail-value">
                    {selectedAction.host} / {selectedAction.scope}
                  </span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">Route family</span>
                  <span className="detail-value">{selectedAction.routeFamily || "n/a"}</span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">Risk</span>
                  <span className="detail-value">{selectedAction.riskLabel || "Unknown"}</span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">Description</span>
                  <span className="detail-value">{selectedAction.description}</span>
                </div>
              </div>
            ) : null}

            <div className="panel-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={handleInspectorRun}
                disabled={!selectedAction || !selectedAction.available || running}
                title={selectedAction?.available ? selectedAction.description : selectedAction?.availabilityMessage || "Action unavailable."}
              >
                {running ? "Running..." : "Run selected action"}
              </button>
              {selectedAction && !selectedAction.available ? (
                <span className="inline-note">{selectedAction.availabilityMessage || "This action is unavailable."}</span>
              ) : null}
            </div>
          </section>

          <section className="panel command-line-result-card">
            <div className="panel-heading">
              <div>
                <span className="detail-label">Recent results</span>
                <h3>{activeResultLabel}</h3>
              </div>
              <div className="command-line-result-actions">
                <span className={`status-badge ${activeResultTone}`}>{activeResult?.exitStatus || activeResult?.status || "idle"}</span>
                <button
                  type="button"
                  className="secondary-button command-line-copy-button"
                  onClick={() => copyText(buildCommandCopyText(activeResult))}
                  disabled={!activeResult}
                >
                  Copy raw
                </button>
              </div>
            </div>

            {activeResult ? (
              <div className="command-line-result-card-body">
                <div className="command-line-result-summary-row">
                  <span className="detail-label">Command</span>
                  <span className="detail-value">{activeResult.command || "Unknown command"}</span>
                </div>
                <p className="inline-note">{activeResultSummary}</p>
                <div className="command-line-result-strip">
                  <span>Exit: {activeResult.exitStatus || activeResult.status || "unknown"}</span>
                  <span>Duration: {formatDuration(activeResult.durationMs)}</span>
                  <span>Host: {activeResult.action?.host || "unknown"}</span>
                </div>
                <CommandLineResultBody entry={activeResult} compact showRawFallback={false} />
                <details className="command-line-result-details">
                  <summary>Raw debug output</summary>
                  <div className="command-line-result-details-body">
                    <pre className="command-line-output-block command-line-output-block-raw">{getRawDebugText(activeResult)}</pre>
                  </div>
                </details>
              </div>
            ) : (
              <div className="empty-state">Run a command to populate the recent result preview.</div>
            )}
          </section>

          <section className="panel command-line-history-card">
            <div className="panel-heading">
              <div>
                <span className="detail-label">Session history</span>
                <h3>Session history</h3>
              </div>
              <span className="count-pill">{history.length}</span>
            </div>

            <div className="command-line-history-list">
              {!history.length ? <div className="empty-state">No command runs recorded in this session.</div> : null}
              {history.map((entry, index) => (
                <button
                  key={`${entry.action?.id || "action"}-${entry.startedAt || index}`}
                  type="button"
                  className={`list-item interactive-item ${activeResult?.startedAt === entry.startedAt ? "selected" : ""}`}
                  onClick={() => setActiveResult(entry)}
                >
                  <span className="service-row">
                    <strong title={entry.action?.label}>{entry.action?.label || entry.action?.id || "Command result"}</strong>
                    <span className={`status-badge ${getResultTone(entry)}`}>{entry.exitStatus || entry.status || "result"}</span>
                  </span>
                  <span className="service-meta">{entry.action?.host} / {entry.action?.scope}</span>
                  <span className="service-hint">{formatCreatedAt(entry.startedAt)}</span>
                </button>
              ))}
            </div>
          </section>
        </aside>
      </section>
    </section>
  );
}
