Set-StrictMode -Version Latest

$script:DefaultTimeoutSec = 30

function Join-GarageUrl {
  param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$BaseUrl,

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$Path
  )

  $normalizedBaseUrl = $BaseUrl.Trim().TrimEnd([char]"/")
  $normalizedPath = $Path.Trim()

  if (-not $normalizedPath.StartsWith("/")) {
    $normalizedPath = "/$normalizedPath"
  }

  return "$normalizedBaseUrl$normalizedPath"
}

function Get-GarageHttpErrorDetail {
  param(
    [Parameter(Mandatory)]
    [System.Management.Automation.ErrorRecord]$ErrorRecord,

    [Parameter(Mandatory)]
    [string]$Path
  )

  $statusCode = $null
  $responseBody = ""
  $apiError = $null
  $response = $null

  try {
    $response = $ErrorRecord.Exception.Response
  } catch {
    $response = $null
  }

  if ($null -ne $response) {
    try {
      $statusCode = [int]$response.StatusCode
    } catch {
      $statusCode = $null
    }

    try {
      if ($null -ne $response.Content) {
        $responseBody = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      }
    } catch {
      $responseBody = ""
    }
  }

  if ([string]::IsNullOrWhiteSpace($responseBody)) {
    try {
      if ($null -ne $ErrorRecord.ErrorDetails -and -not [string]::IsNullOrWhiteSpace($ErrorRecord.ErrorDetails.Message)) {
        $responseBody = $ErrorRecord.ErrorDetails.Message
      }
    } catch {
      $responseBody = ""
    }
  }

  if ($null -eq $statusCode) {
    try {
      if ($null -ne $ErrorRecord.Exception.StatusCode) {
        $statusCode = [int]$ErrorRecord.Exception.StatusCode
      }
    } catch {
      $statusCode = $null
    }
  }

  if (-not [string]::IsNullOrWhiteSpace($responseBody)) {
    try {
      $apiError = $responseBody | ConvertFrom-Json -ErrorAction Stop
    } catch {
      $apiError = $null
    }
  }

  $prefix = if ($statusCode) { "Garage request failed with HTTP $statusCode for $Path." } else { "Garage request failed for $Path." }

  $guidance = switch ($statusCode) {
    401 { "Check AIBRY_AUTH_TOKEN and the Cloudflare Access client credentials." }
    403 { "The control plane rejected the request. Verify Cloudflare Access policy and token permissions." }
    404 { "The endpoint was not found. Verify AIBRY_ADMIN_BASE_URL and that the Fedora bridge exposes this route." }
    { $_ -ge 500 } { "The Fedora control plane returned a server error. Check aibry-admin bridge health and logs." }
    default { "Check network connectivity, base URL, and required environment variables." }
  }

  $parts = @($prefix)

  if ($null -ne $apiError) {
    $fieldMap = [ordered]@{
      code        = @("code", "error", "type")
      serviceName = @("serviceName", "service_name", "service")
      host        = @("host", "targetHost", "target_host")
      message     = @("message", "detail", "reason")
    }

    foreach ($field in $fieldMap.GetEnumerator()) {
      foreach ($candidateName in $field.Value) {
        if ($apiError.PSObject.Properties.Name -contains $candidateName) {
          $candidateValue = $apiError.$candidateName

          if ($null -ne $candidateValue -and -not [string]::IsNullOrWhiteSpace([string]$candidateValue)) {
            $parts += "$($field.Key): $candidateValue"
            break
          }
        }
      }
    }

    if ($parts.Count -eq 1) {
      $parts += "apiError: $($apiError | ConvertTo-Json -Depth 10 -Compress)"
    }

    return [pscustomobject]@{
      Message = ($parts -join " ")
      StatusCode = $statusCode
      ApiError = $apiError
      ResponseBody = $responseBody
    }
  }

  if (-not [string]::IsNullOrWhiteSpace($responseBody)) {
    return [pscustomobject]@{
      Message = "$prefix $guidance Response: $responseBody"
      StatusCode = $statusCode
      ApiError = $null
      ResponseBody = $responseBody
    }
  }

  return [pscustomobject]@{
    Message = "$prefix $guidance"
    StatusCode = $statusCode
    ApiError = $null
    ResponseBody = ""
  }
}

function New-GarageApiException {
  param(
    [Parameter(Mandatory)]
    [pscustomobject]$ErrorDetail,

    [Parameter(Mandatory)]
    [System.Exception]$InnerException
  )

  $exception = [System.InvalidOperationException]::new($ErrorDetail.Message, $InnerException)
  $exception.Data["GarageStatusCode"] = $ErrorDetail.StatusCode
  $exception.Data["GarageResponseBody"] = $ErrorDetail.ResponseBody

  if ($null -ne $ErrorDetail.ApiError) {
    $exception.Data["GarageApiError"] = $ErrorDetail.ApiError
  }

  return $exception
}

