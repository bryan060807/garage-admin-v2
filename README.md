# Garage Admin V2

Minimal ops UI with:

- React/Vite frontend
- Node/Express backend orchestrator
- Postgres-backed external memory
- env-driven bridge client for the existing AIBRY TaskMaster admin bridge

## Structure

- `frontend/` React UI
- `backend/` API server and bridge client
- `db/schema.sql` Postgres schema

## Environment

Copy `.env.example` to `.env` in the repo root and set values for your environment.
`GARAGE_ADMIN_DATABASE_URL` takes precedence over `DATABASE_URL` when both are set.

Required:

- `GARAGE_ADMIN_DATABASE_URL` preferred, or `DATABASE_URL`
- `ADMIN_BRIDGE_BASE_URL`

Optional:

- `ADMIN_BRIDGE_TOKEN`
- `GARAGE_ADMIN_DATABASE_HOST`
- `GARAGE_ADMIN_DATABASE_PORT`
- `DATABASE_HOST`
- `DATABASE_PORT`
- `HOST`
- `PORT`
- `FRONTEND_ORIGIN`
- `ADMIN_BRIDGE_TIMEOUT_MS`
- `ADMIN_BRIDGE_ACTION_TIMEOUT_MS`
- `WINDOWS_ADMIN_BASE_URL`
- `WINDOWS_ADMIN_AUTH_TOKEN`
- `WINDOWS_GARAGE_BASE_URL`
- `WINDOWS_GARAGE_LOOPBACK_BASE_URL`
- `WINDOWS_GARAGE_API_KEY`
- `WINDOWS_BRIDGE_TIMEOUT_MS`
- `WINDOWS_EXECUTOR_TIMEOUT_MS`
- `WINDOWS_VERIFICATION_TIMEOUT_MS`
- `VITE_ENABLE_EXPERIMENTAL_LAYOUT_CUSTOMIZATION`

## Install

```powershell
cd C:\Users\bryan\aibry\projects\garage-admin-v2
npm install
```

## Apply schema

```bash
npm run db:schema
```

## Run in development

```powershell
npm run dev
```

This starts:

- backend on `http://127.0.0.1:3010`
- frontend on `http://127.0.0.1:5173`

The frontend proxies `/api/*` to the backend in development.

## Production-style Windows runtime

The production runtime uses the existing Express backend as both:

- the API server
- the static server for the built frontend in `frontend/dist`

This means there is one durable process to keep alive. Vite is only used for development and build output.

First build:

```powershell
npm run build
```

Run without a process manager:

```powershell
npm run start:backend
```

Open the UI at:

```text
http://127.0.0.1:3010
```

The backend health response includes `frontendDistReady`; it should be `true` after `npm run build`.

```powershell
Invoke-RestMethod http://127.0.0.1:3010/health
```

### PM2 runtime

PM2 is the recommended Windows process manager for this repo. Install it once if it is not already available:

```powershell
npm install -g pm2
```

Start or recover the app:

```powershell
npm run runtime:start
```

Restart after code changes:

```powershell
npm run runtime:restart
```

Inspect status and logs:

```powershell
npm run runtime:status
npm run runtime:logs
```

Stop or remove the PM2 process:

```powershell
npm run runtime:stop
npm run runtime:delete
```

Save the current PM2 process list after a successful start:

```powershell
npm run runtime:save
```

`ecosystem.config.cjs` runs `backend/src/server.js` as `garage-admin-v2` with `NODE_ENV=production`, explicit `PORT=3010`, `autorestart`, restart delay, and memory restart protection. Runtime config still comes from process env, `.env`, and backend defaults; the default app port is `3010`.

### Startup and recovery checklist

Use this sequence after a Windows reboot, dependency update, or runtime repair:

```powershell
cd C:\Users\bryan\aibry\projects\garage-admin-v2
npm install
npm run db:schema
npm run build
npm run runtime:start
Invoke-RestMethod http://127.0.0.1:3010/health
pm2 status garage-admin-v2
```

After the health response shows `ok: true` and `frontendDistReady: true`, save
the PM2 process list:

```powershell
npm run runtime:save
pm2 jlist
```

`pm2 jlist` should include exactly one `garage-admin-v2` entry with
`pm2_env.status` set to `online`. To validate recovery from the saved list
without changing app data:

