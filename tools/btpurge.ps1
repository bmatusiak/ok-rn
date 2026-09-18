<#
.SYNOPSIS
  Remove EVERY trace of one Bluetooth device from Windows, so the next pairing
  reads the device fresh instead of reusing what it cached last time.

.DESCRIPTION
  Settings -> Bluetooth -> Remove device does not do this. It drops the bond
  and leaves the PnP nodes behind - on this machine, 47 of them under
  Enum\BTHENUM, Enum\BTHLEDEVICE and Enum\BTHLE. Those nodes ARE the cached
  service list, so the next pairing re-attaches the old one and Windows never
  re-reads SDP.

  That is why a Bluetooth fix here appears to work and then breaks by itself.
  Windows reads a Classic device's SDP record once, at bond time. If the
  phone's HID record was missing at that moment, the bond is permanently a
  phone with no keyboard - and no amount of app-side fixing can add it. Pair
  again at a luckier moment and the same code suddenly "works".

  Three stores have to go, and they are cleared by different means:

    1. the PnP nodes            pnputil /remove-device, including ghosts
    2. the bond / link key      HKLM\...\BTHPORT\Parameters\Devices\<mac>,
                                which is owned by SYSTEM - Administrator is
                                NOT enough, hence the scheduled-task hop
    3. the running stack        bthserv, then the radio, so the cleared state
                                is actually re-enumerated

  Targets ONE address. Other paired devices are untouched.

.PARAMETER Address
  The device address, twelve hex digits, with or without separators.

.PARAMETER Force
  Actually do it. Without this the script only reports what it would remove.

.EXAMPLE
  powershell -File tools/btpurge.ps1 -Address 24293486EAAF
  powershell -File tools/btpurge.ps1 -Address 24293486EAAF -Force
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Address,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$mac = ($Address -replace '[^0-9A-Fa-f]', '').ToUpper()
if ($mac.Length -ne 12) { throw "Address must be 12 hex digits; got '$Address'" }

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$elevated = (New-Object Security.Principal.WindowsPrincipal $identity).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)

Write-Host ""
Write-Host "btpurge  $mac" -ForegroundColor Cyan
Write-Host ("elevated: {0}" -f $elevated)
if (-not $elevated) {
  Write-Host "  not elevated - steps 2-4 will fail. Re-run from an admin shell." -ForegroundColor Yellow
}

# ---------------------------------------------------------------- 1. PnP nodes
#
# -Class Bluetooth misses the BTHLEDEVICE nodes, which is where an LE service
# like FIDO 0xFFFD lives, so this asks by instance-id prefix and takes all of
# them - present and ghost alike. The Bluetooth BASE UUID ends in 00805F9B34FB,
# itself twelve hex digits and appearing BEFORE the device address in a service
# node's id, so it is excluded before the address is read.
$nodes = Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object {
  $_.InstanceId -match '^(BTHENUM|BTHLE|BTHLEDEVICE)\\' -and
  (($_.InstanceId.ToUpper() -replace '00805F9B34FB', '') -match $mac)
}

Write-Host ""
Write-Host ("[1/4] PnP nodes matching {0}: {1}" -f $mac, @($nodes).Count)
foreach ($n in $nodes) {
  Write-Host ("      {0,-11} {1}" -f $n.Status, $n.InstanceId)
}

if (-not $Force) {
  Write-Host ""
  Write-Host "DRY RUN - nothing was changed. Add -Force to purge." -ForegroundColor Yellow
  Write-Host "Would also delete the SYSTEM-owned bond key, restart bthserv and bounce the radio."
  exit 0
}

$removed = 0
foreach ($n in $nodes) {
  # pnputil rather than Remove-PnpDevice: it removes non-present ghosts too,
  # which is most of what is left behind after a Settings "Remove device".
  $out = & pnputil /remove-device "$($n.InstanceId)" 2>&1
  if ($LASTEXITCODE -eq 0) { $removed++ }
  else { Write-Host ("      could not remove {0}: {1}" -f $n.InstanceId, ($out -join ' ')) -ForegroundColor DarkYellow }
}
Write-Host ("      removed {0} of {1}" -f $removed, @($nodes).Count)

# ------------------------------------------------------------- 2. the bond key
#
# HKLM\SYSTEM\CurrentControlSet\Services\BTHPORT\Parameters\Devices\<mac> holds
# the link key and is owned by SYSTEM - an elevated Administrator is refused.
# A one-shot scheduled task running as SYSTEM is the way in that needs no
# external tooling (no psexec, no taking ownership of a system hive key).
$keyPath = "HKLM\SYSTEM\CurrentControlSet\Services\BTHPORT\Parameters\Devices\$($mac.ToLower())"
Write-Host ""
Write-Host "[2/4] bond key (as SYSTEM)"
Write-Host ("      {0}" -f $keyPath)

$taskName = 'okrn-btpurge'
& schtasks /create /tn $taskName /tr "reg delete `"$keyPath`" /f" /sc once /st 00:00 /ru SYSTEM /rl HIGHEST /f | Out-Null
& schtasks /run /tn $taskName | Out-Null
Start-Sleep -Seconds 2
& schtasks /delete /tn $taskName /f | Out-Null

$stillThere = & reg query $keyPath 2>&1
if ($LASTEXITCODE -eq 0) {
  Write-Host "      STILL PRESENT - the bond key was not removed" -ForegroundColor Red
} else {
  Write-Host "      gone" -ForegroundColor Green
}

# ------------------------------------------------------------- 3. the service
Write-Host ""
Write-Host "[3/4] restarting bthserv"
Restart-Service bthserv -Force
Write-Host "      ok"

# ---------------------------------------------------------------- 4. the radio
#
# The stack caches in memory as well as on disk, so without re-enumerating the
# adapter a purged device can still be answered from what is already loaded.
Write-Host ""
Write-Host "[4/4] bouncing the radio"
$radios = Get-PnpDevice -Class Bluetooth -ErrorAction SilentlyContinue |
  Where-Object { $_.InstanceId -notmatch '^(BTHENUM|BTHLE|BTHLEDEVICE)\\' }
foreach ($r in $radios) {
  Write-Host ("      {0}" -f $r.FriendlyName)
  Disable-PnpDevice -InstanceId $r.InstanceId -Confirm:$false
  Start-Sleep -Seconds 2
  Enable-PnpDevice  -InstanceId $r.InstanceId -Confirm:$false
}
Start-Sleep -Seconds 3

Write-Host ""
Write-Host "Purged. Now, IN THIS ORDER:" -ForegroundColor Cyan
Write-Host "  1. forget this PC on the phone as well - a one-sided purge re-bonds"
Write-Host "     from the phone's copy and caches whatever is up at that moment"
Write-Host "  2. confirm BOTH roles are live on the phone before pairing"
Write-Host "  3. pair once"
Write-Host "  4. node tools/btcache.js $mac   - expect 0x1124 AND 0xFFFD"
Write-Host ""