<#
.SYNOPSIS
Reads Garage Admin control-plane configuration from environment variables.

.DESCRIPTION
Get-GarageConfig resolves the base URL and authentication settings used by the
Garage tools module. AIBRY_ADMIN_BASE_URL is preferred for the base URL, with
GARAGE_ADMIN_BASE_URL supported as a fallback alias. The resolved base URL is
trimmed of trailing slashes.

.EXAMPLE
Get-GarageConfig

Returns the resolved base URL and credentials currently available in the
PowerShell process environment.
#>
function Get-GarageConfig {
  [CmdletBinding()]
  param()

  $baseUrl = $env:AIBRY_ADMIN_BASE_URL

  if ([string]::IsNullOrWhiteSpace($baseUrl)) {
    $baseUrl = $env:GARAGE_ADMIN_BASE_URL
  }

  $config = [pscustomobject]@{
    BaseUrl               = if ($baseUrl) { $baseUrl.Trim().TrimEnd([char]"/") } else { "" }
    CfAccessClientId      = $env:AIBRY_CF_ACCESS_CLIENT_ID
    CfAccessClientSecret  = $env:AIBRY_CF_ACCESS_CLIENT_SECRET
    AuthToken             = $env:AIBRY_AUTH_TOKEN
  }

  $missing = @()

  if ([string]::IsNullOrWhiteSpace($config.BaseUrl)) {
    $missing += "AIBRY_ADMIN_BASE_URL or GARAGE_ADMIN_BASE_URL"
  }

  if ([string]::IsNullOrWhiteSpace($config.CfAccessClientId)) {
    $missing += "AIBRY_CF_ACCESS_CLIENT_ID"
  }

  if ([string]::IsNullOrWhiteSpace($config.CfAccessClientSecret)) {
    $missing += "AIBRY_CF_ACCESS_CLIENT_SECRET"
  }

  if ([string]::IsNullOrWhiteSpace($config.AuthToken)) {
    $missing += "AIBRY_AUTH_TOKEN"
  }

  if ($missing.Count -gt 0) {
    throw [System.InvalidOperationException]::new(
      "Garage admin configuration is incomplete. Set: $($missing -join ', ')."
    )
  }

  $baseUri = $null
  if (-not [System.Uri]::TryCreate($config.BaseUrl, [System.UriKind]::Absolute, [ref]$baseUri)) {
    throw [System.InvalidOperationException]::new(
      "Garage admin base URL '$($config.BaseUrl)' is not an absolute URL."
    )
  }

  if ($baseUri.Scheme -notin @("http", "https")) {
    throw [System.InvalidOperationException]::new(
      "Garage admin base URL must use http or https. Current scheme: '$($baseUri.Scheme)'."
    )
  }

  return $config
}

<#
.SYNOPSIS
Builds authenticated headers for Garage Admin control-plane requests.

.DESCRIPTION
Get-GarageHeaders returns the HTTP headers required for the current Fedora
admin/control-plane endpoints. It reads configuration from Get-GarageConfig
unless a config object is supplied.

.PARAMETER Config
Optional config object returned by Get-GarageConfig.

.EXAMPLE
Get-GarageHeaders

Returns a hashtable with Cloudflare Access headers and x-aibry-auth.
#>
function Get-GarageHeaders {
  [CmdletBinding()]
  param(
    [Parameter()]
    [pscustomobject]$Config
  )

  if ($null -eq $Config) {
    $Config = Get-GarageConfig
  }

  return @{
    "CF-Access-Client-Id"      = $Config.CfAccessClientId
    "CF-Access-Client-Secret"  = $Config.CfAccessClientSecret
    "x-aibry-auth"             = $Config.AuthToken
  }
}

<#
.SYNOPSIS
Invokes an authenticated Garage Admin control-plane API request.

.DESCRIPTION
Invoke-GarageRequest is a thin wrapper around Invoke-RestMethod. It resolves
the configured base URL, applies Garage control-plane authentication headers,
serializes JSON request bodies for POST calls, and returns parsed response
objects.

.PARAMETER Path
Control-plane path, such as /admin/health.

.PARAMETER Method
HTTP method. Supports GET and POST.

.PARAMETER Body
Optional request body. For POST requests the body is serialized as JSON.

.PARAMETER TimeoutSec
Request timeout in seconds. Defaults to 30.

.PARAMETER Config
Optional config object returned by Get-GarageConfig.

.EXAMPLE
Invoke-GarageRequest -Path /admin/health