```powershell
pm2 delete garage-admin-v2
pm2 resurrect
pm2 status garage-admin-v2
Invoke-RestMethod http://127.0.0.1:3010/health
```

If resurrect does not restore the process, run `npm run runtime:start`, re-check
health, then run `npm run runtime:save` again.

Useful scripts:

- `npm run build` builds `frontend/dist`
- `npm run start:backend` starts the production backend/static server
- `npm run start:static` starts the same production static server path; the backend owns static UI serving
- `npm run start:prod` builds then starts the backend/static server
- `npm run runtime:start` builds then starts PM2
- `npm run runtime:restart` rebuilds then restarts PM2 with updated env
- `npm run runtime:save` saves the PM2 process list after startup

## API endpoints

- `GET /health`
- `GET /api/memory/incidents`
- `POST /api/memory/incidents`
- `GET /api/memory/services`
- `POST /api/memory/services`
- `GET /api/memory/audit`
- `POST /api/memory/audit`
- `GET /api/services`
- `GET /api/bridge/health`
- `GET /api/bridge/logs/:service`
- `GET /api/windows-bridge/health`
- `GET /api/windows-bridge/services/:service/status`
- `GET /api/windows-bridge/repos`
- `GET /api/windows-bridge/repos/status`
- `GET /api/windows-bridge/memory/self-check`
- `POST /api/actions`
- `POST /api/actions/:id/approve`
- `POST /api/actions/:id/execute`
- `POST /api/actions/restart-service` compatibility route

## Workflow

- Services are loaded from unified bridge discovery plus memory history, then the first available service is selected automatically.
- `/api/services` also layers in a Windows runtime inventory for known PM2-managed app hosts so operators can see runtime metadata even when Fedora bridge discovery is sparse.
- Select a service in the left sidebar to load and view its logs in the right panel.
- Click an incident to focus its `serviceName`, highlight the incident, and show incident details in the right panel.

## Windows Hosting Inventory

- The first-pass Windows hosting inventory is defined in `backend/src/lib/windowsInventory.js`.
- Current inventory entries cover `taskmaster-api`, `taskmaster-app`, `chordmaster-api`, `chordmaster-ui` (canonical service key `chordmaster-app`), `garage-admin-v2`, `aibry-masterclass-landing`, `trackmaster-api`, `trackmaster-ui`, and `trackmaster-comparator`.
- Each inventory-backed `/api/services` record now includes:
  - `inventory` for host, manager, PM2 process name, local port, local URL, local health URL when available, public URL when known, and notes
  - `inventory.localReadinessUrl` when the service exposes a distinct readiness endpoint
  - `runtime` for PM2 status, uptime, restart count, memory, CPU, pid, and PM2 id when available
  - `health.checks` for read-only local HTTP and local port probes
- Public URLs are exposed as metadata only in this first pass. Garage Admin V2 does not modify Fedora nginx or Cloudflare routes from Windows.

### TrackMaster final state

- TrackMaster main runtime now lives on Windows PM2 as `trackmaster-api` and `trackmaster-ui`.
- TrackMaster Comparator remains a separate Windows PM2 service and is not the main TrackMaster runtime.
- Fedora remains responsible for Postgres, Cloudflare ingress/front-door, backups, and control-plane duties.
- Public routing now sends `https://trackmaster.aibry.shop/` to the Windows UI and sends `https://trackmaster.aibry.shop/api/*` plus `https://trackmaster-api.aibry.shop/api/*` to the Windows API.
- TrackMaster API health stays on `http://127.0.0.1:3004/api/health`; readiness stays on `http://127.0.0.1:3004/api/readiness`.
- The current TrackMaster database role is still `aibry` pending least-privilege hardening. Review-only notes live in `docs/trackmaster-runtime-status.md` and `docs/trackmaster-postgres-role-plan.sql`.

### Adding a Windows-hosted app safely

- Add an explicit entry in `backend/src/lib/windowsInventory.js` with the PM2 process name, local port, URLs, and operator notes.
- Keep `restartSupported` set to `false` by default. Only enable it after the PM2 name and restart behavior have been confirmed on the Windows host.
- Do not add generic shell execution. All restart behavior must stay inside the PM2 allowlist used by `backend/src/lib/windowsExecutor.js`.
- Prefer local read-only checks first. Add a dedicated health URL only if the runtime already exposes one.

## Windows Bridge Evidence

