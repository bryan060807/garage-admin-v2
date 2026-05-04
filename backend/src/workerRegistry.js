function parseWorkerList() {
  const configured = process.env.WORKER_REGISTRY_JSON;

  if (configured) {
    try {
      const parsed = JSON.parse(configured);
      if (Array.isArray(parsed)) {
        return parsed.map((worker) => ({
          ...worker,
          registrySource: "WORKER_REGISTRY_JSON"
        }));
      }
    } catch {
      // Fall through to default registry.
    }
  }

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
      registrySource: "built-in worker registry"
    }
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
    authConfigured: Boolean(process.env[worker.authTokenEnv])
  };
}

function getWorkers() {
  return parseWorkerList()
    .filter((worker) => worker && worker.id && worker.baseUrl)
    .map((worker) => ({
      ...worker,
      authHeader: worker.authHeader || "x-worker-auth"
    }));
}

function getWorkerById(id) {
  return getWorkers().find((worker) => worker.id === id);
}

module.exports = {
  getWorkers,
  getWorkerById,
  publicWorker
};
