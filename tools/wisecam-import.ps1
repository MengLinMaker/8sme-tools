<#
.SYNOPSIS
  Drive WiseCAM's import dialog via UI Automation and report the per-file result.

.DESCRIPTION
  WiseCAM has no import CLI, so this uses Windows UI Automation to:
    1. click "Add From File" on the running instance,
    2. fill the Open dialog with a path,
    3. wait for the load to finish (watching the weekly log),
    4. read the in-app "Log" panel (which shows the REAL reason, e.g.
       "Restricted file format, nc1 file format is unsupported."), and
    5. detect any new crash dump.

  WiseCAM must already be running. This script only READS Weihong files (it does not edit
  them); it just clicks the same buttons you would.

.PARAMETER Path
  A file, or a directory (with -Recurse / -Filter) of files to import.

.EXAMPLE
  pwsh tools\wisecam-import.ps1 -Path "C:\Users\mengl\Downloads\Failed tests\...\NC files\a1.nc1"
.EXAMPLE
  pwsh tools\wisecam-import.ps1 -Path "C:\Users\mengl\Downloads\Failed tests" -Recurse -Filter *.nc1
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Path,
  [string[]]$Filter = @('*.nc1', '*.stp', '*.step'),
  [switch]$Recurse,
  [string]$ProcName = 'WiseCAM-Tube-Steel',
  [string]$InstallRoot = 'C:\WeiHong\WiseCAM-Tube-Steel',
  [int]$TimeoutMs = 30000,
  [int]$BetweenMs = 900
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

function Get-AppWindow($pid_) {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $pid_)
  return $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
}

function Get-ByNameOrId($root, $value) {
  $c1 = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $value)
  $e = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $c1)
  if ($e) { return $e }
  $c2 = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $value)
  return $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $c2)
}

function Get-LogMessages($win) {
  $log = Get-ByNameOrId $win 'Log'
  if (-not $log) { return @() }
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)
  $items = $log.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
  $msgs = New-Object System.Collections.Generic.List[string]
  foreach ($i in $items) { if ($i.Current.Name -match '^\(.*\)\s') { $msgs.Add($i.Current.Name) } }
  return $msgs
}

function Invoke-Element($el) {
  $p = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $p.Invoke()
}

function Wait-ImportDialog($pid_, $timeoutMs) {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $cls = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, '#32770')
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $timeoutMs) {
    $d = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cls)
    if ($d) { try { if ($d.Current.ProcessId -eq $pid_) { return $d } } catch {} }
    Start-Sleep -Milliseconds 250
  }
  return $null
}

function Set-DialogPath($dlg, $file) {
  # standard CFileDialog: the File name field is the ComboBox with AutomationId 1148
  $combo = Get-ByNameOrId $dlg '1148'
  $target = $null
  if ($combo) {
    try { $null = $combo.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); $target = $combo } catch {}
    if (-not $target) {
      $ec = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
      $target = $combo.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $ec)
    }
  }
  if (-not $target) {
    $ec = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
    $target = $dlg.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $ec)
  }
  if ($target) {
    try { $vp = $target.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); $vp.SetValue($file); return $true } catch {}
  }
  # fallback: clipboard paste (handles spaces/parentheses safely)
  Set-Clipboard -Value $file
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.SendKeys]::SendWait('^a')
  [System.Windows.Forms.SendKeys]::SendWait('^v')
  return $true
}

function Click-DialogOpen($dlg) {
  $ok = Get-ByNameOrId $dlg '1'
  if (-not $ok) { $ok = Get-ByNameOrId $dlg 'OK' }
  if ($ok) { try { Invoke-Element $ok; return $true } catch {} }
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  return $true
}

$logPath = $null
$logDir = Join-Path $InstallRoot 'UserConfig\CadCamLog'
if (Test-Path -LiteralPath $logDir) {
  $logPath = (Get-ChildItem -LiteralPath $logDir -Filter 'NcCadCamLog-*.txt' -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
}

$proc = Get-Process -Name $ProcName -ErrorAction Stop | Select-Object -First 1
$win = Get-AppWindow $proc.Id
if (-not $win) { throw "No WiseCAM window for pid $($proc.Id)" }

$files = @()
if (Test-Path -LiteralPath $Path -PathType Container) {
  foreach ($f in $Filter) {
    $files += Get-ChildItem -LiteralPath $Path -Filter $f -File -Recurse:$Recurse -ErrorAction SilentlyContinue
  }
} else {
  $files = @(Get-Item -LiteralPath $Path)
}
$files = $files | Sort-Object FullName
Write-Output ("importing {0} file(s) via UI Automation into pid {1}" -f $files.Count, $proc.Id)

$results = New-Object System.Collections.Generic.List[object]
foreach ($f in $files) {
  $before = @(Get-LogMessages $win).Count
  $logLinesBefore = if ($logPath) { (Get-Content -LiteralPath $logPath).Count } else { 0 }
  $dumpsBefore = (Get-ChildItem -LiteralPath (Join-Path $InstallRoot 'UserConfig') -Filter '*DumpFile.dmp' -File -ErrorAction SilentlyContinue).FullName

  Write-Output ("-> {0}" -f $f.Name)
  $btn = Get-ByNameOrId $win 'PartListViewControl_Button_60'
  if (-not $btn) { throw "Could not find 'Add From File' button." }
  Invoke-Element $btn

  $dlg = Wait-ImportDialog $proc.Id 8000
  if ($dlg) {
    Set-DialogPath $dlg $f.FullName | Out-Null
    Start-Sleep -Milliseconds 200
    Click-DialogOpen $dlg | Out-Null
  } else {
    Write-Output "   (no dialog appeared - is import maybe keyboard-driven?)"
  }

  # wait for the load to settle (new line in the file log) or timeout
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $settled = $false
  while ($sw.ElapsedMilliseconds -lt $TimeoutMs) {
    Start-Sleep -Milliseconds 400
    if ($logPath) {
      $n = (Get-Content -LiteralPath $logPath -ErrorAction SilentlyContinue).Count
      if ($n -gt $logLinesBefore) { $settled = $true; Start-Sleep -Milliseconds 600; break }
    }
  }

  $after = @(Get-LogMessages $win)
  $newMsgs = if ($after.Count -gt $before) { $after[$before..($after.Count - 1)] } else { @() }
  $dumpsAfter = (Get-ChildItem -LiteralPath (Join-Path $InstallRoot 'UserConfig') -Filter '*DumpFile.dmp' -File -ErrorAction SilentlyContinue).FullName
  $newDumps = @($dumpsAfter | Where-Object { $_ -notin $dumpsBefore })

  $verdict = if ($newDumps.Count -gt 0) { 'CRASH' }
    elseif ($newMsgs | Where-Object { $_ -match 'failed|unsupported|not supported|error' }) { 'FAIL' }
    elseif ($settled) { 'OK?' }
    else { 'TIMEOUT' }

  $results.Add([pscustomobject]@{ File = $f.Name; Verdict = $verdict; Messages = ($newMsgs -join ' | '); Dumps = ($newDumps.Count) })
  Write-Output ("   [{0}] {1}" -f $verdict, (($newMsgs | Select-Object -Last 2) -join ' ; '))
  Start-Sleep -Milliseconds $BetweenMs
}

Write-Output ""
Write-Output "================ SUMMARY ================"
$results | Format-Table -AutoSize -Wrap
