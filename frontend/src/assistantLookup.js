export const ASSISTANT_LOOKUP_CHIPS = Object.freeze([
  { id: "reports", label: "Find report" },
  { id: "search-files", label: "Search files" },
  { id: "read-file", label: "Open safe file preview" },
  { id: "logs-query", label: "Query logs" },
  { id: "explain-report", label: "Explain this report" },
]);

function cleanText(value) {
  return String(value || "").trim();
}

export function createAssistantSelection(item = {}) {
  return {
    kind: cleanText(item.kind),
    title: cleanText(item.title),
    path: cleanText(item.path),
    relativePath: cleanText(item.relativePath),
    reportId: cleanText(item.reportId),
    serviceName: cleanText(item.serviceName),
  };
}

export function buildAssistantLookupInvocation(actionId, options = {}) {
  const input = cleanText(options.input);
  const selection = options.selection && typeof options.selection === "object" ? options.selection : {};
  const selectedService = cleanText(options.selectedService);
  const selectedTitle = cleanText(options.title || selection.title);
  const selectedPath = cleanText(options.path || selection.path || input);
  const selectedReportId = cleanText(options.reportId || selection.reportId);

  if (actionId === "reports") {
    const query = input || selectedTitle;

    return {
      message: query ? `Find report: ${query}` : "Find report",
      lookupRequest: {
        type: "reports",
        query,
      },
    };
  }

  if (actionId === "search-files") {
    const query = input || cleanText(selection.relativePath) || selectedTitle || selectedService;

    if (!query) {
      return {
        error: "Enter a filename, path, or keyword before searching files.",
      };
    }

    return {
      message: `Search files: ${query}`,
      lookupRequest: {
        type: "search-files",
        query,
        searchContent: true,
        limit: 12,
      },
    };
  }

  if (actionId === "read-file") {
    if (!selectedReportId && !selectedPath) {
      return {
        error: "Select a report or file result first, or enter a path to preview.",
      };
    }

    return {
      message: `Open safe file preview: ${selectedTitle || selectedPath || selectedReportId}`,
      lookupRequest: {
        type: "read-file",
        ...(selectedReportId ? { reportId: selectedReportId } : { path: selectedPath }),
        maxBytes: 12 * 1024,
      },
    };
  }

  if (actionId === "logs-query") {
    const service = cleanText(options.service || selection.serviceName || selectedService);

    if (!service) {
      return {
        error: "Select a service before querying logs.",
      };
    }

    return {
      message: input ? `Query logs for ${service}: ${input}` : `Query logs for ${service}`,
      lookupRequest: {
        type: "logs-query",
        service,
        filter: input,
        lines: 40,
      },
    };
  }

  if (actionId === "explain-report") {
    const query = cleanText(options.query || input || selectedTitle);

    if (!selectedReportId && !query) {
      return {
        error: "Select a report first, or enter a report name to explain.",
      };
    }

    return {
      message: query ? `Explain this report: ${query}` : "Explain this report",
      lookupRequest: {
        type: "explain-report",
        ...(selectedReportId ? { reportId: selectedReportId } : { query }),
      },
    };
  }

  return {
    error: "Unsupported assistant lookup action.",
  };
}
