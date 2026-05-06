import { useEffect, useMemo, useState } from "react";
import { ChatKit, useChatKit } from "@openai/chatkit-react";

const CHATKIT_OPERATOR_STORAGE_KEY = "garage-admin-v2:chatkit-operator-id";

function cleanText(value) {
  return String(value || "").trim();
}

function isBrowserReady() {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

function createTemporaryOperatorId() {
  if (!isBrowserReady()) {
    return "garage-admin-local-operator";
  }

  const cryptoObject = window.crypto;

  if (cryptoObject?.randomUUID) {
    return `garage-admin-local-operator-${cryptoObject.randomUUID()}`;
  }

  return `garage-admin-local-operator-${Math.random().toString(36).slice(2, 12)}`;
}

function loadTemporaryOperatorId() {
  if (!isBrowserReady()) {
    return "garage-admin-local-operator";
  }

  try {
    const existing = cleanText(window.localStorage.getItem(CHATKIT_OPERATOR_STORAGE_KEY));

    if (existing) {
      return existing;
    }

    const created = createTemporaryOperatorId();
    window.localStorage.setItem(CHATKIT_OPERATOR_STORAGE_KEY, created);
    return created;
  } catch (_error) {
    return createTemporaryOperatorId();
  }
}

function getModeBadgeClass(mode) {
  if (mode === "configured") {
    return "status-completed";
  }

  if (mode === "error") {
    return "status-failed";
  }

  if (mode === "prep") {
    return "status-warning";
  }

  return "status-unknown";
}

function formatModeLabel(mode) {
  if (mode === "configured") {
    return "Configured";
  }

  if (mode === "disabled") {
    return "Disabled";
  }

  if (mode === "error") {
    return "Error";
  }

  return "Prep";
}

function ChatKitSurface({ operatorId, selectedServiceLabel }) {
  const { control } = useChatKit({
    api: {
      async getClientSecret() {
        const response = await fetch("/api/chatkit/session", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-chatkit-user": operatorId,
          },
        });
        const data = await response.json();

        if (!response.ok || !cleanText(data?.client_secret)) {
          throw new Error(data?.error?.message || "ChatKit session is unavailable.");
        }

        return data.client_secret;
      },
    },
    theme: {
      colorScheme: "dark",
      density: "compact",
      radius: "soft",
      color: {
        accent: {
          primary: "#7db7e0",
          level: 2,
        },
      },
      typography: {
        fontFamily: "\"Segoe UI\", Tahoma, Geneva, Verdana, sans-serif",
      },
    },
    composer: {
      placeholder: selectedServiceLabel
        ? `Ask about ${selectedServiceLabel} using read-only operator context`
        : "Ask for read-only operator context and planning",
    },
    startScreen: {
      greeting: "Assistant-only operator workspace",
      prompts: [
        {
          name: "Summarize selected service",
          prompt: "Summarize the selected service using the current read-only operator context.",
          icon: "search",
        },
        {
          name: "Safest next step",
          prompt: "What is the safest next step using the current read-only operator context?",
          icon: "sparkles",
        },
        {
          name: "Review logs",
          prompt: "What logs should I review before considering any approval-routed action?",
          icon: "book-open",
        },
      ],
    },
    disclaimer: {
      text: "Assistant-only surface. State-changing work stays in Service Actions.",
    },
  });

  return <ChatKit control={control} className="chatkit-embedded-surface" />;
}