- Garage Admin V2 now includes a read-only Windows bridge evidence surface for Windows runtime visibility.
- The frontend calls Garage Admin V2 backend routes only. It does not call `windows-admin` or `windows-garage` hostnames directly.
- Windows bridge credentials stay backend-only through `WINDOWS_ADMIN_AUTH_TOKEN` and `WINDOWS_GARAGE_API_KEY`.
- `WINDOWS_ADMIN_BASE_URL` should target the Windows admin bridge on `127.0.0.1:3105` from this Windows runtime. The public `windows-admin.aibry.shop` Cloudflare Tunnel must also target `127.0.0.1:3105`; an unauthenticated `GET /admin/health` through that hostname is expected to return `401`.
- `WINDOWS_GARAGE_BASE_URL` should target the local Windows Garage API helper on `127.0.0.1:5100`. Do not route `windows-admin.aibry.shop` to this port.
- Windows Garage helper calls may retry `WINDOWS_GARAGE_LOOPBACK_BASE_URL` for route-level upstream `not_found` responses, keeping same-host memory probes off the public tunnel path.
- `WINDOWS_ADMIN_BASE_URL` and `WINDOWS_GARAGE_BASE_URL` must target Windows helper services, not Garage Admin V2 `/api/windows-bridge` routes; self-referential bridge URLs are rejected before any upstream request to prevent recursive local timeouts.
- The Windows Garage API helper should run under PM2 with Waitress on `127.0.0.1:5100`. Repeated Flask development-server startup banners in PM2 logs indicate the helper is being launched through the Flask built-in server instead of the production WSGI runner.
- Cloudflare WARP is not required for these Windows bridge checks. Keep routing simple: Windows loopback for local helper calls, Cloudflare Tunnel only for intended public ingress.
- The first-pass route family is intentionally narrow:
  - `GET /api/windows-bridge/health`
  - `GET /api/windows-bridge/services/:service/status`
  - `GET /api/windows-bridge/repos`
  - `GET /api/windows-bridge/repos/status`
  - `GET /api/windows-bridge/memory/self-check`
- Service status lookups are allowlisted and read-only. Repo visibility and memory self-check evidence are summary-only.
- Restart, write, repair, rebuild, log-tail, approval, and other state-changing Windows actions remain out of scope for this bridge slice and must stay in the existing Service Actions workflow when supported.

## Actions

- `fetch-logs`, `health-check`, and `restart-service` actions are stored in `action_audit`.
- Read-only actions are created as `approved` and can be executed directly.
- `restart-service` is created as `pending`, then must be approved before execution.
- Fedora-hosted restarts execute through the Fedora bridge.
- Windows-hosted restarts execute locally on the Windows operator host through a narrow PM2 allowlist.
- Current Windows restart allowlist: `taskmaster-api`, `taskmaster-app`, `aibry-masterclass-landing`, `trackmaster-api`, `trackmaster-ui`, and `trackmaster-comparator`.
- Current Windows read-only runtimes: `chordmaster-api`, `chordmaster-ui` / `chordmaster-app`, and `garage-admin-v2`.
- Successful Windows-hosted restarts include bounded verification: local HTTP where a health or local URL is modeled, otherwise PM2 process state.
- Execution records executor results in the audit row and refreshes service state from unified discovery.
- Unsupported restart targets are stored as structured failed action results.

## Action History

- All actions are recorded in audit history.
- Pending actions are stored but not executed.
- Completed and failed actions include results from the executed host-specific executor call.
- The UI supports filtering by selected service, manual refresh, compact result summaries, and inline inspection of input and result details.
- Operators can copy visible log output, copy the latest visible action result, and copy expanded audit input/result JSON.

## Experimental Layout Customization

Set `VITE_ENABLE_EXPERIMENTAL_LAYOUT_CUSTOMIZATION=true` before building the frontend to enable the bounded right-column layout experiment. When enabled, operators can move the `Actions` and `Recent Audit` cards within the right-side zone, keep using the vertical splitter, and use `Reset layout` to clear saved layout preferences and restore the default order and split.

The experiment stores preferences in `localStorage` under `garage-admin-v2:experimental-layout:v1`. Leave the flag unset or set it to `false`, then rebuild, to return to the stable layout controls without the reorder/reset UI.

## Windows Restart Live Validation

Before live validation, confirm Garage Admin V2 is running on the Windows operator host and PM2 has `taskmaster-api` and `taskmaster-app` in its process list.

For `taskmaster-api`:

