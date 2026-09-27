$script = Join-Path $PSScriptRoot 'run-forever.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'TRIED server' -Action $action -Trigger $trigger -Settings $settings -Description 'Keeps the TRIED bench running (localhost:8787)' -Force | Out-Null
Write-Output "Registered scheduled task 'TRIED server' (runs at logon)."

$tunnelScript = Join-Path $PSScriptRoot 'run-tunnel.ps1'
$tunnelAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$tunnelScript`""
Register-ScheduledTask -TaskName 'TRIED tunnel' -Action $tunnelAction -Trigger $trigger -Settings $settings -Description 'Cloudflare tunnel for the TRIED server' -Force | Out-Null
Write-Output "Registered scheduled task 'TRIED tunnel' (runs at logon)."
