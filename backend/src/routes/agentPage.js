const express = require("express");

const router = express.Router();

function renderAgentPage() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Garage Agent</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #07101d;
        --bg-soft: #0b1424;
        --panel: rgba(14, 24, 41, 0.88);
        --panel-strong: rgba(20, 31, 51, 0.94);
        --panel-muted: rgba(8, 17, 31, 0.62);
        --border: rgba(125, 183, 224, 0.24);
        --border-strong: rgba(125, 183, 224, 0.52);
        --text: #e6edf5;
        --muted: #9fb0c4;
        --muted-strong: #c4d2e1;
        --accent: #7db7e0;
        --accent-strong: #a5d8ff;
        --danger: #fca5a5;
        --warning: #facc15;
        --good: #86efac;
        --shadow: 0 24px 80px rgba(0, 0, 0, 0.32);
        --radius: 22px;
        font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
      }

      * { box-sizing: border-box; }

      html { min-height: 100%; }

      body {
        margin: 0;
        min-height: 100vh;
        background:
          radial-gradient(circle at 14% -10%, rgba(125, 183, 224, 0.22), transparent 34rem),
          radial-gradient(circle at 92% 12%, rgba(134, 239, 172, 0.1), transparent 28rem),
          linear-gradient(135deg, var(--bg) 0%, #0b1220 56%, #111827 100%);
        color: var(--text);
      }

      body::before {
        content: "";
        position: fixed;
        inset: 0;
        pointer-events: none;
        background-image: linear-gradient(rgba(255, 255, 255, 0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255, 255, 255, 0.025) 1px, transparent 1px);
        background-size: 42px 42px;
        mask-image: linear-gradient(to bottom, rgba(0, 0, 0, 0.5), transparent 75%);
      }

      button, textarea { font: inherit; }
      button { user-select: none; }

      .topbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        padding: 1rem 1.5rem;
        border-bottom: 1px solid var(--border);
        background: rgba(7, 16, 29, 0.82);
        backdrop-filter: blur(16px);
        position: sticky;
        top: 0;
        z-index: 4;
      }

      .brand {
        display: flex;
        align-items: center;
        gap: 0.85rem;
        min-width: 0;
      }

      .mark {
        width: 2.75rem;
        height: 2.75rem;
        border-radius: 16px;
        border: 1px solid rgba(125, 183, 224, 0.42);
        background:
          linear-gradient(135deg, rgba(125, 183, 224, 0.24), rgba(134, 239, 172, 0.08)),
          rgba(8, 17, 31, 0.9);
        display: grid;
        place-items: center;
        box-shadow: 0 12px 38px rgba(0, 0, 0, 0.28);
        flex: 0 0 auto;
      }

      .mark span {
        width: 1.1rem;
        height: 1.1rem;
        border: 2px solid var(--accent-strong);
        border-top-color: transparent;
        border-radius: 999px;
        display: block;
        transform: rotate(-28deg);
      }

      h1, h2, p { margin: 0; }
      h1 { font-size: clamp(1.25rem, 2vw, 1.7rem); letter-spacing: -0.02em; }
      h2 { font-size: 0.98rem; margin-bottom: 0.45rem; letter-spacing: 0.01em; }

      .subtle { color: var(--muted); font-size: 0.9rem; line-height: 1.45; }
      .micro { color: var(--muted); font-size: 0.78rem; line-height: 1.4; }

      .top-actions {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 0.55rem;
        flex-wrap: wrap;
      }

      .badge, .button, .quick, .mini-button {
        border-radius: 999px;
        border: 1px solid var(--border);
        background: rgba(20, 31, 51, 0.9);
        color: var(--text);
        padding: 0.48rem 0.78rem;
        font-size: 0.84rem;
        text-decoration: none;
        cursor: pointer;
        transition: transform 140ms ease, border-color 140ms ease, background 140ms ease, box-shadow 140ms ease;
      }

      .button:hover, .quick:hover, .mini-button:hover {
        transform: translateY(-1px);
        border-color: var(--border-strong);
        box-shadow: 0 12px 26px rgba(0, 0, 0, 0.18);
      }

      .badge {
        cursor: default;
        display: inline-flex;
        align-items: center;
        gap: 0.45rem;
      }

      .badge::before {
        content: "";
        width: 0.55rem;
        height: 0.55rem;
        border-radius: 999px;
        background: var(--warning);
        box-shadow: 0 0 18px rgba(250, 204, 21, 0.45);
      }

      .badge.good { color: var(--good); border-color: rgba(134, 239, 172, 0.45); }
      .badge.good::before { background: var(--good); box-shadow: 0 0 18px rgba(134, 239, 172, 0.45); }
      .badge.warn { color: var(--warning); border-color: rgba(250, 204, 21, 0.45); }
      .badge.bad { color: var(--danger); border-color: rgba(252, 165, 165, 0.45); }
      .badge.bad::before { background: var(--danger); box-shadow: 0 0 18px rgba(252, 165, 165, 0.45); }

      .layout {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(320px, 410px);
        gap: 1rem;
        padding: 1rem 1.5rem 2rem;
        position: relative;
        z-index: 1;
      }

      .card {
        border: 1px solid var(--border);
        border-radius: var(--radius);
        background: var(--panel);
        box-shadow: var(--shadow);
        backdrop-filter: blur(18px);
      }

      .chat {
        min-height: calc(100vh - 7rem);
        display: grid;
        grid-template-rows: auto 1fr auto;
        overflow: hidden;
      }

      .card-header {
        padding: 1rem;
        border-bottom: 1px solid var(--border);
        background: linear-gradient(135deg, rgba(21, 31, 51, 0.82), rgba(8, 17, 31, 0.46));
      }

      .header-row {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 0.75rem;
        margin-bottom: 0.45rem;
      }

      .pill-row {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 0.45rem;
        margin-top: 0.75rem;
      }

      .pill {
        border: 1px solid rgba(125, 183, 224, 0.22);
        background: rgba(8, 17, 31, 0.58);
        color: var(--muted-strong);
        border-radius: 999px;
        padding: 0.26rem 0.55rem;
        font-size: 0.75rem;
      }

      #transcript {
        padding: 1rem;
        overflow: auto;
        display: flex;
        flex-direction: column;
        gap: 0.8rem;
        scroll-behavior: smooth;
      }

      .message {
        max-width: min(920px, 100%);
        border: 1px solid var(--border);
        border-radius: 18px;
        padding: 0.86rem 0.98rem;
        white-space: pre-wrap;
        line-height: 1.52;
        box-shadow: 0 12px 30px rgba(0, 0, 0, 0.14);
      }

      .message.user {
        align-self: flex-end;
        background: linear-gradient(135deg, rgba(125, 183, 224, 0.2), rgba(125, 183, 224, 0.08));
        border-color: var(--border-strong);
      }

      .message.agent {
        align-self: flex-start;
        background: rgba(8, 17, 31, 0.74);
      }

      .message.system {
        align-self: center;
        max-width: 760px;
        background: rgba(250, 204, 21, 0.08);
        color: #fde68a;
        border-color: rgba(250, 204, 21, 0.28);
      }

      .composer {
        border-top: 1px solid var(--border);
        background: rgba(8, 17, 31, 0.72);
        padding: 1rem;
      }

      .input-shell {
        position: relative;
      }

      textarea {
        width: 100%;
        min-height: 7.5rem;
        resize: vertical;
        border: 1px solid var(--border);
        border-radius: 18px;
        padding: 0.92rem;
        padding-bottom: 2rem;
        background: rgba(5, 11, 20, 0.84);
        color: var(--text);
        outline: none;
        line-height: 1.48;
      }

      textarea:focus {
        border-color: var(--accent);
        box-shadow: 0 0 0 3px rgba(125, 183, 224, 0.13);
      }

      .input-footer {
        position: absolute;
        left: 0.85rem;
        right: 0.85rem;
        bottom: 0.55rem;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.75rem;
        pointer-events: none;
      }

      .composer-actions {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        gap: 0.85rem;
        margin-top: 0.85rem;
      }

      .quick-row { display: flex; flex-wrap: wrap; gap: 0.5rem; }
      .quick { padding: 0.42rem 0.72rem; }
      .primary { background: var(--accent); border-color: var(--accent); color: #06101d; font-weight: 800; }
      button:disabled, textarea:disabled { opacity: 0.58; cursor: wait; transform: none; }

      .sidebar { display: flex; flex-direction: column; gap: 1rem; }
      .side-card { padding: 1rem; }

      .status-grid {
        display: grid;
        grid-template-columns: 1fr;
        gap: 0.55rem;
        margin-top: 0.75rem;
      }

      .status-item {
        border: 1px solid rgba(125, 183, 224, 0.16);
        border-radius: 14px;
        background: rgba(8, 17, 31, 0.48);
        padding: 0.65rem 0.7rem;
      }

      .status-label {
        color: var(--muted);
        font-size: 0.72rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        margin-bottom: 0.18rem;
      }

      .status-value {
        color: var(--text);
        font-size: 0.9rem;
        word-break: break-word;
      }

      .guardrails {
        display: grid;
        gap: 0.5rem;
        margin-top: 0.72rem;
      }

      .guardrail {
        display: flex;
        align-items: flex-start;
        gap: 0.48rem;
        color: var(--muted-strong);
        font-size: 0.84rem;
        line-height: 1.38;
      }

      .guardrail::before {
        content: "";
        width: 0.42rem;
        height: 0.42rem;
        margin-top: 0.45rem;
        border-radius: 999px;
        background: var(--accent);
        flex: 0 0 auto;
      }

      #surfaceText, #diagText { white-space: pre-wrap; }

      details.tool {
        border: 1px solid var(--border);
        border-radius: 14px;
        background: rgba(8, 17, 31, 0.58);
        margin-top: 0.65rem;
        overflow: hidden;
      }

      details.tool summary {
        padding: 0.72rem 0.82rem;
        cursor: pointer;
        color: var(--muted-strong);
      }

      pre {
        margin: 0;
        padding: 0.75rem;
        border-top: 1px solid var(--border);
        max-height: 20rem;
        overflow: auto;
        background: #050b14;
        color: #dbeafe;
        font-size: 0.78rem;
      }

      .request-meter {
        margin-top: 0.7rem;
        height: 0.35rem;
        border-radius: 999px;
        background: rgba(125, 183, 224, 0.12);
        overflow: hidden;
        display: none;
      }

      .request-meter.active { display: block; }
      .request-meter span {
        display: block;
        width: 40%;
        height: 100%;
        border-radius: inherit;
        background: linear-gradient(90deg, transparent, var(--accent), transparent);
        animation: sweep 1.3s ease-in-out infinite;
      }

      @keyframes sweep {
        from { transform: translateX(-100%); }
        to { transform: translateX(260%); }
      }

      @media (max-width: 980px) {
        .layout { grid-template-columns: 1fr; padding: 1rem; }
        .chat { min-height: 72vh; }
        .topbar { align-items: flex-start; flex-direction: column; }
        .top-actions { justify-content: flex-start; }
      }

      @media (max-width: 680px) {
        .composer-actions { align-items: stretch; flex-direction: column; }
        .primary { width: 100%; }
        .brand { align-items: flex-start; }
        .mark { width: 2.35rem; height: 2.35rem; border-radius: 13px; }
      }
    </style>
  </head>
  <body>
    <header class="topbar">
      <div class="brand">
        <div class="mark" aria-hidden="true"><span></span></div>
        <div>
          <h1>Garage Agent</h1>
          <div class="subtle">Standalone read-only operator assistant for Garage Admin V2.</div>
        </div>
      </div>
      <div class="top-actions">
        <span id="statusBadge" class="badge warn">Page loaded</span>
        <a class="button" href="/">Dashboard</a>
      </div>
    </header>

    <main class="layout">
      <section class="card chat" aria-label="Garage Agent conversation">
        <div class="card-header">
          <div class="header-row">
            <div>
              <h2>Read-only operator chat</h2>
              <div class="subtle">Ask for current state, safe next steps, or recent memory evidence. The agent can inspect only the allowlisted read paths.</div>
            </div>
            <span class="pill">no mutation</span>
          </div>
          <div class="pill-row" aria-label="Garage Agent guardrails">
            <span class="pill">No restarts</span>
            <span class="pill">No writes</span>
            <span class="pill">No shell</span>
            <span class="pill">No secret reads</span>
            <span class="pill">Tool evidence visible</span>
          </div>
        </div>

        <div id="transcript">
          <div class="message system">Page version 2026-07-08-1425. Script booting...</div>
        </div>

        <form id="composer" class="composer">
          <div class="input-shell">
            <textarea id="messageInput" aria-label="Message to Garage Agent">Where did we leave off with Garage Admin V2? Use read-only tools only. Do not restart, write files, approve actions, or expose secrets.</textarea>
            <div class="input-footer">
              <span id="charCount" class="micro">0 chars</span>
              <span class="micro">Ctrl+Enter to send</span>
            </div>
          </div>
          <div id="requestMeter" class="request-meter" aria-hidden="true"><span></span></div>
          <div class="composer-actions">
            <div class="quick-row">
              <button type="button" class="quick" data-prompt="Where did we leave off with Garage Admin V2? Use read-only tools only. Do not restart, write files, approve actions, or expose secrets.">Where left off</button>
              <button type="button" class="quick" data-prompt="Check Garage Agent readiness using read-only evidence only. Do not expose secrets.">Readiness</button>
              <button type="button" class="quick" data-prompt="What is the safest next step for Garage Admin V2? Use read-only evidence only and call out degraded or unverified data.">Safest next step</button>
            </div>
            <button id="sendButton" type="submit" class="button primary">Send</button>
          </div>
        </form>
      </section>

      <aside class="sidebar" aria-label="Garage Agent evidence and diagnostics">
        <section class="card side-card">
          <h2>Agent surface</h2>
          <div class="subtle">Backend status and read-only tool availability.</div>
          <div id="surfaceGrid" class="status-grid">
            <div class="status-item"><div class="status-label">Status</div><div class="status-value" id="surfaceStatus">Waiting for script...</div></div>
            <div class="status-item"><div class="status-label">Mode</div><div class="status-value" id="surfaceMode">Unknown</div></div>
            <div class="status-item"><div class="status-label">Model</div><div class="status-value" id="surfaceModel">Unknown</div></div>
            <div class="status-item"><div class="status-label">Tools</div><div class="status-value" id="surfaceTools">Unknown</div></div>
          </div>
        </section>

        <section class="card side-card">
          <h2>Guardrails</h2>
          <div class="guardrails">
            <div class="guardrail">Reads active memory, service status, and capped logs through allowlisted backend tools.</div>
            <div class="guardrail">Cannot perform restarts, approvals, file writes, deployments, or memory mutation.</div>
            <div class="guardrail">Tool results are redacted and shown below the answer for operator review.</div>
          </div>
        </section>

        <section class="card side-card">
          <h2>Last tool calls</h2>
          <div id="toolCalls" class="subtle">No tool calls yet.</div>
        </section>

        <section class="card side-card">
          <h2>Diagnostics</h2>
          <div id="diagText" class="subtle">No request yet.</div>
        </section>
      </aside>
    </main>

    <script>
      (function () {
        "use strict";

        var VERSION = "2026-07-08-1425";
        var transcript = document.getElementById("transcript");
        var composer = document.getElementById("composer");
        var input = document.getElementById("messageInput");
        var sendButton = document.getElementById("sendButton");
        var statusBadge = document.getElementById("statusBadge");
        var surfaceStatus = document.getElementById("surfaceStatus");
        var surfaceMode = document.getElementById("surfaceMode");
        var surfaceModel = document.getElementById("surfaceModel");
        var surfaceTools = document.getElementById("surfaceTools");
        var toolCalls = document.getElementById("toolCalls");
        var diagText = document.getElementById("diagText");
        var charCount = document.getElementById("charCount");
        var requestMeter = document.getElementById("requestMeter");
        var busy = false;

        function setBadge(text, kind) {
          statusBadge.textContent = text;
          statusBadge.className = "badge " + (kind || "warn");
        }

        function setDiag(text) {
          diagText.textContent = text;
        }

        function setSurface(values) {
          surfaceStatus.textContent = values.status || "Unknown";
          surfaceMode.textContent = values.mode || "Unknown";
          surfaceModel.textContent = values.model || "Unknown";
          surfaceTools.textContent = values.tools || "Unknown";
        }

        function addMessage(role, text) {
          var div = document.createElement("div");
          div.className = "message " + role;
          div.textContent = text;
          transcript.appendChild(div);
          transcript.scrollTop = transcript.scrollHeight;
          return div;
        }

        function updateMessage(node, text) {
          if (node) node.textContent = text;
          transcript.scrollTop = transcript.scrollHeight;
        }

        function updateCharCount() {
          charCount.textContent = String(input.value.length) + " chars";
        }

        function setBusy(next) {
          busy = next;
          sendButton.disabled = next;
          input.disabled = next;
          sendButton.textContent = next ? "Thinking..." : "Send";
          requestMeter.className = next ? "request-meter active" : "request-meter";
        }

        async function fetchJson(url, options) {
          var response = await fetch(url, options || {});
          var text = await response.text();
          var data = null;
          try { data = text ? JSON.parse(text) : null; } catch (_error) { data = null; }
          return { response: response, text: text, data: data };
        }

        function renderStatus(data) {
          var tools = Array.isArray(data && data.tools) ? data.tools.map(function (tool) { return tool.name; }).join(", ") : "none";
          setSurface({
            status: "Version " + VERSION + "; enabled " + String(Boolean(data && data.enabled)) + "; API key configured " + String(Boolean(data && data.apiKeyConfigured)),
            mode: (data && data.mode) || "unknown",
            model: (data && data.model) || "unknown",
            tools: tools,
          });
          setBadge("Garage Agent: " + ((data && data.mode) || "unknown"), data && data.mode === "configured" ? "good" : "warn");
        }

        function renderTools(calls) {
          if (!Array.isArray(calls) || !calls.length) {
            toolCalls.textContent = "No tool calls returned.";
            return;
          }
          toolCalls.innerHTML = "";
          calls.forEach(function (call, index) {
            var details = document.createElement("details");
            details.className = "tool";
            if (index === 0) details.open = true;
            var summary = document.createElement("summary");
            summary.textContent = (call.ok === false ? "Warning: " : "OK: ") + (call.name || "tool");
            var pre = document.createElement("pre");
            pre.textContent = JSON.stringify(call.result || call, null, 2);
            details.appendChild(summary);
            details.appendChild(pre);
            toolCalls.appendChild(details);
          });
        }

        async function loadStatus() {
          setBadge("Garage Agent: checking", "warn");
          setSurface({ status: "Script running. Fetching Garage Agent backend status...", mode: "checking", model: "checking", tools: "checking" });
          setDiag("Status fetch started.");
          try {
            var result = await fetchJson("/api/chatkit/custom-agent/status?fresh=" + encodeURIComponent(VERSION));
            setDiag("Status fetch HTTP " + result.response.status + ".");
            if (!result.response.ok || !result.data) {
              setSurface({ status: "Status request failed. HTTP " + result.response.status + "\\n" + result.text, mode: "failed", model: "unknown", tools: "unknown" });
              setBadge("Garage Agent: status failed", "bad");
              return;
            }
            renderStatus(result.data);
          } catch (error) {
            setSurface({ status: "Status fetch threw: " + (error && error.message ? error.message : String(error)), mode: "unavailable", model: "unknown", tools: "unknown" });
            setBadge("Garage Agent: unavailable", "bad");
            setDiag("Status fetch exception.");
          }
        }

        async function sendMessage(text) {
          if (busy) return;
          setBusy(true);
          addMessage("user", text);
          var startedAt = Date.now();
          var progress = addMessage("system", "Working... 0s elapsed.");
          var progressTimer = window.setInterval(function () {
            var seconds = Math.round((Date.now() - startedAt) / 1000);
            updateMessage(progress, "Working... " + seconds + "s elapsed. Evidence turns may take 25-45s.");
          }, 1000);
          var controller = new AbortController();
          var timeout = window.setTimeout(function () { controller.abort(); }, 90000);

          try {
            setDiag("Message request started.");
            var result = await fetchJson("/api/chatkit/custom-agent/message", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ message: text }),
              signal: controller.signal,
            });
            setDiag("Message request HTTP " + result.response.status + ".");
            if (!result.response.ok || !result.data || !result.data.ok) {
              var errorMessage = result.data && result.data.error && result.data.error.message ? result.data.error.message : result.text || "Custom agent request failed.";
              updateMessage(progress, "Request failed: " + errorMessage);
              renderTools(result.data && result.data.toolCalls);
              return;
            }
            updateMessage(progress, "Completed in " + Math.round((Date.now() - startedAt) / 1000) + "s.");
            addMessage("agent", result.data.answer || "No answer returned.");
            renderTools(result.data.toolCalls);
          } catch (error) {
            var message = error && error.name === "AbortError" ? "Request timed out after 90s." : error && error.message ? error.message : String(error);
            updateMessage(progress, "Request failed: " + message);
            setDiag("Message request exception.");
          } finally {
            window.clearInterval(progressTimer);
            window.clearTimeout(timeout);
            setBusy(false);
          }
        }

        function init() {
          setBadge("Garage Agent: script running", "warn");
          setSurface({ status: "Script running. Page version " + VERSION + ".", mode: "booting", model: "unknown", tools: "waiting" });
          addMessage("system", "Script ready. Page version " + VERSION + ".");
          updateCharCount();
          input.addEventListener("input", updateCharCount);
          input.addEventListener("keydown", function (event) {
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
              event.preventDefault();
              composer.requestSubmit();
            }
          });
          composer.addEventListener("submit", function (event) {
            event.preventDefault();
            var text = input.value.trim();
            if (!text) return;
            input.value = "";
            updateCharCount();
            sendMessage(text);
          });
          Array.prototype.slice.call(document.querySelectorAll("[data-prompt]")).forEach(function (button) {
            button.addEventListener("click", function () {
              input.value = button.getAttribute("data-prompt") || "";
              updateCharCount();
              input.focus();
            });
          });
          loadStatus();
        }

        window.addEventListener("error", function (event) {
          setBadge("Garage Agent: script error", "bad");
          setSurface({ status: "Script error: " + (event.message || "unknown"), mode: "script error", model: "unknown", tools: "unknown" });
          setDiag("Script error captured.");
        });

        init();
      })();
    </script>
  </body>
</html>`;
}

router.get("/agent", (_req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.type("html").send(renderAgentPage());
});

module.exports = router;