export default function ChatKitPanel({ status = null, selectedServiceLabel = "" }) {
  const [operatorId] = useState(loadTemporaryOperatorId);
  const [scriptReady, setScriptReady] = useState(false);
  const [scriptError, setScriptError] = useState("");

  useEffect(() => {
    if (!isBrowserReady()) {
      return undefined;
    }

    if (window.customElements?.get("openai-chatkit")) {
      setScriptReady(true);
      return undefined;
    }

    const existingScript = document.querySelector('script[src="https://cdn.platform.openai.com/deployments/chatkit/chatkit.js"]');

    if (existingScript?.getAttribute("data-loaded") === "true") {
      setScriptReady(true);
      return undefined;
    }

    if (existingScript) {
      const handleLoad = () => {
        existingScript.setAttribute("data-loaded", "true");
        setScriptReady(true);
      };
      const handleError = () => {
        setScriptError("ChatKit client assets did not load.");
      };

      existingScript.addEventListener("load", handleLoad);
      existingScript.addEventListener("error", handleError);

      return () => {
        existingScript.removeEventListener("load", handleLoad);
        existingScript.removeEventListener("error", handleError);
      };
    }

    setScriptReady(false);
    setScriptError("ChatKit client assets are not available.");
    return undefined;
  }, []);

  const mode = cleanText(status?.mode) || "disabled";
  const isConfigured = mode === "configured" && cleanText(status?.availability) === "session_ready";
  const safeStatusMessage = cleanText(status?.reason || status?.error?.message);
  const missingConfig = Array.isArray(status?.missingConfig) ? status.missingConfig : [];
  const requirements = Array.isArray(status?.requirements) ? status.requirements : [];
  const intentionallyDisabled = Array.isArray(status?.intentionallyDisabled) ? status.intentionallyDisabled : [];
  const nextStep = cleanText(status?.nextStep);
  const panelSummary = useMemo(() => {
    if (isConfigured) {
      return "Hosted ChatKit session surface. Assistant-only, read-only.";
    }

    return safeStatusMessage || "ChatKit remains in readiness mode until backend session config is available.";
  }, [isConfigured, safeStatusMessage]);

  const readinessCard = (
    <div className="chatkit-readiness-card">
      <div className="chatkit-panel-meta">
        <span className={`status-badge ${getModeBadgeClass(mode)}`}>{formatModeLabel(mode)}</span>
        <span className="status-badge status-info">{cleanText(status?.availability) || "unavailable"}</span>
        <span className="inline-note">Backend-only credentials. Assistant-only surface.</span>
      </div>
      <p className="inline-note">{panelSummary}</p>
      <div className="assistant-context-facts">
        {requirements.map((requirement) => (
          <span
            key={requirement.name}
            className={`assistant-context-fact ${requirement.configured ? "chatkit-fact-ready" : "chatkit-fact-missing"}`}
          >
            <strong>{requirement.name}:</strong> {requirement.configured ? "configured" : "missing"}
          </span>
        ))}
      </div>
      {missingConfig.length ? (
        <div className="known-failure">
          Missing config names only: <code>{missingConfig.join(", ")}</code>
        </div>
      ) : null}
      {nextStep ? (
        <div className="chatkit-next-step">
          <span className="detail-label">Next safe step</span>
          <p>{nextStep}</p>
        </div>
      ) : null}
      {intentionallyDisabled.length ? (
        <div className="chatkit-disabled-list">
          {intentionallyDisabled.map((item) => (
            <span key={item} className="status-badge status-unknown">
              {item}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );

  if (!isConfigured) {
    return (
      <div className="chatkit-panel-shell">
        {readinessCard}
        <div className="known-failure">
          Hosted sessions remain unavailable. The diagnostics below still reflect local readiness routes only.
        </div>
      </div>
    );
  }

  if (scriptError) {
    return (
      <div className="chatkit-panel-shell">
        {readinessCard}
        <div className="known-failure">{scriptError}</div>
      </div>
    );
  }

  if (!scriptReady) {
    return (
      <div className="chatkit-panel-shell">
        {readinessCard}
        <div className="inline-note">Loading ChatKit client assets...</div>
      </div>
    );
  }

  return (
    <div className="chatkit-panel-shell">
      {readinessCard}
      <div className="chatkit-panel-meta">
        <span className="status-badge status-completed">Hosted session enabled</span>
        <span className="inline-note">Temporary local operator identifier in use for this browser.</span>
      </div>
      <ChatKitSurface operatorId={operatorId} selectedServiceLabel={selectedServiceLabel} />
    </div>
  );
}
