const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const express = require("express");
const defaultRepository = require("../lib/repository");
const defaultDatabase = require("../db");
const config = require("../config");
const { redactText } = require("../lib/outputRedaction");

const READ_TIMEOUT_MS = config.memoryReadTimeoutMs;

function createReadTimeoutError(label) {
  const error = new Error(`${label} read timed out after ${READ_TIMEOUT_MS}ms.`);
  error.code = "memory_read_timeout";
  return error;
}

function withReadTimeout(label, readPromise) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(createReadTimeoutError(label)), READ_TIMEOUT_MS);
  });

  return Promise.race([readPromise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

function asyncRoute(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (error) {
      next(error);
    }
  };
}

function execFileAsync(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout = "", stderr = "") => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

function requireConfirmedAction(req, actionLabel) {
  if (req.body?.confirm === true) {
    return;
  }

  const error = new Error(`${actionLabel} requires explicit confirmation.`);
  error.statusCode = 400;
  error.code = "confirmation_required";
  throw error;
}

function safeActionError(error, fallbackMessage) {
  return {
    code: error?.code || error?.name || "memory_patch_action_failed",
    message: redactText(error?.message || fallbackMessage),
    stderr: error?.stderr ? redactText(error.stderr) : undefined,
    stdout: error?.stdout ? redactText(error.stdout) : undefined,
  };
}

function safeReadRoute(label, loadItems) {
  return asyncRoute(async (_req, res) => {
    try {
      const items = await withReadTimeout(label, loadItems());
      res.json({ items, degraded: false });
    } catch (error) {
      const classifiedError = defaultDatabase.classifyDatabaseError(error);
      const safeError =
        classifiedError.code === "database_error" && error?.code
          ? {
              code: error.code,
              message: `${label} is temporarily unavailable. Continuing with an empty list.`,
            }
          : classifiedError;
      console.warn(`[memory] ${label} unavailable`, {
        code: safeError.code || error?.name || "memory_read_failed",
        message: redactText(error?.message || "Memory read failed."),
        degraded: true,
      });

      res.status(200).json({
        items: [],
        degraded: true,
        error: {
          code: safeError.code || "memory_read_failed",
          message: safeError.message || `${label} is temporarily unavailable. Continuing with an empty list.`,
        },
      });
    }
  });
}

function toBoolean(value) {
  return value === true;
}

function normalizeProposalName(value) {
  const name = path.basename(String(value || "").trim().replace(/\\/g, "/"));
  if (!name || name !== String(value || "").trim().replace(/\\/g, "/") || !name.endsWith(".patch.md")) {
    return "";
  }
  return name;
}

function getProposalsDir(memoryRoot = config.garageMemoryRoot) {
  const root = path.resolve(memoryRoot || "");
  return path.join(root, "proposed_patches");
}

function proposalPathForName(name, memoryRoot = config.garageMemoryRoot) {
  const safeName = normalizeProposalName(name);
  if (!safeName) {
    const error = new Error("Invalid proposal filename.");
    error.statusCode = 400;
    error.code = "invalid_proposal_name";
    throw error;
  }

  const proposalsDir = path.resolve(getProposalsDir(memoryRoot));
  const fullPath = path.resolve(proposalsDir, safeName);
  if (path.dirname(fullPath) !== proposalsDir) {
    const error = new Error("Invalid proposal path.");
    error.statusCode = 400;
    error.code = "invalid_proposal_path";
    throw error;
  }
  return fullPath;
}

function reviewedProposalPathForName(name, status, memoryRoot = config.garageMemoryRoot) {
  const safeName = normalizeProposalName(name);
  if (!safeName) {
    const error = new Error("Invalid proposal filename.");
    error.statusCode = 400;
    error.code = "invalid_proposal_name";
    throw error;
  }

  const safeStatus = status === "applied" ? "applied" : "neutralized";
  const root = path.resolve(memoryRoot || "");
  const reviewedDir = path.resolve(root, "reviewed_patches", safeStatus);
  const timestamp = new Date().toISOString().replace(/[.:]/g, "-");
  const reviewedPath = path.resolve(reviewedDir, `${timestamp}__${safeName}`);

  if (path.dirname(reviewedPath) !== reviewedDir) {
    const error = new Error("Invalid reviewed proposal path.");
    error.statusCode = 400;
    error.code = "invalid_reviewed_proposal_path";
    throw error;
  }

  return { reviewedDir, reviewedPath };
}

function parseProposalFrontmatter(text) {
  const match = String(text || "").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return {};
  }

  const metadata = {};
  for (const line of match[1].split(/\r?\n/)) {
    const simple = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!simple) {
      continue;
    }
    const key = simple[1];
    let value = simple[2].trim();
    value = value.replace(/^[\'\"]|[\'\"]$/g, "");
    metadata[key] = value;
  }
  return metadata;
}

function stripProposalFrontmatter(text) {
  return String(text || "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

function parseProposalReviewWarnings(text) {
  const body = stripProposalFrontmatter(text);
  const match = body.match(/(?:^|\r?\n)## REVIEW_WARNINGS\r?\n([\s\S]*?)(?=\r?\n##\s+|$)/i);
  if (!match) {
    return [];
  }

  return match[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => line.replace(/^-\s*/, "").trim())
    .filter((line) => line && line !== "-");
}

function publicProposalSummary(file, stat, text) {
  const metadata = parseProposalFrontmatter(text);
  const warnings = parseProposalReviewWarnings(text);
  return {
    name: file,
    topic: metadata.topic || file.replace(/\.patch\.md$/, ""),
    generatedAt: metadata.generated_at || null,
    sourceSession: metadata.source_session || null,
    targetProject: metadata.target_project || null,
    warnings,
    warningCount: warnings.length,
    sizeBytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  };
}

function parseTouchedFiles(stdout) {
  return String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function listPatchProposals(memoryRoot = config.garageMemoryRoot) {
  const proposalsDir = getProposalsDir(memoryRoot);
  let entries;
  try {
    entries = await fs.readdir(proposalsDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const items = [];
  for (const entry of entries) {
    if (!entry.isFile() || !normalizeProposalName(entry.name)) {
      continue;
    }
    const fullPath = proposalPathForName(entry.name, memoryRoot);
    const [stat, text] = await Promise.all([fs.stat(fullPath), fs.readFile(fullPath, "utf8")]);
    items.push(publicProposalSummary(entry.name, stat, text));
  }

  return items.sort((a, b) => String(b.modifiedAt || "").localeCompare(String(a.modifiedAt || "")));
}

async function readPatchProposal(name, memoryRoot = config.garageMemoryRoot) {
  const fullPath = proposalPathForName(name, memoryRoot);
  const [stat, text] = await Promise.all([fs.stat(fullPath), fs.readFile(fullPath, "utf8")]);
  return {
    ...publicProposalSummary(path.basename(fullPath), stat, text),
    body: stripProposalFrontmatter(text),
    raw: text,
  };
}

async function defaultApplyPatchProposal(name, memoryRoot = config.garageMemoryRoot) {
  const fullPath = proposalPathForName(name, memoryRoot);
  const env = {
    ...process.env,
    GARAGE_MEMORY_ROOT: path.resolve(memoryRoot || ""),
  };
  const result = await execFileAsync(config.garageMemoryCommand, ["apply-patch", fullPath], {
    cwd: config.garageMemoryWorkerRoot,
    env,
    timeout: config.memoryApplyTimeoutMs,
    windowsHide: true,
  });

  return {
    touchedFiles: parseTouchedFiles(result.stdout),
    stdout: redactText(result.stdout || ""),
    stderr: redactText(result.stderr || ""),
  };
}

async function moveProposalToReviewed(name, status, memoryRoot = config.garageMemoryRoot) {
  const sourcePath = proposalPathForName(name, memoryRoot);
  const { reviewedDir, reviewedPath } = reviewedProposalPathForName(name, status, memoryRoot);
  await fs.mkdir(reviewedDir, { recursive: true });
  await fs.rename(sourcePath, reviewedPath);
  return {
    name: path.basename(reviewedPath),
    status,
    relativePath: path.relative(path.resolve(memoryRoot || ""), reviewedPath).replace(/\\/g, "/"),
  };
}

function publicMemoryHealth(health) {
  return {
    ok: toBoolean(health?.ok),
    degraded: health?.degraded !== false,
    databaseConfigured: toBoolean(health?.databaseConfigured),
    poolAvailable: toBoolean(health?.poolAvailable),
    latencyMs: Number.isFinite(Number(health?.latencyMs)) ? Number(health.latencyMs) : null,
    checks: {
      canSelectNow: toBoolean(health?.checks?.canSelectNow),
      tablePresence: {
        incidents: toBoolean(health?.checks?.tablePresence?.incidents),
        action_audit: toBoolean(health?.checks?.tablePresence?.action_audit),
        service_facts: toBoolean(health?.checks?.tablePresence?.service_facts),
      },
    },
    error: health?.error
      ? {
          code: String(health.error.code || "database_error"),
          message: String(health.error.message || "Garage Admin memory database check failed."),
        }
      : null,
  };
}

function createRouter({
  repository = defaultRepository,
  database = defaultDatabase,
  memoryRoot = config.garageMemoryRoot,
  applyPatchProposal = defaultApplyPatchProposal,
} = {}) {
  const router = express.Router();

  router.get(
    "/health",
    asyncRoute(async (_req, res) => {
      const health = await database.getMemoryHealth();
      res.status(200).json(publicMemoryHealth(health));
    }),
  );

  router.get("/incidents", safeReadRoute("Incidents memory", repository.listIncidents));

  router.post(
    "/incidents",
    asyncRoute(async (req, res) => {
      const { title } = req.body || {};
      if (!title) {
        return res.status(400).json({ error: "title is required" });
      }

      const item = await repository.createIncident(req.body);
      res.status(201).json({ item });
    }),
  );

  router.get("/services", safeReadRoute("Service memory", repository.listServiceFacts));

  router.post(
    "/services",
    asyncRoute(async (req, res) => {
      const { serviceName, factKey } = req.body || {};
      if (!serviceName || !factKey) {
        return res.status(400).json({ error: "serviceName and factKey are required" });
      }

      const item = await repository.upsertServiceFact(req.body);
      res.status(201).json({ item });
    }),
  );

  router.get("/audit", safeReadRoute("Audit memory", repository.listAudit));

  router.get(
    "/patch-proposals",
    asyncRoute(async (_req, res) => {
      const items = await listPatchProposals(memoryRoot);
      res.json({ items, degraded: false });
    }),
  );

  router.get(
    "/patch-proposals/:name",
    asyncRoute(async (req, res) => {
      const item = await readPatchProposal(req.params.name, memoryRoot);
      res.json({ item, degraded: false });
    }),
  );

  router.post(
    "/patch-proposals/:name/apply",
    asyncRoute(async (req, res) => {
      requireConfirmedAction(req, "Applying a memory patch proposal");
      const proposalName = normalizeProposalName(req.params.name);
      if (!proposalName) {
        proposalPathForName(req.params.name, memoryRoot);
      }

      let applyResult;
      try {
        applyResult = await applyPatchProposal(proposalName, memoryRoot);
      } catch (error) {
        const safeError = safeActionError(error, "Patch proposal could not be applied.");
        return res.status(error?.statusCode || 500).json({ ok: false, error: safeError });
      }

      let reviewed = null;
      let archiveError = null;
      try {
        reviewed = await moveProposalToReviewed(proposalName, "applied", memoryRoot);
      } catch (error) {
        archiveError = safeActionError(error, "Patch proposal was applied, but could not be moved to reviewed_patches.");
      }

      res.json({
        ok: true,
        status: "applied",
        proposal: proposalName,
        touchedFiles: applyResult?.touchedFiles || [],
        reviewed,
        archiveError,
      });
    }),
  );

  router.post(
    "/patch-proposals/:name/neutralize",
    asyncRoute(async (req, res) => {
      requireConfirmedAction(req, "Neutralizing a memory patch proposal");
      const reviewed = await moveProposalToReviewed(req.params.name, "neutralized", memoryRoot);
      res.json({
        ok: true,
        status: "neutralized",
        proposal: normalizeProposalName(req.params.name),
        reviewed,
      });
    }),
  );

  router.post(
    "/audit",
    asyncRoute(async (req, res) => {
      const { actionType, target } = req.body || {};
      if (!actionType || !target) {
        return res.status(400).json({ error: "actionType and target are required" });
      }

      const item = await repository.createAudit(req.body);
      res.status(201).json({ item });
    }),
  );

  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
module.exports.publicMemoryHealth = publicMemoryHealth;
