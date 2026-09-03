param(
  [int]$Port = 0,
  [switch]$Start
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Resolve-Path (Join-Path $scriptDir "..")
Set-Location $rootDir

if (!(Test-Path "package.json") -or !(Test-Path "scripts/setup-wizard.mjs")) {
  throw "Run this script from the OctoOffice repository."
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js 22+ is required. Install from https://nodejs.org/"
}

$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 22) {
  throw "Node.js 22+ is required. Current: $(node -v)"
}

if (-not (Get-Command corepack -ErrorAction SilentlyContinue)) {
  throw "corepack is required (bundled with Node.js)."
}

corepack enable | Out-Null
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  corepack prepare pnpm@latest --activate | Out-Null
}

Write-Host "[OctoOffice] Installing dependencies..."
pnpm install

$wizardArgs = @()
if ($Port -gt 0) {
  $wizardArgs += @("--port", $Port.ToString())
}

node scripts/setup-wizard.mjs @wizardArgs

if ($Start) {
  Write-Host "[OctoOffice] Starting development server..."
  pnpm dev:local
  exit $LASTEXITCODE
}
