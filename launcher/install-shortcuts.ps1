# Creates a Desktop shortcut, Start Menu entries, and a Startup entry so the sync runs from Windows login.
# Run once: npm run app:install
# (Shortcuts call PowerShell directly; .vbs wrappers get quarantined by Windows security on this PC.)
$projectRoot = Split-Path -Parent $PSScriptRoot
$startPs1 = Join-Path $projectRoot "launcher\start.ps1"
$stopPs1  = Join-Path $projectRoot "launcher\stop.ps1"
$ps = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"

$desktop   = [Environment]::GetFolderPath('Desktop')
$appFolder = Join-Path ([Environment]::GetFolderPath('Programs')) "Outbound Console"
$startup   = [Environment]::GetFolderPath('Startup')
New-Item -ItemType Directory -Path $appFolder -Force | Out-Null

$sh = New-Object -ComObject WScript.Shell
function New-Shortcut($Path, $Script, $Extra, $Description) {
    $s = $sh.CreateShortcut($Path)
    $s.TargetPath = $ps
    $s.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Script`" $Extra"
    $s.WorkingDirectory = $projectRoot
    $s.WindowStyle = 7   # start minimised
    $s.Description = $Description
    $s.IconLocation = "shell32.dll,156"
    $s.Save()
}

New-Shortcut (Join-Path $desktop   "Outbound Console.lnk")      $startPs1 ""           "Open Outbound Console"
New-Shortcut (Join-Path $appFolder "Outbound Console.lnk")      $startPs1 ""           "Open Outbound Console"
New-Shortcut (Join-Path $appFolder "Stop Outbound Console.lnk") $stopPs1  ""           "Stop Outbound Console and its sync"
New-Shortcut (Join-Path $startup   "Outbound Console sync.lnk") $startPs1 "-NoBrowser" "Start the Instantly sync at login"

Write-Host "Created: Desktop 'Outbound Console', Start Menu entries, and a Startup entry (sync starts at login)."
