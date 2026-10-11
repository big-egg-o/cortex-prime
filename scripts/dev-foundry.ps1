<#
.SYNOPSIS
  Start the local DEVELOPMENT Foundry VTT instance (never production).

.DESCRIPTION
  Runs the Foundry V14 Node.js build with its own user data folder, on localhost,
  with UPnP and external IP discovery disabled and hot reload enabled.
  Paths can be overridden with parameters or the FOUNDRY_DEV_APP / FOUNDRY_DEV_DATA
  environment variables.

.EXAMPLE
  .\scripts\dev-foundry.ps1
  .\scripts\dev-foundry.ps1 -World cp-sandbox
#>
param(
  [string]$AppPath  = $(if ($env:FOUNDRY_DEV_APP)  { $env:FOUNDRY_DEV_APP }  else { 'D:\FoundryDev\app' }),
  [string]$DataPath = $(if ($env:FOUNDRY_DEV_DATA) { $env:FOUNDRY_DEV_DATA } else { 'D:\FoundryDev\userdata' }),
  [int]$Port = 30000,
  [string]$World
)
$ErrorActionPreference = 'Stop'

$main = Join-Path $AppPath 'main.js'
if (-not (Test-Path $main)) { throw "Foundry not found at $main (expected the V14 Node.js build here)." }

$nodeVersion = (node --version).Trim()
$nodeMajor = [int]($nodeVersion.TrimStart('v').Split('.')[0])
# Foundry 14.369 declares engines.node ">=24.13.1 <25.0.0"
if ($nodeMajor -ne 24) { throw "Foundry V14 requires Node.js 24.x (>=24.13.1); found $nodeVersion." }

New-Item -ItemType Directory -Force -Path $DataPath | Out-Null

$nodeArgs = @(
  $main,
  "--dataPath=$DataPath",
  "--port=$Port",
  '--noupnp',          # never ask the router to open a port
  '--noipdiscovery',   # no outbound lookup of the public IP
  '--noupdate',        # core updates are done deliberately, not automatically
  '--hotReload'        # live-reload CSS / templates / lang declared in system.json
)
if ($World) { $nodeArgs += "--world=$World" }

Write-Host "Dev Foundry  : $AppPath"
Write-Host "User data    : $DataPath"
Write-Host "Node.js      : $nodeVersion"
Write-Host "URL          : http://localhost:$Port   (Ctrl+C to stop)"
& node @nodeArgs
