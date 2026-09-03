param(
  [int]$Port = 0,
  [switch]$Start
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = Join-Path $scriptDir "scripts/setup.ps1"

$forward = @()
if ($Port -gt 0) { $forward += @("-Port", $Port) }
if ($Start) { $forward += "-Start" }

& $target @forward
exit $LASTEXITCODE
