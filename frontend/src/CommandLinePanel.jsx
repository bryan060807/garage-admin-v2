import { useEffect, useState } from "react";

const HISTORY_LIMIT = 8;

function toPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function readText(...values) {
  for (const value of values) {
    if (value == null) {
      continue;
    }

    const text = String(value).trim();
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

export default function CommandLinePanel() {
  const [actions, setActions] = useState([]);
  const [actionsLoading, setActionsLoading] = useState(true);
  const [actionsError, setActionsError] = useState("");
  const [selectedActionId, setSelectedActionId] = useState("");
  const [paramValues, setParamValues] = useState({});
  const [activeResult, setActiveResult] = useState(null);
  const [history, setHistory] = useState([]);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState("");

  useEffect(() => {
    let active = true;

    async function loadActions() {
      setActionsLoading(true);
      setActionsError("");

      try {
        const response = await fetch("/api/command-line/actions");
        const payload = await response.json().catch(() => null);
        const data = toPlainObject(payload);

        if (!response.ok || data.ok === false) {
          throw new Error(readText(data.message, data.error, "Command actions request failed."));
        }

        if (!active) {
          return;
        }

        const items = Array.isArray(data.items) ? data.items : [];
        setActions(items);
        setSelectedActionId((current) => current || items[0]?.id || "");
      } catch (error) {
        if (active) {
          setActionsError(error?.message || "Command actions request failed.");
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

  const selectedAction = actions.find((action) => action.id === selectedActionId) || actions[0] || null;

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

  async function handleRun() {
    if (!selectedAction) {
      return;
    }

    setRunning(true);
    setRunError("");

    try {
      const response = await fetch("/api/command-line/run", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          actionId: selectedAction.id,
          params: paramValues,
        }),
      });
      const payload = await response.json().catch(() => null);
      const data = toPlainObject(payload);

      if (!response.ok || data.ok === false && !data.action) {
        throw new Error(readText(data.message, data.error?.message, "Command execution failed."));
      }

      setActiveResult(data);
      setHistory((current) => [data, ...current.filter((entry) => entry.startedAt !== data.startedAt)].slice(0, HISTORY_LIMIT));
    } catch (error) {
      setRunError(error?.message || "Command execution failed.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="workspace-tab-panel workspace-tab-panel--command-line">
      <div className="workspace-tab-heading">
        <span className="section-title">Command Line</span>
        <h2>Controlled Operations Console</h2>
        <p>
          Launch allowlisted backend-mediated commands only. This MVP stays read-only, keeps bridge credentials
          server-side, and does not expose a raw shell, arbitrary command entry, restarts, or approval bypasses.
        </p>
      </div>

      <div className="workspace-tab-card-grid command-line-card-grid">
        <article className="panel workspace-tab-card">
          <span className="detail-label">MVP scope</span>
          <h3>Allowlisted launch only</h3>
          <p className="inline-note">
            Windows runtime and Fedora control-plane actions stay visibly separate. Unsupported or not-yet-wired
            actions remain disabled.
          </p>
          <div className="inline-badges">
            <span className="status-badge status-risk-safe">Read-only</span>
            <span className="status-badge status-info">backend-only auth</span>
            <span className="status-badge status-unknown">No raw shell</span>
          </div>
        </article>
        <article className="panel workspace-tab-card">
          <span className="detail-label">History</span>
          <h3>{history.length} recent run{history.length === 1 ? "" : "s"}</h3>
          <p className="inline-note">
            Recent command history is kept in frontend session state for this MVP. It resets on reload and does not yet
            become an audit trail.
          </p>
          <div className="inline-badges">
            <span className={`status-badge ${activeResult ? getResultTone(activeResult) : "status-unknown"}`}>
              {activeResult ? activeResult.exitStatus || activeResult.status || "result" : "No result yet"}
            </span>
            <span className="status-badge status-info">
              {activeResult?.action?.host ? `${activeResult.action.host} ${activeResult.action.scope || ""}`.trim() : "Host pending"}
            </span>
          </div>
        </article>
      </div>

      <section className="panel command-line-launcher-card">
        <div className="panel-heading">
          <div>
            <span className="section-title">Launcher</span>
            <h3>Approved Actions</h3>
            <p>Select a pre-registered action, review scope and risk, then run it through the backend allowlist.</p>
          </div>
          <div className="worker-evidence-summary">
            <span className={`status-badge ${selectedAction ? getAvailabilityTone(selectedAction) : "status-unknown"}`}>
              {selectedAction
                ? selectedAction.available
                  ? "ready"
                  : selectedAction.supported
                    ? selectedAction.availability.replace(/_/g, " ")
                    : "not wired"
                : "select action"}
            </span>
            <span className={`status-badge status-risk-${selectedAction?.riskLevel || "unknown"}`}>
              {selectedAction?.riskLabel || "Unknown"}
            </span>
          </div>
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
              <span className="detail-value">{selectedAction.host} / {selectedAction.scope}</span>
            </div>
            <div className="detail-item">
              <span className="detail-label">Route family</span>
              <span className="detail-value">{selectedAction.routeFamily || "n/a"}</span>
            </div>
            <div className="detail-item">
              <span className="detail-label">Availability</span>
              <span className="detail-value">{selectedAction.available ? "Available now" : selectedAction.availabilityMessage || "Unavailable"}</span>
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
            onClick={handleRun}
            disabled={!selectedAction || !selectedAction.available || running}
            title={selectedAction?.available ? selectedAction.description : selectedAction?.availabilityMessage || "Action unavailable."}
          >
            {running ? "Running..." : "Run command"}
          </button>
          {selectedAction && !selectedAction.available ? (
            <span className="inline-note">{selectedAction.availabilityMessage || "This action is unavailable."}</span>
          ) : null}
        </div>

        {runError ? <div className="banner error-banner">Command run failed: {runError}</div> : null}
      </section>

      <section className="command-line-results-grid">
        <article className="panel command-line-result-card">
          <div className="panel-heading">
            <div>
              <span className="section-title">Result viewer</span>
              <h3>{activeResult?.action?.label || "No command result yet"}</h3>
            </div>
            <span className={`status-badge ${activeResult ? getResultTone(activeResult) : "status-unknown"}`}>
              {activeResult ? activeResult.exitStatus || activeResult.status || "result" : "idle"}
            </span>
          </div>

          {activeResult ? (
            <>
              <div className="worker-summary-detail-grid">
                <div className="detail-item">
                  <span className="detail-label">Host / scope</span>
                  <span className="detail-value">{activeResult.action?.host} / {activeResult.action?.scope}</span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">Started</span>
                  <span className="detail-value">{formatCreatedAt(activeResult.startedAt)}</span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">Completed</span>
                  <span className="detail-value">{formatCreatedAt(activeResult.completedAt)}</span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">Duration</span>
                  <span className="detail-value">{formatDuration(activeResult.durationMs)}</span>
                </div>
              </div>

              <p className="worker-evidence-record-copy">{activeResult.summary || "No summary returned."}</p>
              {activeResult.error ? (
                <p className="worker-evidence-record-error">
                  {activeResult.error.code}: {activeResult.error.message}
                </p>
              ) : null}
              {activeResult.stdout ? (
                <>
                  <span className="detail-label">Stdout</span>
                  <pre className="repo-evidence-output">{formatOutput(activeResult.stdout)}</pre>
                </>
              ) : null}
              {activeResult.stderr ? (
                <>
                  <span className="detail-label">Stderr</span>
                  <pre className="repo-evidence-output">{formatOutput(activeResult.stderr)}</pre>
                </>
              ) : null}
              {activeResult.output != null ? (
                <>
                  <span className="detail-label">Structured output</span>
                  <pre className="repo-evidence-output">{formatOutput(activeResult.output)}</pre>
                </>
              ) : null}
            </>
          ) : (
            <div className="empty-state">Run an allowlisted command to load a structured result here.</div>
          )}
        </article>

        <article className="panel command-line-history-card">
          <div className="panel-heading">
            <div>
              <span className="section-title">Recent results</span>
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
        </article>
      </section>
    </section>
  );
}
