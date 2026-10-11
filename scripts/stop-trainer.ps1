param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [Parameter(Mandatory = $true)][string]$TitleMarker
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$target = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
if (-not $target) {
  [Console]::Out.WriteLine('STOPPED')
  exit 0
}
if (-not $target.MainWindowTitle -or $target.MainWindowTitle.IndexOf($TitleMarker, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
  [Console]::Error.WriteLine('Process window no longer matches this trainer.')
  exit 3
}

try {
  $taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
  $result = Start-Process -FilePath $taskkill -ArgumentList @('/PID', "$ProcessId", '/T', '/F') -Verb RunAs -PassThru -Wait -WindowStyle Hidden
  if ($result.ExitCode -ne 0) { throw "taskkill exited with code $($result.ExitCode)" }
  [Console]::Out.WriteLine('STOPPED')
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
