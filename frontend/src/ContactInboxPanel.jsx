import { useEffect, useState } from "react";

function formatTimestamp(value) {
  if (!value) return "Time unavailable";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Time unavailable" : date.toLocaleString();
}

export default function ContactInboxPanel() {
  const [items, setItems] = useState([]);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function loadInbox() {
    setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/contact-inbox?limit=50");
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error?.message || "Contact Inbox could not be loaded.");
      }

      const nextItems = Array.isArray(payload.items) ? payload.items : [];
      setItems(nextItems);
      setSelectedId((current) => {
        if (current && nextItems.some((item) => item.id === current)) return current;
        return nextItems[0]?.id || "";
      });
    } catch (loadError) {
      setError(loadError.message || "Contact Inbox could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadInbox();
  }, []);

  const selected = items.find((item) => item.id === selectedId) || null;

  return (
    <section className="workspace-tab-panel workspace-tab-panel--contact-inbox">
      <div className="workspace-tab-heading contact-inbox-heading">
        <div>
          <span className="section-title">AIBRY Website</span>
          <h2>Contact Inbox</h2>
          <p>Read-only contact form submissions. Credentials remain on the Garage Admin backend.</p>
        </div>
        <button type="button" className="secondary-button" onClick={loadInbox} disabled={loading}>
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {error ? <div className="banner error-banner">{error}</div> : null}
      <div className="contact-inbox-layout">
        <section className="panel contact-inbox-list" aria-label="Contact submissions">
          <div className="contact-inbox-list-header">
            <strong>Submissions</strong>
            <span className="count-pill">{items.length}</span>
          </div>
          {loading && !items.length ? <div className="empty-state">Loading contact submissions...</div> : null}
          {!loading && !items.length && !error ? <div className="empty-state">No contact submissions found.</div> : null}
          {items.map((item) => (
            <button
              key={item.id || `${item.email}-${item.createdAt}`}
              type="button"
              className={`contact-inbox-row ${selected === item ? "selected" : ""}`}
              onClick={() => setSelectedId(item.id)}
            >
              <span className="contact-inbox-row-top">
                <strong>{item.name || "Unknown sender"}</strong>
                <time>{formatTimestamp(item.createdAt)}</time>
              </span>
              <span>{item.email || "Email unavailable"}</span>
              <span className="contact-inbox-preview">{item.message || "No message body"}</span>
            </button>
          ))}
        </section>

        <article className="panel contact-inbox-detail">
          {selected ? (
            <>
              <span className="detail-label">Selected submission</span>
              <h3>{selected.name || "Unknown sender"}</h3>
              <a href={`mailto:${selected.email}`}>{selected.email || "Email unavailable"}</a>
              <time className="inline-note">{formatTimestamp(selected.createdAt)}</time>
              <div className="contact-inbox-message">{selected.message || "No message body"}</div>
              <p className="inline-note">Reply, status changes, and deletion are intentionally outside this read-only inbox.</p>
            </>
          ) : (
            <div className="empty-state">Select a submission to inspect it.</div>
          )}
        </article>
      </div>
    </section>
  );
}
