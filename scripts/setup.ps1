param(
  [int]$Port = 0,
  [switch]$Start
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Resolve-Path (Join-Path $scriptDir "..")
Set-Location $rootDir

if (!(Test-Path "package.json") -or !(Test-Path "scripts/setup-wizard.mjs")) {
  throw "Run this script from the IronCrew repository."
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js 26+ is required. Install from https://nodejs.org/"
}

$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 26) {
  throw "Node.js 26+ is required. Current: $(node -v)"
}

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  $pnpmSpec = ((Get-Content package.json -Raw | ConvertFrom-Json).packageManager -split '\+')[0]
  if (Get-Command corepack -ErrorAction SilentlyContinue) {
    corepack enable | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not enable Corepack." }
    corepack prepare $pnpmSpec --activate | Out-Null
  } elseif (Get-Command npm -ErrorAction SilentlyContinue) {
    npm install --global $pnpmSpec
  } else {
    throw "pnpm is required. Install via: npm install -g $pnpmSpec"
  }
  if ($LASTEXITCODE -ne 0) { throw "Could not install the required pnpm version." }
}

Write-Host "[IronCrew] Installing dependencies..."
pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed." }

$wizardArgs = @()
if ($Port -gt 0) {
  $wizardArgs += @("--port", $Port.ToString())
}

node scripts/setup-wizard.mjs @wizardArgs
if ($LASTEXITCODE -ne 0) { throw "Setup wizard failed." }

if ($Start) {
  Write-Host "[IronCrew] Starting development server..."
  pnpm dev:local
  exit $LASTEXITCODE
}
