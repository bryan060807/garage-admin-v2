Set-StrictMode -Version Latest

$moduleRoot = Split-Path -Parent $PSCommandPath
$manifestPath = Join-Path $moduleRoot "garage.psd1"

Import-Module $manifestPath -Force

Write-Host "Garage control-plane health:"
Get-GarageHealth | Format-List

Write-Host ""
Write-Host "Garage services:"
$services = Get-GarageServices
$services | ConvertTo-Json -Depth 10

Write-Host ""
Write-Host "Recent logs for aibry-admin:"
Get-GarageLogs -Service "aibry-admin" | Format-List

Write-Host ""
Write-Host "Restart preview for taskmaster-api:"
Restart-GarageService -Service "taskmaster-api" -WhatIf

# To execute an allowlisted restart, remove -WhatIf:
# Restart-GarageService -Service "taskmaster-api"
