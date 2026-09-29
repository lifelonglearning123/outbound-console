# Starts the Outbound Console server in the background (building first if the source changed),
# then opens the browser. At Windows login it runs with -NoBrowser so only the sync service starts.
param([switch]$NoBrowser)
$ErrorActionPreference = 'SilentlyContinue'

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

$port = 3480
$url  = "http://127.0.0.1:$port"

function Test-PortListening {
    return [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

# BUILD_ID is written at the end of a successful `next build`, so it marks the last good build.
function Get-BuildTime {
    $buildId = Join-Path $projectRoot ".next\BUILD_ID"
    if (Test-Path $buildId) { return (Get-Item $buildId).LastWriteTime }
    return $null
}

function Get-NewestSourceTime {
    $newest = [DateTime]::MinValue
    foreach ($p in @("src", "public", "package.json", "package-lock.json", "next.config.ts", "postcss.config.mjs", "tsconfig.json")) {
        $full = Join-Path $projectRoot $p
        if (-not (Test-Path $full)) { continue }
        if ((Get-Item $full).PSIsContainer) {
            $latest = Get-ChildItem -Path $full -Recurse -File -Force | Sort-Object LastWriteTime -Descending | Select-Object -First 1
            if ($latest -and $latest.LastWriteTime -gt $newest) { $newest = $latest.LastWriteTime }
        } else {
            $t = (Get-Item $full).LastWriteTime
            if ($t -gt $newest) { $newest = $t }
        }
    }
    return $newest
}

if (-not (Test-PortListening)) {
    $buildTime = Get-BuildTime
    if (-not $buildTime -or (Get-NewestSourceTime) -gt $buildTime) {
        $nextDir = Join-Path $projectRoot ".next"
        if (Test-Path $nextDir) { Remove-Item -LiteralPath $nextDir -Recurse -Force }
        # Visible window so build progress and errors can be seen; `|| pause` keeps it open on failure.
        Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "title Outbound Console - Building... & npm run build || pause" -WorkingDirectory $projectRoot -Wait
    }

    $logDir = Join-Path $projectRoot "data\logs"
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null

    # node directly (not npm) so the listening process is the one stop.ps1 kills.
    # PS 5.1 mis-quotes ArgumentList items containing spaces, so pass one pre-quoted string.
    # --use-system-ca: trust the Windows certificate store for Instantly/OpenAI/GHL calls.
    # --max-http-header-size: other localhost apps' cookies can exceed Node's 16 KB default.
    $nextBin = Join-Path $projectRoot "node_modules\next\dist\bin\next"
    $argString = "--use-system-ca --max-http-header-size=65536 `"$nextBin`" start -H 127.0.0.1 -p $port"
    Start-Process -FilePath "node.exe" -ArgumentList $argString -WorkingDirectory $projectRoot -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $logDir "server.log") -RedirectStandardError (Join-Path $logDir "server-error.log")

    $deadline = (Get-Date).AddSeconds(40)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
        try { if ((Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2).StatusCode -ge 200) { break } } catch {}
    }
}

if (-not $NoBrowser) { Start-Process $url }