1. Select `taskmaster-api` in the service list.
2. Enter `Requested by` and `Approved by`.
3. Create, approve, and execute a `Restart service` action.
4. Success looks like action status `completed`, executor `windows-local`, result code `windows_restart_completed`, and verification `verified` with `HTTP health · HTTP 200`.

For `taskmaster-app`:

1. Select `taskmaster-app` in the service list.
2. Enter `Requested by` and `Approved by`.
3. Create, approve, and execute a `Restart service` action.
4. Success looks like action status `completed`, executor `windows-local`, result code `windows_restart_completed`, and verification `verified` with `PM2 status · PM2 online`.

If verification fails while the restart command completed, the action remains `completed` and the UI shows `verify failed`. Inspect the expanded audit result for `verification.error`, then run a health check or inspect logs. Fedora-hosted services should continue to show bridge-backed results instead of `windows-local` verification.

## Chat Suggestions

- Chat analyzes current context including selected service, incident, logs, and recent audit history.
- It provides summaries and recommended next steps.
- Chat does not execute actions.
- Suggested actions must still be reviewed and approved in the Actions panel.

## ChatKit Readiness

- ChatKit is an assistant surface only. It must not execute actions, approve actions, restart services, write files, run shell commands, call workers for state changes, or bypass Service Actions.
- The backend readiness routes are:
  - `GET /api/chatkit/status`
  - `POST /api/chatkit/proof-of-life`
  - `POST /api/chatkit/session` when backend-only ChatKit configuration is complete
- `GET /api/chatkit/status` returns only operator-safe readiness metadata such as `mode`, `availability`, `missingConfig`, `checkedAt`, and a clear reason. It never returns env values, API keys, workflow internals, or session payloads.
- Required backend env names for hosted sessions:
  - `CHATKIT_EXPERIMENTAL_ENABLED=true`
  - `OPENAI_API_KEY`
  - `OPENAI_CHATKIT_WORKFLOW_ID`
  - `CHATKIT_SESSION_TIMEOUT_MS` optional timeout override for the server-side session request
- The frontend receives only a short-lived `client_secret` from the backend session route. Provider credentials stay backend-only.
- Local validation commands for this slice:
  - `node --check backend/src/server.js`
  - `node --check backend/src/routes/chatkit.js`
  - `node frontend/scripts/diagnostics-smoke.mjs`
  - `npm run build`
- If you update ChatKit env vars for the Windows PM2 runtime, refresh the process environment before re-checking readiness:
  - `pm2 restart garage-admin-v2 --update-env`
- Deliberately not enabled in this pass:
  - ChatKit tools/actions
  - Service Action execution or approval
  - worker job execution
  - file uploads/writes
  - shell execution
  - restart paths
  - browser-side secrets or direct bridge calls

## Fedora Worker Service-Name Contract

- `fedora-infra` `systemd_status` is a read-only Fedora control-plane check. Treat it as a narrow allowlisted contract, not an arbitrary `systemctl` wrapper.
- Current local runbooks and worker notes point to Fedora user-unit style names, not broad system service discovery.
- Use base service names without `.service` unless the Fedora worker explicitly advertises another format.
- Documented Fedora user-unit names already evidenced in local runbooks:
  - `admin-proxy`
  - `aibry-admin`
  - `aibry-node-agent`
  - `garage-bridge` when present
  - `aibry-fedora-worker-agent`
  - `aibry-worker-bootstrap`
  - `aibry-fedora-repo-worker`
- Do not assume host-level pulse labels are valid `systemd_status` targets. `system_pulse` may report broader host facts such as `sshd`, `docker`, or `podman`, but that does not prove `systemd_status` accepts those names.
- Until the Fedora helper advertises an explicit allowlist through capabilities, operators should treat `docker`, `podman`, `sshd`, `nginx`, `cloudflared`, and `postgresql` as out of contract for `systemd_status` unless separately verified on the Fedora side.
- Why `node-agent` probes likely failed: local Fedora runbooks refer to the user unit as `aibry-node-agent`, so the shorter label is likely not the accepted target name for `systemd_status`.

## Notes

- No secrets are hardcoded.
- The bridge client uses `ADMIN_BRIDGE_BASE_URL` and `ADMIN_BRIDGE_TOKEN`.
- The backend stores action audit records for traceability.
- Destructive restart actions are approval-aware by design and are routed to the host-specific executor.
