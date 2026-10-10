<#
.SYNOPSIS
  Capture and summarise WiseCAM Tube Steel runtime-log import results.

.DESCRIPTION
  WiseCAM has no import CLI; it logs everything to a weekly rolling file under
  UserConfig\CadCamLog\NcCadCamLog-<YYYY>-<WW>w.txt. This helper locates that file,
  snapshots a baseline, and parses Start/Error/Finish records into a compact one-line
  result per imported file, so you can "auto-experiment" by importing files in the GUI
  and reading the outcome here.

  Modes:
    files     find/print the active weekly log path (does not touch anything)
    baseline  snapshot current log length into the state file
    diff      print results from lines added since the baseline
    last      print results for the last -Count lines (no baseline needed)
    watch     follow the log and print results live as you import (Ctrl+C to stop)

  This script only READS Weihong files. It never edits them.

.EXAMPLE
  pwsh tools\wisecam-log.ps1 -Mode baseline
  pwsh tools\wisecam-log.ps1 -Mode diff
  pwsh tools\wisecam-log.ps1 -Mode watch
  pwsh tools\wisecam-log.ps1 -Mode last -Count 2000
#>
[CmdletBinding()]
param(
  [ValidateSet('files', 'baseline', 'diff', 'last', 'watch')]
  [string]$Mode = 'watch',

  [string]$InstallRoot = 'C:\WeiHong\WiseCAM-Tube-Steel',

  # Explicit log file (overrides InstallRoot lookup).
  [string]$LogFile,

  [string]$StateFile = (Join-Path $env:TEMP 'wisecam-log-state.json'),

  [int]$Count = 400,

  [int]$PollMs = 800
)

$ErrorActionPreference = 'Stop'

function Get-ActiveLogFile {
  if ($LogFile) {
    if (-not (Test-Path -LiteralPath $LogFile)) { throw "Log file not found: $LogFile" }
    return (Resolve-Path -LiteralPath $LogFile).Path
  }
  $dir = Join-Path $InstallRoot 'UserConfig\CadCamLog'
  if (-not (Test-Path -LiteralPath $dir)) { throw "Log directory not found: $dir" }
  $f = Get-ChildItem -LiteralPath $dir -Filter 'NcCadCamLog-*.txt' -File -ErrorAction Stop |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $f) { throw "No NcCadCamLog-*.txt found in $dir" }
  return $f.FullName
}

# Parse WiseCAM log lines into per-file import results.
# Returns objects: @{ Result='OK'|'FAIL'; Stage=''; File='...' }
function Convert-LogToResults {
  param([string[]]$Lines)

  $lineRe = '^(?<ts>\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2}) \|(?<pid>\d+)\s*\|\s*(?<lvl>\w+)\s*\|-(?<msg>.*?) \|(?<src>.*)$'
  $pending = @{}   # pid -> System.Collections.Queue of records
  $results = New-Object System.Collections.Generic.List[object]

  function New-Rec([string]$file) { [pscustomobject]@{ File = $file; Stage = $null; Finished = $false } }

  function Flush-Pid($pending, $results, [string]$pid) {
    if (-not $pending.ContainsKey($pid)) { return }
    $q = $pending[$pid]
    while ($q.Count -gt 0) {
      $r = $q.Dequeue()
      if ($r.Stage) {
        $results.Add([pscustomobject]@{ Result = 'FAIL'; Stage = $r.Stage; File = $r.File })
      } elseif ($r.Finished) {
        $results.Add([pscustomobject]@{ Result = 'OK'; Stage = ''; File = $r.File })
      } else {
        $results.Add([pscustomobject]@{ Result = 'FAIL'; Stage = 'unknown'; File = $r.File })
      }
    }
  }

  foreach ($line in $Lines) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $m = [regex]::Match($line, $lineRe)
    if (-not $m.Success) { continue }
    $msg = $m.Groups['msg'].Value
    $pid = $m.Groups['pid'].Value
    if (-not $pending.ContainsKey($pid)) { $pending[$pid] = New-Object System.Collections.Queue }

    if ($msg -match '^-?Start Load File:(?<f>.+)$') {
      $pending[$pid].Enqueue((New-Rec $Matches['f']))
    }
    elseif ($msg -match '^-?Load File Error At :(?<s>\S+)') {
      if ($pending[$pid].Count -gt 0) {
        $arr = $pending[$pid].ToArray()
        $arr[$arr.Count - 1].Stage = $Matches['s']
      }
    }
    elseif ($msg -match '^-?Finish Load File:(?<f>.+)$') {
      $target = $Matches['f']
      $arr = $pending[$pid].ToArray()
      foreach ($r in $arr) {
        if ($r.File -eq $target) { $r.Finished = $true; break }
      }
    }
    elseif ($msg -match '^-?Finish Thread Load File:ThreadLoadTubePart (Success|Failed)!') {
      Flush-Pid $pending $results $pid
    }
  }
  return $results
}

