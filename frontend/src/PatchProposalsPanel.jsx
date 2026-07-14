import { useEffect, useState } from "react";

function formatTimestamp(value) {
  if (!value) return "Time unavailable";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Time unavailable" : date.toLocaleString();
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return "Size unavailable";
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function describeActionResult(action, payload) {
  if (action === "apply") {
    const touched = Array.isArray(payload?.touchedFiles) ? payload.touchedFiles : [];
    return touched.length
      ? `Applied proposal and updated ${touched.length} file${touched.length === 1 ? "" : "s"}: ${touched.join(", ")}.`
      : "Applied proposal. No touched-file list was returned.";
  }

  return "Neutralized proposal and moved it out of the active proposal queue.";
}

function getProposalWarnings(proposal) {
  return Array.isArray(proposal?.warnings) ? proposal.warnings.filter(Boolean) : [];
}

export default function PatchProposalsPanel() {
  const [items, setItems] = useState([]);
  const [selectedName, setSelectedName] = useState("");
  const [selected, setSelected] = useState(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [actionPending, setActionPending] = useState("");
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [actionError, setActionError] = useState("");
  const [actionMessage, setActionMessage] = useState("");

  async function loadProposals() {
    setLoadingList(true);
    setError("");

    try {
      const response = await fetch("/api/memory/patch-proposals");
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error?.message || payload?.error || "Patch proposals could not be loaded.");
      }

      const nextItems = Array.isArray(payload.items) ? payload.items : [];
      setItems(nextItems);
      setSelectedName((current) => {
        if (current && nextItems.some((item) => item.name === current)) return current;
        return nextItems[0]?.name || "";
      });
    } catch (loadError) {
      setError(loadError.message || "Patch proposals could not be loaded.");
      setItems([]);
      setSelectedName("");
    } finally {
      setLoadingList(false);
    }
  }

  async function loadProposalDetail(name) {
    if (!name) {
      setSelected(null);
      return;
    }

    setLoadingDetail(true);
    setDetailError("");

    try {
      const response = await fetch(`/api/memory/patch-proposals/${encodeURIComponent(name)}`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error?.message || payload?.error || "Patch proposal detail could not be loaded.");
      }

      setSelected(payload.item || null);
    } catch (loadError) {
      setDetailError(loadError.message || "Patch proposal detail could not be loaded.");
      setSelected(null);
    } finally {
      setLoadingDetail(false);
    }
  }

  async function runProposalAction(action) {
    if (!selectedName || actionPending) {
      return;
    }

    const actionLabel = action === "apply" ? "apply" : "neutralize";
    const warnings = getProposalWarnings(selected);
    let confirmationCopy =
      action === "apply"
        ? `Apply memory patch proposal "${selectedName}"? This will mutate active memory files and create worker backups.`
        : `Neutralize memory patch proposal "${selectedName}"? This will move it out of the active proposal queue without applying it.`;

    if (action === "apply" && warnings.length) {
      confirmationCopy += `\n\nReview warning${warnings.length === 1 ? "" : "s"}:\n- ${warnings.join("\n- ")}`;
    }

    if (!window.confirm(confirmationCopy)) {
      return;
    }

    setActionPending(action);
    setActionError("");
    setActionMessage("");

    try {
      const response = await fetch(`/api/memory/patch-proposals/${encodeURIComponent(selectedName)}/${actionLabel}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ confirm: true }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok === false) {
        const errorPayload = payload?.error || {};
        throw new Error(errorPayload.message || payload?.error || `Patch proposal could not be ${actionLabel}ed.`);
      }

      setActionMessage(describeActionResult(action, payload));
      setSelectedName("");
      setSelected(null);
      await loadProposals();
    } catch (actionFailure) {
      setActionError(actionFailure.message || `Patch proposal could not be ${actionLabel}ed.`);
    } finally {
      setActionPending("");
    }
  }

  useEffect(() => {
    loadProposals();
  }, []);

  useEffect(() => {
    loadProposalDetail(selectedName);
  }, [selectedName]);

  const actionDisabled = !selected || loadingDetail || Boolean(actionPending);
  const selectedWarnings = getProposalWarnings(selected);

  return (
    <section className="workspace-tab-panel workspace-tab-panel--patch-proposals">
      <div className="workspace-tab-heading patch-proposals-heading">
        <div>
          <span className="section-title">Garage Admin Memory</span>
          <h2>Patch Proposals</h2>
          <p>Review generated memory patch proposals, then explicitly apply or neutralize one proposal at a time.</p>
        </div>
        <button type="button" className="secondary-button" onClick={loadProposals} disabled={loadingList || Boolean(actionPending)}>
          {loadingList ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {error ? <div className="banner error-banner">{error}</div> : null}
      {actionError ? <div className="banner error-banner">{actionError}</div> : null}
      {actionMessage ? <div className="banner success-banner">{actionMessage}</div> : null}
      <div className="patch-proposals-layout">
        <section className="panel patch-proposals-list" aria-label="Memory patch proposals">
          <div className="patch-proposals-list-header">
            <strong>Proposals</strong>
            <span className="count-pill">{items.length}</span>
          </div>
          {loadingList && !items.length ? <div className="empty-state">Loading patch proposals...</div> : null}
          {!loadingList && !items.length && !error ? <div className="empty-state">No patch proposals found.</div> : null}
          {items.map((item) => (
            <button
              key={item.name}
              type="button"
              className={`patch-proposal-row ${selectedName === item.name ? "selected" : ""}`}
              onClick={() => setSelectedName(item.name)}
              disabled={Boolean(actionPending)}
            >
              <span className="patch-proposal-row-top">
                <strong>{item.topic || item.name}</strong>
                <time>{formatTimestamp(item.modifiedAt)}</time>
              </span>
              <span>{item.name}</span>
              <span className="patch-proposal-preview">
                {item.targetProject || "No resolved project target"} · {formatBytes(item.sizeBytes)}
                {Number(item.warningCount) > 0 ? ` · ${item.warningCount} review warning${item.warningCount === 1 ? "" : "s"}` : ""}
              </span>
            </button>
          ))}
        </section>

        <article className="panel patch-proposal-detail">
          {loadingDetail ? <div className="empty-state">Loading proposal detail...</div> : null}
          {detailError ? <div className="banner error-banner">{detailError}</div> : null}
          {!loadingDetail && !detailError && selected ? (
            <>
              <div className="patch-proposal-detail-heading">
                <div>
                  <span className="detail-label">Selected proposal</span>
                  <h3>{selected.topic || selected.name}</h3>
                </div>
                <div className="patch-proposal-action-row" aria-label="Patch proposal actions">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => runProposalAction("neutralize")}
                    disabled={actionDisabled}
                  >
                    {actionPending === "neutralize" ? "Neutralizing..." : "Neutralize"}
                  </button>
                  <button
                    type="button"
                    className="danger-button"
                    onClick={() => runProposalAction("apply")}
                    disabled={actionDisabled}
                  >
                    {actionPending === "apply" ? "Applying..." : "Apply Patch"}
                  </button>
                </div>
              </div>
              {selectedWarnings.length ? (
                <div className="banner warning-banner patch-proposal-warning-banner">
                  <strong>Review before applying:</strong>
                  <ul>
                    {selectedWarnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <div className="patch-proposal-meta-grid">
                <div>
                  <span className="detail-label">File</span>
                  <strong>{selected.name}</strong>
                </div>
                <div>
                  <span className="detail-label">Generated</span>
                  <strong>{selected.generatedAt || "Unknown"}</strong>
                </div>
                <div>
                  <span className="detail-label">Target project</span>
                  <strong>{selected.targetProject || "Unresolved / review only"}</strong>
                </div>
                <div>
                  <span className="detail-label">Source session</span>
                  <strong>{selected.sourceSession || "Unknown"}</strong>
                </div>
              </div>
              <p className="inline-note">
                Apply uses the Garage memory worker and creates backups before active-memory writes. Neutralize moves the proposal out of the active queue without deleting it.
              </p>
              <pre className="patch-proposal-body">{selected.body || selected.raw || "Proposal body is empty."}</pre>
            </>
          ) : null}
          {!loadingDetail && !detailError && !selected ? <div className="empty-state">Select a proposal to inspect it.</div> : null}
        </article>
      </div>
    </section>
  );
}
