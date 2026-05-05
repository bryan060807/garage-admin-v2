function parseWorkerList() {
  const configured = process.env.WORKER_REGISTRY_JSON;

  if (configured) {
    try {
      const parsed = JSON.parse(configured);
      if (Array.isArray(parsed)) {
        return parsed.map((worker) => ({
          ...worker,
          registrySource: "WORKER_REGISTRY_JSON",
        }));
      }
    } catch {
      // Fall through to default registry.
    }
  }

  const fedoraGarageApiUrl = process.env.FEDORA_GARAGE_API_URL;
  const fedoraAdminProxyUrl = process.env.FEDORA_ADMIN_PROXY_URL || "http://fedora.local:4000";
  const fedoraWorkerBaseUrl = fedoraGarageApiUrl || fedoraAdminProxyUrl;
  const fedoraWorkerAuthTokenEnv = fedoraGarageApiUrl ? "FEDORA_GARAGE_API_KEY" : "ADMIN_BRIDGE_TOKEN";
  const fedoraWorkerAuthHeader = fedoraGarageApiUrl ? "X-API-KEY" : "x-aibry-auth";
  const fedoraWorkerTransport = fedoraGarageApiUrl ? "fedora-garage-helper" : "fedora-admin-proxy";

  return [
    {
      id: "windows-runtime",
      name: "Windows Runtime Worker",
      host: "windows",
      role: "runtime",
      baseUrl: process.env.WINDOWS_WORKER_URL || "http://127.0.0.1:4091",
      authHeader: "x-worker-auth",
      authTokenEnv: "WINDOWS_WORKER_AUTH_TOKEN",
      description: "Read-only Windows PM2/runtime/repo evidence worker.",
      registrySource: "built-in worker registry",
    },
    {
      id: "fedora-infra",
      name: "Fedora Infra Worker",
      host: "fedora",
      role: "infra",
      baseUrl: fedoraWorkerBaseUrl,
      authHeader: fedoraWorkerAuthHeader,
      authTokenEnv: fedoraWorkerAuthTokenEnv,
      transport: fedoraWorkerTransport,
      description: fedoraGarageApiUrl
        ? "Read-only Fedora infra evidence via the Garage helper."
        : "Read-only Fedora infra evidence via guarded admin-proxy routes.",
      registrySource: "built-in worker registry",
    },
    {
      id: "fedora-bootstrap",
      name: "Fedora Bootstrap Worker",
      host: "fedora",
      role: "bootstrap",
      baseUrl: fedoraWorkerBaseUrl,
      authHeader: fedoraWorkerAuthHeader,
      authTokenEnv: fedoraWorkerAuthTokenEnv,
      transport: fedoraWorkerTransport,
      description: fedoraGarageApiUrl
        ? "Read-only Fedora bootstrap evidence via the Garage helper."
        : "Read-only Fedora bootstrap evidence via guarded admin-proxy routes.",
      registrySource: "built-in worker registry",
    },
    {
      id: "fedora-repo",
      name: "Fedora Repo Worker",
      host: "fedora",
      role: "repository",
      baseUrl: fedoraGarageApiUrl,
      authHeader: "X-API-KEY",
      authTokenEnv: "FEDORA_GARAGE_API_KEY",
      transport: "fedora-garage-helper",
      description: "Read-only Fedora repository evidence via the Garage helper.",
      registrySource: "built-in worker registry",
    },
  ];
}

function publicWorker(worker) {
  return {
    id: worker.id,
    name: worker.name,
    host: worker.host,
    role: worker.role,
    baseUrl: worker.baseUrl,
    description: worker.description,
    registrySource: worker.registrySource || "built-in worker registry",
    transport: worker.transport,
    authConfigured: Boolean(process.env[worker.authTokenEnv]),
  };
}

function getWorkers() {
  return parseWorkerList()
    .filter((worker) => worker && worker.id && worker.baseUrl)
    .map((worker) => ({
      ...worker,
      authHeader: worker.authHeader || "x-worker-auth",
    }));
}

function getWorkerById(id) {
  return getWorkers().find((worker) => worker.id === id);
}

module.exports = {
  getWorkers,
  getWorkerById,
  publicWorker,
};
