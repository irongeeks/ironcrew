# Explicit Windows Hyper-V preflight/provisioning. Does not claim native Windows isolation.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$Vhdx,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$Sha256,
  [Parameter(Mandatory=$true)][string]$StateDirectory,
  [Parameter(Mandatory=$true)][string]$SwitchName,
  [ValidatePattern('^IronCrew-[A-Za-z0-9-]+$')][string]$Name = 'IronCrew-Isolated',
  [ValidateRange(8,64)][int]$MaxDiskGiB = 16,
  [switch]$Create,
  [switch]$Start
)
$ErrorActionPreference = 'Stop'
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this explicit Hyper-V operation in an elevated PowerShell.' }
Import-Module Hyper-V -ErrorAction Stop
$null = Get-VMHost
$null = Get-VMSwitch -Name $SwitchName
if ($StateDirectory -notmatch '^[A-Za-z]:\\' -or [IO.Path]::GetFullPath($StateDirectory) -eq [IO.Path]::GetPathRoot($StateDirectory)) { throw 'StateDirectory must be a new local absolute subdirectory.' }
$ancestor = [IO.Path]::GetFullPath($StateDirectory)
while ($ancestor) {
  if ((Test-Path -LiteralPath $ancestor) -and ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Reparse state ancestor rejected.' }
  $parent = Split-Path -Parent $ancestor
  if ($parent -eq $ancestor) { break }; $ancestor = $parent
}
$disk = Get-Item -LiteralPath $Vhdx
if ($disk.Extension -ne '.vhdx' -or ($disk.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'A regular, reviewed Linux VHDX is required.' }
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $Vhdx).Hash -ne $Sha256) { throw 'Linux guest image hash mismatch.' }
$image = Get-VHD -Path $disk.FullName
if ($image.Size -gt ($MaxDiskGiB * 1GB) -or $image.ParentPath) { throw 'A bounded standalone VHDX is required; differencing disks are rejected.' }
$drive = New-Object IO.DriveInfo([IO.Path]::GetPathRoot($StateDirectory))
if ($drive.AvailableFreeSpace -lt $image.Size + 1GB) { throw 'Insufficient disk space for the bounded VM.' }
if (Get-VM -Name $Name -ErrorAction SilentlyContinue) { throw 'Refusing to alter an existing VM. Manage it explicitly by name.' }
if (-not $Create) { Write-Output 'Preflight passed. No VM created. Add -Create, optionally -Start.'; exit 0 }
if (Test-Path -LiteralPath $StateDirectory) { throw 'Use a new private state directory.' }
$null = New-Item -ItemType Directory -Path $StateDirectory
$acl = Get-Acl -LiteralPath $StateDirectory
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')) {
  $identity = New-Object Security.Principal.SecurityIdentifier($sid)
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $StateDirectory -AclObject $acl
# No host directory, drive, clipboard, agent socket or credential store is shared.
$guestDisk = Join-Path $StateDirectory 'linux.vhdx'
Copy-Item -LiteralPath $Vhdx -Destination $guestDisk
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $guestDisk).Hash -ne $Sha256) { throw 'Copied Linux disk hash mismatch.' }
$created = $null
try {
  $created = New-VM -Name $Name -Generation 2 -MemoryStartupBytes 4GB -VHDPath $guestDisk -Path $StateDirectory -SwitchName $SwitchName
  Set-VMMemory -VM $created -DynamicMemoryEnabled $false -StartupBytes 4GB
  Set-VMProcessor -VM $created -Count 2 -Maximum 100
  Set-VMFirmware -VM $created -EnableSecureBoot On -SecureBootTemplate 'MicrosoftUEFICertificateAuthority'
  Set-VM -VM $created -AutomaticStartAction Nothing -AutomaticStopAction ShutDown -CheckpointType Disabled
  # Stable service identifier avoids locale-dependent names. Keep shutdown/time/heartbeat working.
  $copyService = @(Get-VMIntegrationService -VM $created | Where-Object { $_.Id -match '6C09BB55-D683-4DA0-8931-C9BF705F6480$' })
  if ($copyService.Count -ne 1) { throw 'Cannot prove guest file-copy integration is disabled.' }
  $copyService | Disable-VMIntegrationService
  if ($Start) { Start-VM -VM $created }
  @{name=$Name;id=$created.Id.ToString();imageSha256=$Sha256;maxDiskGiB=$MaxDiskGiB;cpus=2;memoryGiB=4;hostShares=@();fileCopyIntegration=$false;isolationVerified=$false} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $StateDirectory 'provision-result.json') -Encoding UTF8
} catch {
  if ($created) {
    if ((Get-VM -Id $created.Id).State -ne 'Off') { Stop-VM -VM $created -TurnOff -Force }
    Remove-VM -VM $created -Force
  }
  throw
}
Write-Output "Own Linux VM $Name created. Provision the Linux profile through explicit SSH/SCP with agent forwarding disabled. OS capability remains unverified until Linux adversarial probes pass."
