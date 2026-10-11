param(
  [Parameter(Mandatory = $true)][string]$File,
  [Parameter(Mandatory = $true)][string]$TitleMarker
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$existing = Get-Process | Where-Object {
  $_.MainWindowTitle -and $_.MainWindowTitle.IndexOf($TitleMarker, [StringComparison]::OrdinalIgnoreCase) -ge 0
} | Select-Object -First 1

if ($existing) {
  [Console]::Out.WriteLine("ALREADY_RUNNING:$($existing.Id):$($existing.MainWindowTitle)")
  exit 2
}

try {
  $workingDirectory = Split-Path -Path $File -Parent
  $started = Start-Process -FilePath $File -WorkingDirectory $workingDirectory -Verb RunAs -PassThru
  [Console]::Out.WriteLine("STARTED:$($started.Id)")
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
