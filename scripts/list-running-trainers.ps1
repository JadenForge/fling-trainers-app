$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$items = @(Get-Process | Where-Object {
  $_.MainWindowTitle -and $_.MainWindowTitle -match '(?i)\bTrainer\b|\u300a.*\u4fee\u6539\u5668'
} | ForEach-Object {
  [pscustomobject]@{
    pid = $_.Id
    process = $_.ProcessName
    title = $_.MainWindowTitle
  }
})

ConvertTo-Json -InputObject $items -Compress