function Show-Results {
  param($Results)
  $Results = @($Results)
  if ($Results.Count -eq 0) { Write-Output '(no import results parsed)'; return }
  $ok = ($Results | Where-Object Result -eq 'OK').Count
  $fail = ($Results | Where-Object Result -eq 'FAIL').Count
  foreach ($r in $Results) {
    if ($r.Result -eq 'OK') {
      Write-Output ("OK    {0}" -f $r.File)
    } else {
      Write-Output ("FAIL  [{0}]  {1}" -f $r.Stage, $r.File)
    }
  }
  Write-Output ("---- {0} OK / {1} FAIL ----" -f $ok, $fail)
}

# Read only whole lines that are fully flushed (avoid a partially written last line).
function Read-AllLines([string]$path) {
  $fs = [IO.File]::Open($path, 'Open', 'Read', 'ReadWrite')
  try {
    $sr = New-Object IO.StreamReader($fs)
    return $sr.ReadToEnd() -split "`r?`n"
  } finally { $fs.Dispose() }
}

switch ($Mode) {
  'files' {
    $log = Get-ActiveLogFile
    $i = Get-Item -LiteralPath $log
    Write-Output ("LOG      {0}" -f $log)
    Write-Output ("SIZE     {0} bytes  {1} lines  (last write {2})" -f $i.Length, (Get-Content -LiteralPath $log).Count, $i.LastWriteTime)
    $dumps = Get-ChildItem -LiteralPath (Join-Path $InstallRoot 'UserConfig') -Filter 'NcEditorV15-*-DumpFile.dmp' -File -ErrorAction SilentlyContinue
    if ($dumps) {
      Write-Output "CRASH DUMPS:"
      $dumps | Sort-Object LastWriteTime -Descending | ForEach-Object { Write-Output ("  {0}  {1}" -f $_.LastWriteTime, $_.FullName) }
    }
  }

  'baseline' {
    $log = Get-ActiveLogFile
    $i = Get-Item -LiteralPath $log
    $state = [pscustomobject]@{ Log = $log; Length = $i.Length; Lines = (Get-Content -LiteralPath $log).Count; Time = (Get-Date).ToString('s') }
    $state | ConvertTo-Json | Set-Content -LiteralPath $StateFile
    Write-Output ("baseline saved -> {0}" -f $StateFile)
    Write-Output ("  {0}  ({1} bytes, {2} lines)" -f $log, $state.Length, $state.Lines)
  }

  'diff' {
    if (-not (Test-Path -LiteralPath $StateFile)) { throw "No baseline at $StateFile. Run -Mode baseline first." }
    $state = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
    $log = Get-ActiveLogFile
    $all = Get-Content -LiteralPath $log
    if ($all.Count -le $state.Lines) { Write-Output '(no new log lines since baseline)'; break }
    $new = $all[$state.Lines..($all.Count - 1)]
    Write-Output ("---- {0} new line(s) since baseline ----" -f $new.Count)
    Show-Results (Convert-LogToResults $new)
  }

  'last' {
    $log = Get-ActiveLogFile
    $all = Get-Content -LiteralPath $log
    $take = [Math]::Min($Count, $all.Count)
    $slice = if ($take -gt 0) { $all[($all.Count - $take)..($all.Count - 1)] } else { @() }
    Write-Output ("---- last {0} line(s) of {1} ----" -f $take, $log)
    Show-Results (Convert-LogToResults $slice)
  }

  'watch' {
    $log = Get-ActiveLogFile
    Write-Output ("watching {0}" -f $log)
    Write-Output "import files in WiseCAM now; Ctrl+C to stop."
    $seen = (Get-Content -LiteralPath $log).Count
    $acc = New-Object System.Collections.Generic.List[string]
    while ($true) {
      Start-Sleep -Milliseconds $PollMs
      $all = Get-Content -LiteralPath $log -ErrorAction SilentlyContinue
      if (-not $all) { continue }
      if ($all.Count -gt $seen) {
        $new = $all[$seen..($all.Count - 1)]
        $seen = $all.Count
        foreach ($ln in $new) { [void]$acc.Add($ln) }
        $res = Convert-LogToResults $new
        foreach ($r in @($res)) {
          if ($r.Result -eq 'OK') { Write-Output ("OK    {0}" -f $r.File) }
          else { Write-Output ("FAIL  [{0}]  {1}" -f $r.Stage, $r.File) }
        }
      }
    }
  }
}
