# AGENTS.md — Garage Admin V2

## Project Role

Garage Admin V2 is the AIBRY operator console.

It is a control plane first and assistant second. The UI should help operators inspect services, understand evidence, review risk, and route state-changing work through explicit Service Actions and approval gates.

Do not turn chat, ChatKit, workers, or helper routes into a privileged shortcut around the existing safety model.

## Host Split

AIBRY uses a split-host model:

```txt
Fedora = infrastructure/control-plane host
Windows = app/runtime/operator host
```

Fedora owns:

- PostgreSQL
- durable storage
- Cloudflare ingress/tunnel routing
- nginx/front-door routing where applicable
- admin-proxy
- aibry-admin
- node-agent
- systemd/Podman/Docker infrastructure
- backups and rollback artifacts
- Fedora worker services

Windows owns:

- Garage Admin V2 frontend/backend/operator UI
- PM2-managed app runtimes
- migrated app/API/UI processes where applicable
- Windows runtime worker

Do not blur Fedora and Windows responsibilities.

## Current Worker Registry

Garage Admin V2 currently has four registered workers:

```txt
windows-runtime
fedora-infra
fedora-bootstrap
fedora-repo
```

Fedora workers remain localhost-bound on Fedora and are reached through the guarded Fedora helper/proxy path.

Do not bind Fedora worker ports to LAN.

Do not expose bootstrap create in the Garage Admin V2 UI.

## Safety Rules

Prefer read-only diagnostics before state changes.

Do not add:

- shell execution
- arbitrary command execution
- arbitrary path input
- file writes
- deletes
- restarts
- repairs
- migrations
- rebuilds
- podman/docker/systemctl/pm2 actions
- bootstrap create
- action approval from chat
- Service Action bypasses

State-changing operations must remain inside existing Service Actions with:

- action risk classification
- approval gates
- freshness gates
- audit/history records

Unsupported actions must remain blocked.

## Secrets Policy

Never expose, log, commit, render, or pass to the frontend:

- `.env` files
- API keys
- database passwords
- Cloudflare Access credentials
- AIBRY auth tokens
- worker auth tokens
- OAuth access tokens
- OAuth refresh tokens
- private keys/certificates

Provider OAuth tokens must stay server-side only and encrypted when implemented.

Do not put secrets in docs, test fixtures, frontend state, localStorage, screenshots, logs, or committed files.

## Worker-Agent Boundaries

Workers are read-only evidence collectors.

Workers may collect bounded evidence such as:

- health
- capabilities
- service status
- PM2 summaries
- git status
- git diff stats
- package scripts
- syntax checks
- capped logs
- public route smoke checks

Workers must not become general shell executors.

Workers must preserve:

- token authentication
- localhost/private binding
- sensitive path blocking
- output caps
- structured errors
- redaction

## Repository Evidence View Rules

For Repository Evidence work, use existing worker routes where possible:

```txt
GET /api/workers
GET /api/workers/:id/health
GET /api/workers/:id/capabilities
POST /api/workers/:id/jobs
```

Use `fedora-repo` for Fedora repo evidence.

Initial fixed safe targets:

```txt
/home/aibry/projects/aibry-worker-bootstrap
/home/aibry/projects/aibry-worker-bootstrap/src/server.js
/home/aibry/projects/aibry-fedora-repo-worker
/home/aibry/projects/aibry-fedora-repo-worker/src/server.js
```

Allowed evidence types:

```txt
health
capabilities
git_status
git_diff_stat
package_scripts
node_check
```

Do not expose `npm_build` as a UI action.

Do not add arbitrary path input in v1.

Show provenance:

- worker id
- task type
- repo/file target
- timestamp
- freshness/status

## Assistant and ChatKit Boundaries

The assistant may:

- explain selected service context
- summarize diagnosis/log/freshness evidence
- build operator plans
- suggest read-only checks
- deep-link or guide to existing UI workflows

The assistant must not:

- execute actions
- approve actions
- restart services
- write files
- run shell commands
- bypass Service Actions
- expose secrets
- invent logs/status/paths

ChatKit, if added, is an assistant surface only. It is not the control plane.

## Development Style

Prefer targeted changes over broad rewrites.

Follow existing Garage Admin V2 house style.

Reuse existing frontend/backend patterns before adding new architecture.

Keep UI evidence-first and operator-oriented.

Keep chat helpful but subordinate to the dashboard.

Preserve structured errors.

## Validation

Run relevant checks before reporting success.

Common commands:

```bash
npm run build
node frontend/scripts/diagnostics-smoke.mjs
```

For backend files changed:

```bash
node --check backend/src/server.js
node --check backend/src/routes/workers.js
node --check backend/src/workerRegistry.js
```

For new or changed frontend utility files:

```bash
node --check path/to/file.js
```

`node --check frontend/src/App.jsx` may not work depending on Node/JSX handling. Use Vite build for JSX parsing.

## Live Validation

When applicable and safe, verify read-only routes:

```txt
GET /api/workers
GET /api/workers/fedora-repo/health
GET /api/workers/fedora-repo/capabilities
POST /api/workers/fedora-repo/jobs
```

Negative validation should confirm sensitive paths such as `.env` remain blocked.

Do not run live restart/approve/execute/destructive calls during routine UI work.

## Commit Hygiene

Do not commit:

- `.env`
- `.env.*`
- `node_modules`
- unintended `dist` or build churn
- logs
- raw worker outputs
- screenshots unless intentionally needed
- temporary browser profiles
- secrets
- Cloudflare credentials
- OAuth credentials
- control-plane credentials

Suggested commit messages should be specific and safety-aware.

## Suggested Codex Subagent Roles

For non-trivial tasks, use subagents.

### code_mapper

Read-only. Inspect existing files and identify insertion points and house style.

### safety_reviewer

Read-only. Identify guardrails, risky routes, secret exposure risks, and negative tests.

### implementer

Wait for mapper/reviewer results. Make the smallest targeted change.

### validator

Run checks, summarize pass/fail, and identify unverified manual steps.

## Current Next Slice

Current top product slice:

```txt
Add Repository Evidence view using the registered fedora-repo worker.
```

Keep it read-only, fixed-target, provenance-rich, and visibly separate from Service Actions.
