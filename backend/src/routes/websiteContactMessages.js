const express = require("express");
const config = require("../config");

const router = express.Router();

function jsonError(res, status, code, message) {
  res.status(status).json({ ok: false, code, error: message, message });
}

function safeMessage(error, fallback) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function upstreamErrorCode(payload) {
  if (typeof payload?.code === "string" && payload.code) return payload.code;
  if (payload?.error && typeof payload.error === "object") {
    if (typeof payload.error.code === "string" && payload.error.code) {
      return payload.error.code;
    }
  }
  return "website_api_request_failed";
}

function upstreamErrorMessage(payload) {
  if (typeof payload?.message === "string" && payload.message) return payload.message;
  if (typeof payload?.error === "string" && payload.error) return payload.error;
  if (payload?.error && typeof payload.error === "object") {
    if (typeof payload.error.message === "string" && payload.error.message) {
      return payload.error.message;
    }
    if (typeof payload.error.code === "string" && payload.error.code) {
      return payload.error.code;
    }
  }
  return "Website API request failed.";
}

async function websiteApiFetch(path, options = {}) {
  if (!config.websiteApiInternalToken) {
    const error = new Error("Website API internal admin token is not configured.");
    error.status = 503;
    error.code = "website_api_internal_token_missing";
    throw error;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.websiteApiTimeoutMs);
  const headers = new Headers(options.headers || {});
  headers.set("x-aibry-internal-token", config.websiteApiInternalToken);

  if (options.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  try {
    const response = await fetch(`${config.websiteApiBaseUrl}${path}`, {
      ...options,
      headers,
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { message: text };
      }
    }

    if (!response.ok) {
      const error = new Error(upstreamErrorMessage(payload));
      error.status = response.status;
      error.code = upstreamErrorCode(payload);
      throw error;
    }

    return payload || {};
  } finally {
    clearTimeout(timeout);
  }
}

router.get("/", async (_req, res) => {
  try {
    const payload = await websiteApiFetch("/api/contact-messages/admin");
    res.json({ ok: true, messages: Array.isArray(payload.messages) ? payload.messages : [] });
  } catch (error) {
    jsonError(
      res,
      error.status || 502,
      error.code || "website_contact_messages_failed",
      safeMessage(error, "Unable to load contact messages.")
    );
  }
});

router.patch("/:messageId", async (req, res) => {
  try {
    const payload = await websiteApiFetch(
      `/api/contact-messages/admin/${encodeURIComponent(req.params.messageId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(req.body || {}),
      }
    );
    res.json({ ok: true, message: payload.message || null });
  } catch (error) {
    jsonError(
      res,
      error.status || 502,
      error.code || "website_contact_message_update_failed",
      safeMessage(error, "Unable to update contact message.")
    );
  }
});

function renderContactInboxPage(_req, res) {
  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Contact Inbox | Garage Admin</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #05070a; color: #e5edf0; }
    main { max-width: 1120px; margin: 0 auto; padding: 32px 20px 56px; }
    a { color: #8adae8; }
    header { display: flex; gap: 16px; align-items: flex-end; justify-content: space-between; margin-bottom: 24px; }
    h1 { margin: 8px 0; font-size: clamp(32px, 5vw, 56px); line-height: 1; }
    p { color: #94a3b8; }
    .label { color: #8adae8; text-transform: uppercase; letter-spacing: .28em; font-size: 12px; font-weight: 800; }
    .toolbar { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
    button, .button { border: 1px solid #24323d; background: #101820; color: #e5edf0; border-radius: 999px; padding: 10px 14px; font-weight: 700; cursor: pointer; text-decoration: none; font-size: 13px; }
    button:hover, .button:hover { border-color: #8adae8; background: #14232d; }
    button:disabled { opacity: .5; cursor: not-allowed; }
    .grid { display: grid; gap: 14px; }
    .card { border: 1px solid #1d2a33; background: #0b0f14; border-radius: 18px; padding: 18px; }
    .cardHeader { display: flex; gap: 12px; align-items: start; justify-content: space-between; }
    .subject { margin: 4px 0 0; color: #fff; font-size: 20px; font-weight: 800; }
    .meta { display: flex; flex-wrap: wrap; gap: 8px 14px; color: #94a3b8; font-size: 13px; }
    .message { white-space: pre-wrap; line-height: 1.65; color: #d6e2e7; margin-top: 14px; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
    .badge { display: inline-flex; border: 1px solid #24323d; border-radius: 999px; padding: 5px 9px; font-size: 12px; color: #c8d4d9; background: #101820; }
    .badge.new { border-color: #8adae866; color: #b6edf5; background: #8adae814; }
    .badge.handled, .badge.replied { border-color: #34d39955; color: #bbf7d0; background: #34d39914; }
    .badge.archived { border-color: #64748b66; color: #cbd5e1; }
    .error { border-color: #ef444466; color: #fecaca; background: #450a0a55; }
    textarea { width: 100%; min-height: 70px; box-sizing: border-box; margin-top: 12px; border-radius: 12px; border: 1px solid #24323d; background: #05070a; color: #e5edf0; padding: 10px; }
    @media (max-width: 720px) { header, .cardHeader { display: block; } .toolbar { margin-top: 14px; } }
  </style>
</head>
<body>
  <main>
    <a href="/">← Garage Admin</a>
    <header>
      <div>
        <div class="label">AIBRY Website</div>
        <h1>Contact Inbox</h1>
        <p>View contact form submissions, track replies, and open email responses.</p>
      </div>
      <div class="toolbar">
        <button id="refresh">Refresh</button>
      </div>
    </header>
    <section id="status" class="card">Loading contact messages…</section>
    <section id="messages" class="grid" style="margin-top: 14px;"></section>
  </main>
  <script>
    const statusEl = document.getElementById('status');
    const messagesEl = document.getElementById('messages');
    const refreshBtn = document.getElementById('refresh');

    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    }

    function subjectFor(message) {
      return message.subject || 'Website contact message';
    }

    function mailtoFor(message) {
      const subject = 'Re: ' + subjectFor(message);
      const body = '\n\n--- Original message ---\n' + (message.message || '');
      return 'mailto:' + encodeURIComponent(message.email || '') + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
    }

    function badge(message) {
      const status = message.status || 'new';
      return '<span class="badge ' + escapeHtml(status) + '">' + escapeHtml(status) + '</span>';
    }

    function render(messages) {
      statusEl.textContent = messages.length ? messages.length + ' messages loaded.' : 'No contact messages yet.';
      statusEl.className = 'card';
      messagesEl.innerHTML = messages.map((message) => {
        const created = message.createdAt ? new Date(message.createdAt).toLocaleString() : 'Unknown date';
        const note = message.operatorNote ? '<p><strong>Operator note:</strong> ' + escapeHtml(message.operatorNote) + '</p>' : '';
        return '<article class="card" data-id="' + escapeHtml(message.id) + '">' +
          '<div class="cardHeader"><div>' + badge(message) + '<h2 class="subject">' + escapeHtml(subjectFor(message)) + '</h2>' +
          '<div class="meta"><span>' + escapeHtml(message.name || 'Unknown') + '</span><span>' + escapeHtml(message.email || '') + '</span><span>' + escapeHtml(created) + '</span></div></div>' +
          '<a class="button" href="' + mailtoFor(message) + '">Reply by email</a></div>' +
          '<div class="message">' + escapeHtml(message.message || '') + '</div>' + note +
          '<textarea placeholder="Operator note">' + escapeHtml(message.operatorNote || '') + '</textarea>' +
          '<div class="actions">' +
          '<button data-action="read">Mark read</button>' +
          '<button data-action="handled">Mark handled</button>' +
          '<button data-action="replied">Mark replied</button>' +
          '<button data-action="archived">Archive</button>' +
          '<button data-action="note">Save note</button>' +
          '</div></article>';
      }).join('');
    }

    async function load() {
      refreshBtn.disabled = true;
      statusEl.textContent = 'Loading contact messages…';
      statusEl.className = 'card';
      try {
        const response = await fetch('/api/website/contact-messages', { cache: 'no-store' });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.message || payload.error || 'Unable to load contact messages.');
        render(Array.isArray(payload.messages) ? payload.messages : []);
      } catch (error) {
        statusEl.textContent = error.message || 'Unable to load contact messages.';
        statusEl.className = 'card error';
        messagesEl.innerHTML = '';
      } finally {
        refreshBtn.disabled = false;
      }
    }

    async function updateMessage(card, patch) {
      const id = card.getAttribute('data-id');
      const response = await fetch('/api/website/contact-messages/' + encodeURIComponent(id), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || payload.error || 'Unable to update message.');
      await load();
    }

    messagesEl.addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const card = button.closest('[data-id]');
      const action = button.getAttribute('data-action');
      const note = card.querySelector('textarea')?.value || '';
      button.disabled = true;
      try {
        if (action === 'read') await updateMessage(card, { status: 'read', read: true });
        if (action === 'handled') await updateMessage(card, { status: 'handled', read: true, handled: true, operatorNote: note });
        if (action === 'replied') await updateMessage(card, { status: 'replied', read: true, replied: true, operatorNote: note });
        if (action === 'archived') await updateMessage(card, { status: 'archived', operatorNote: note });
        if (action === 'note') await updateMessage(card, { operatorNote: note });
      } catch (error) {
        alert(error.message || 'Unable to update message.');
      } finally {
        button.disabled = false;
      }
    });

    refreshBtn.addEventListener('click', load);
    load();
  </script>
</body>
</html>`);
}

module.exports = {
  router,
  renderContactInboxPage,
};
