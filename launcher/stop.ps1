# Stops the Outbound Console server (and with it the Instantly sync).
$conn = Get-NetTCPConnection -LocalPort 3480 -State Listen -ErrorAction SilentlyContinue
foreach ($c in $conn) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }
