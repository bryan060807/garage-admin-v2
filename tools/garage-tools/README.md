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

`Restart-GarageService` is intentionally scoped to a service name and calls only `POST /admin/restart-service`. The module does not expose arbitrary command execution, file writes, shell access, or generic admin endpoints.

## Current Control-Plane Endpoints

- `GET /admin/health`
- `GET /admin/services`
- `GET /admin/logs/:service`
- `POST /admin/restart-service`

The Fedora bridge remains responsible for authentication, authorization, and service allowlisting.
