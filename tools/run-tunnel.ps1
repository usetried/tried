$cf = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
$log = Join-Path (Split-Path -Parent $PSScriptRoot) 'data\tunnel-named.log'
while ($true) {
  "[$(Get-Date -Format s)] starting tunnel" | Out-File -Append -Encoding utf8 $log
  & $cf tunnel --no-autoupdate run tried *>> $log
  Start-Sleep -Seconds 10
}
