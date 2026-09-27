$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
New-Item -ItemType Directory -Force -Path (Join-Path $root 'data') | Out-Null
while ($true) {
  $log = Join-Path $root ("data\server-" + (Get-Date -Format 'yyyyMMdd') + ".log")
  "[$(Get-Date -Format s)] starting TRIED server" | Out-File -Append -Encoding utf8 $log
  & node src/server.js *>> $log
  "[$(Get-Date -Format s)] server exited with code $LASTEXITCODE, restarting in 10s" | Out-File -Append -Encoding utf8 $log
  Start-Sleep -Seconds 10
}
