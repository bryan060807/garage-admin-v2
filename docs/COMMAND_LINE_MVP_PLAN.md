# Command Line MVP Plan

## Goal

Add a controlled command-launcher surface inside Garage Admin V2 that lets operators run a small allowlisted set of backend-mediated commands without exposing a raw shell or bypassing existing approval boundaries.

## MVP Shape

- Backend command registry with explicit action metadata:
  - `id`
  - `label`
  - `description`
  - `host`
  - `scope`
  - `riskLevel`
  - `params`
  - `availability`
- Backend routes:
  - `GET /api/command-line/actions`
  - `POST /api/command-line/run`
- Backend-only execution:
  - Windows bridge/helper calls stay server-side.
  - Worker auth stays server-side.
  - No arbitrary shell input, chaining, or PTY sessions.
- Frontend workspace tab:
  - action selector
  - optional parameter fields
  - run button
  - result viewer
  - recent in-session history
- Output redaction before browser responses.

## Initial Read-Only Actions

- Windows:
  - Garage Admin V2 health
  - Windows bridge health
  - Windows PM2 process list via `windows-runtime`
  - Windows repo status summary
  - memory self-check
  - allowlisted Windows service status
- Fedora:
  - system pulse via `fedora-infra`
  - container inventory via `fedora-infra`

## Implemented In Repo

- Backend:
  - allowlisted registry and execution in `backend/src/lib/commandLine.js`
  - output redaction in `backend/src/lib/outputRedaction.js`
  - route surface in `backend/src/routes/commandLine.js`
  - server mount in `backend/src/server.js`
- Frontend:
  - Command Line workspace tab mount in `frontend/src/App.jsx`
  - action launcher and result viewer in `frontend/src/CommandLinePanel.jsx`
  - styling in `frontend/src/styles.css`
- Tests:
  - route and implementation coverage in `backend/test/commandLine.test.js`
  - redaction coverage in `backend/test/outputRedaction.test.js`

## Verified Locally

- Frontend does not offer arbitrary command text entry:
  - action selection is a fixed dropdown from `GET /api/command-line/actions`
  - current parameter support is constrained to allowlisted select options
- Backend rejects:
  - missing `actionId`
  - unknown action ids
  - disabled actions
  - restart/state-changing actions without approval routing
  - invalid allowlisted select parameter values
- Output redaction runs before browser responses are returned from `runCommandAction`.
- Backend test suite passes.
- Frontend build passes.

## Live Runtime Only

- The currently running PM2 instance at `http://127.0.0.1:4010` has not been restarted as part of this verification pass.
- Live route probes against `/api/command-line/actions` and `/api/command-line/run` still depend on the running PM2 process serving the new code.
- Live Windows bridge and Fedora worker command results still depend on runtime env/auth state and worker availability.

## Manual Smoke Examples

Run these after a PM2 restart only if the running `garage-admin-v2` process has not already picked up this code.

PowerShell:

```powershell
Invoke-RestMethod http://127.0.0.1:4010/api/command-line/actions | ConvertTo-Json -Depth 8
```

```powershell
$body = @{
  actionId = "windows.garage-admin.health"
  params = @{}
} | ConvertTo-Json -Depth 8

Invoke-RestMethod http://127.0.0.1:4010/api/command-line/run `
  -Method Post `
  -ContentType "application/json" `
  -Body $body | ConvertTo-Json -Depth 10
```

`curl.exe`:

```bash
curl.exe http://127.0.0.1:4010/api/command-line/actions
```

```bash
curl.exe -X POST http://127.0.0.1:4010/api/command-line/run ^
  -H "Content-Type: application/json" ^
  -d "{\"actionId\":\"windows.garage-admin.health\",\"params\":{}}"
```

## Explicit Non-Goals For MVP

- raw PowerShell, `cmd.exe`, bash, or arbitrary shell entry
- persistent terminal sessions
- arbitrary path input
- file reads or writes
- restart or repair execution
- approval bypass
- direct browser calls to bridge/helper services
- backend-persisted command audit/history

## Phase 2 Direction

- approval-gated state-changing actions routed through existing Service Actions rules
- backend-side persisted command history
- operator/session-aware audit metadata
- streaming output for bounded long-running jobs
- saved command presets
- richer parameter schemas and validation
- memory-aware runbook links
- clearer Windows vs Fedora visual separation
- optional dry-run mode for risky workflows
