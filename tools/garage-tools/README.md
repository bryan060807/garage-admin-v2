# Garage Tools PowerShell Module

`garage-tools` is a local PowerShell 7 module for calling the authenticated AIBRY Garage admin/control-plane APIs from Windows. It is intended for operator scripts and Codex-run commands that need the same small, explicit API surface.

The module talks to the existing authenticated Fedora control plane. It does not bypass Cloudflare Access, `x-aibry-auth`, or the bridge-side allowlists.

## Required Environment Variables

Set these in the PowerShell process, user environment, or a secure profile/bootstrap script:

```powershell
$env:AIBRY_ADMIN_BASE_URL = "https://admin.aibry.shop"
$env:AIBRY_CF_ACCESS_CLIENT_ID = "<cloudflare-access-client-id>"
$env:AIBRY_CF_ACCESS_CLIENT_SECRET = "<cloudflare-access-client-secret>"
$env:AIBRY_AUTH_TOKEN = "<aibry-admin-token>"
```

`GARAGE_ADMIN_BASE_URL` is also supported as a fallback alias when `AIBRY_ADMIN_BASE_URL` is not set.

## Import

From the Garage Admin V2 repo root:

```powershell
Import-Module .\tools\garage-tools\garage.psd1 -Force
```

To inspect the exported commands:

```powershell
Get-Command -Module garage
```

## Commands

```powershell
Get-GarageConfig
Get-GarageHeaders
Invoke-GarageRequest -Path /admin/health

Get-GarageHealth
Get-GarageServices
Get-GarageLogs -Service taskmaster-api

Restart-GarageService -Service taskmaster-api -WhatIf
Restart-GarageService -Service taskmaster-api
```

Structured API errors are preserved in thrown exceptions. For example:

```powershell
try {
  Restart-GarageService -Service taskmaster-api
} catch {
  $_.Exception.Message
  $_.Exception.Data["GarageApiError"]
}
```

## Expected Usage

Use `pwsh`, not Windows PowerShell 5.1, for new operator tooling:

```powershell
pwsh -NoProfile -Command "Import-Module .\tools\garage-tools\garage.psd1 -Force; Get-GarageServices"
```

`garage-tools` targets the authenticated Fedora control plane directly through `AIBRY_ADMIN_BASE_URL`. It does not use Garage Admin V2 local worker routes such as `http://127.0.0.1:3010/api/workers/...`.

If requests fail with connection-refused before any HTTP status is returned, check shell-level proxy variables first. A dead local proxy configuration such as `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` pointing at an unreachable loopback port will break `Invoke-RestMethod` even when the configured Fedora hostname and auth env vars are otherwise correct.

Safe troubleshooting points:

- Confirm only env presence, not values, for:
  - `AIBRY_ADMIN_BASE_URL`
  - `AIBRY_CF_ACCESS_CLIENT_ID`
  - `AIBRY_CF_ACCESS_CLIENT_SECRET`
  - `AIBRY_AUTH_TOKEN`
- Confirm the resolved target shape from `Get-GarageConfig`:
  - scheme
  - host
  - port
  - base path
- Check whether proxy env vars are present:
  - `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`
  - lowercase equivalents
  - `NO_PROXY`

For Windows-safe read-only Fedora evidence from the local operator host, prefer Garage Admin V2 local routes when they satisfy the task:

- `GET http://127.0.0.1:3010/api/workers`
- `GET http://127.0.0.1:3010/api/workers/fedora-infra/health`
- `GET http://127.0.0.1:3010/api/workers/fedora-repo/health`

`Restart-GarageService` is intentionally scoped to a service name and calls only `POST /admin/restart-service`. The module does not expose arbitrary command execution, file writes, shell access, or generic admin endpoints.

## Current Control-Plane Endpoints

- `GET /admin/health`
- `GET /admin/services`
- `GET /admin/logs/:service`
- `POST /admin/restart-service`

The Fedora bridge remains responsible for authentication, authorization, and service allowlisting.