Calls GET /admin/health and returns the parsed response object.
#>
function Invoke-GarageRequest {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$Path,

    [Parameter()]
    [ValidateSet("GET", "POST")]
    [string]$Method = "GET",

    [Parameter()]
    [object]$Body,

    [Parameter()]
    [ValidateRange(1, 300)]
    [int]$TimeoutSec = $script:DefaultTimeoutSec,

    [Parameter()]
    [pscustomobject]$Config
  )

  if ($null -eq $Config) {
    $Config = Get-GarageConfig
  }

  $uri = Join-GarageUrl -BaseUrl $Config.BaseUrl -Path $Path
  $headers = Get-GarageHeaders -Config $Config

  $request = @{
    Uri         = $uri
    Method      = $Method
    Headers     = $headers
    TimeoutSec  = $TimeoutSec
    ErrorAction = "Stop"
  }

  if ($PSBoundParameters.ContainsKey("Body")) {
    $request.Body = $Body | ConvertTo-Json -Depth 20 -Compress
    $request.ContentType = "application/json"
  }

  try {
    return Invoke-RestMethod @request
  } catch {
    $errorDetail = Get-GarageHttpErrorDetail -ErrorRecord $_ -Path $Path
    throw (New-GarageApiException -ErrorDetail $errorDetail -InnerException $_.Exception)
  }
}

<#
.SYNOPSIS
Gets health information from the AIBRY admin bridge.

.DESCRIPTION
Get-GarageHealth calls GET /admin/health through the configured authenticated
control-plane endpoint and returns the parsed response object.

.EXAMPLE
Get-GarageHealth
#>
function Get-GarageHealth {
  [CmdletBinding()]
  param()

  return Invoke-GarageRequest -Path "/admin/health" -Method "GET"
}

<#
.SYNOPSIS
Gets the live Garage service inventory.

.DESCRIPTION
Get-GarageServices calls GET /admin/services through the configured
authenticated control-plane endpoint and returns the parsed service inventory
response.

.EXAMPLE
Get-GarageServices
#>
function Get-GarageServices {
  [CmdletBinding()]
  param()

  return Invoke-GarageRequest -Path "/admin/services" -Method "GET"
}

<#
.SYNOPSIS
Gets logs for an allowlisted Garage service.

.DESCRIPTION
Get-GarageLogs calls GET /admin/logs/:service. The service name is URL-encoded
before the request is sent. The function returns the parsed response object
from the control plane.

.PARAMETER Service
Service name to fetch logs for.

.EXAMPLE
Get-GarageLogs -Service taskmaster-api

.EXAMPLE
"aibry-admin" | Get-GarageLogs
#>
function Get-GarageLogs {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory, ValueFromPipeline, ValueFromPipelineByPropertyName)]
    [Alias("Name", "ServiceName")]
    [ValidateNotNullOrEmpty()]
    [ValidatePattern("^[A-Za-z0-9._-]+$")]
    [string]$Service
  )

  process {
    $encodedService = [System.Uri]::EscapeDataString($Service)
    return Invoke-GarageRequest -Path "/admin/logs/$encodedService" -Method "GET"
  }
}

<#
.SYNOPSIS
Restarts an allowlisted Garage service through the control plane.

.DESCRIPTION
Restart-GarageService calls POST /admin/restart-service with a serviceName JSON
body. It is intentionally scoped to service restarts only and does not expose
arbitrary command execution. Use -WhatIf to preview the operation without
sending the restart request. Structured API error responses are surfaced in
the thrown exception message and attached to the exception Data as
GarageApiError.

.PARAMETER Service
Service name to restart.

.EXAMPLE
Restart-GarageService -Service taskmaster-api -WhatIf

.EXAMPLE
Restart-GarageService -Service taskmaster-api
#>
function Restart-GarageService {
  [CmdletBinding(SupportsShouldProcess = $true)]
  param(
    [Parameter(Mandatory, ValueFromPipeline, ValueFromPipelineByPropertyName)]
    [Alias("Name", "ServiceName")]
    [ValidateNotNullOrEmpty()]
    [ValidatePattern("^[A-Za-z0-9._-]+$")]
    [string]$Service
  )

  process {
    if ($PSCmdlet.ShouldProcess($Service, "Restart Garage service")) {
      return Invoke-GarageRequest -Path "/admin/restart-service" -Method "POST" -Body @{
        serviceName = $Service
      }
    }
  }
}

Export-ModuleMember -Function @(
  "Get-GarageConfig",
  "Get-GarageHeaders",
  "Invoke-GarageRequest",
  "Get-GarageHealth",
  "Get-GarageServices",
  "Get-GarageLogs",
  "Restart-GarageService"
)
