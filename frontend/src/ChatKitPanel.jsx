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

  const isConfigured = status?.status === "configured";
  const safeStatusMessage = cleanText(status?.error?.message);
  const panelSummary = useMemo(() => {
    if (isConfigured) {
      return "Hosted ChatKit session surface. Assistant-only, read-only.";
    }

    return safeStatusMessage || "ChatKit remains in prep mode until backend session config is available.";
  }, [isConfigured, safeStatusMessage]);

  if (!isConfigured) {
    return (
      <div className="chatkit-panel-shell">
        <p className="inline-note">{panelSummary}</p>
        <div className="known-failure">
          ChatKit remains unavailable. Diagnostics below still reflect the local prep routes only.
        </div>
      </div>
    );
  }

  if (scriptError) {
    return (
      <div className="chatkit-panel-shell">
        <p className="inline-note">{panelSummary}</p>
        <div className="known-failure">{scriptError}</div>
      </div>
    );
  }

  if (!scriptReady) {
    return (
      <div className="chatkit-panel-shell">
        <p className="inline-note">{panelSummary}</p>
        <div className="inline-note">Loading ChatKit client assets...</div>
      </div>
    );
  }

  return (
    <div className="chatkit-panel-shell">
      <div className="chatkit-panel-meta">
        <span className="status-badge status-completed">Hosted session ready</span>
        <span className="inline-note">Temporary local operator identifier in use for this browser.</span>
      </div>
      <ChatKitSurface operatorId={operatorId} selectedServiceLabel={selectedServiceLabel} />
    </div>
  );
}
