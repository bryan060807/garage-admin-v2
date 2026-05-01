@{
  RootModule = 'garage.psm1'
  ModuleVersion = '0.1.0'
  GUID = 'd23a1027-6a9e-4d29-b0f3-8cb64d4b70d8'
  Author = 'AIBRY'
  CompanyName = 'AIBRY'
  Copyright = '(c) AIBRY. All rights reserved.'
  Description = 'PowerShell 7 client for authenticated AIBRY Garage admin/control-plane APIs.'
  PowerShellVersion = '7.0'
  CompatiblePSEditions = @('Core')
  FunctionsToExport = @(
    'Get-GarageConfig',
    'Get-GarageHeaders',
    'Invoke-GarageRequest',
    'Get-GarageHealth',
    'Get-GarageServices',
    'Get-GarageLogs',
    'Restart-GarageService'
  )
  CmdletsToExport = @()
  VariablesToExport = @()
  AliasesToExport = @()
  PrivateData = @{
    PSData = @{
      Tags = @('AIBRY', 'Garage', 'Admin', 'ControlPlane')
      LicenseUri = ''
      ProjectUri = ''
      ReleaseNotes = 'Initial local Garage Admin control-plane client.'
    }
  }
}
