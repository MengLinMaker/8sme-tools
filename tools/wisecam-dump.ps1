<#
.SYNOPSIS
  Parse WiseCAM native minidumps (NcEditorV15-*-DumpFile.dmp) without a debugger.

.DESCRIPTION
  WiseCAM installs an unhandled-exception filter (in NceUi.dll: SetUnhandledExceptionFilter
  + MiniDumpWriteDump) that writes a MINIDUMP to
  UserConfig\NcEditorV15-[<timestamp>]-DumpFile.dmp on a native crash. A minidump has no
  exception *message*, but it does carry the exception record (code/address) and the module
  list, which this script extracts so you can see WHAT threw and WHERE (without needing
  WinDbg/cdb). For the full stack call-stack, use a real debugger.

  This script only READS dump files.

.EXAMPLE
  # summarise all dumps for the installed app
  pwsh tools\wisecam-dump.ps1 -Path "C:\WeiHong\WiseCAM-Tube-Steel\UserConfig"

.EXAMPLE
  pwsh tools\wisecam-dump.ps1 -Path "C:\WeiHong\WiseCAM-Tube-Steel\UserConfig\NcEditorV15-[2026-10-10-09-26-08]-DumpFile.dmp"
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string]$Path
)
$ErrorActionPreference = 'Stop'

$ExcNames = @{
  'E06D7363' = 'C++ exception (MSVC _CxxThrowException)'
  'E0434352' = '.NET/CLR exception'
  'C0000005' = 'Access violation'
  'C0000094' = 'Integer divide by zero'
  'C00000FD' = 'Stack overflow'
  'C000001D' = 'Illegal instruction'
  'C0000374' = 'Heap corruption'
  'C0000409' = 'Stack buffer overrun (fast fail)'
  '80000003' = 'Breakpoint'
  '406D1388' = 'MSVC thread-name marker'
}

function Get-DumpInfo {
  param([string]$File)
  $bytes = [IO.File]::ReadAllBytes($File)
  $ms = New-Object IO.MemoryStream(, $bytes)
  $br = New-Object IO.BinaryReader($ms)
  function R32 { $br.ReadUInt32() }
  function R64 { $br.ReadUInt64() }

  $sig = [Text.Encoding]::ASCII.GetString($br.ReadBytes(4))
  $null = R32; $nstreams = R32; $dirRva = R32; $null = R32; $null = R32; $null = R64

  $dir = @{}
  $ms.Position = $dirRva
  for ($i = 0; $i -lt $nstreams; $i++) {
    $t = [int](R32); $sz = [int](R32); $rva = [int](R32)
    $dir[$t] = @{ Size = $sz; Rva = $rva }
  }

  function Read-MDString([uint32]$rva) {
    $old = $ms.Position; $ms.Position = $rva; $len = R32
    $b = $br.ReadBytes($len); $ms.Position = $old
    return [Text.Encoding]::Unicode.GetString($b)
  }

  $code = $null; $addr = $null; $tid = $null
  if ($dir.ContainsKey(6)) {
    $ms.Position = $dir[6].Rva
    $tid = R32; $null = R32; $code = R32; $null = R32; $null = R64; $addr = R64
  }

  $modules = $null
  if ($dir.ContainsKey(4)) {
    $ms.Position = $dir[4].Rva
    $n = R32
    $mods = New-Object System.Collections.Generic.List[object]
    for ($i = 0; $i -lt $n; $i++) {
      $base = R64; $size = R32; $null = R32; $null = R32; $nameRva = R32
      $ms.Position += 52 + 8 + 8 + 8 + 8
      $mods.Add([pscustomobject]@{ Base = [uint64]$base; Size = [uint64]$size; Name = (Read-MDString $nameRva) })
    }
    $modules = $mods
  }

  $module = '<none>'; $offset = 0
  if ($addr -ne $null -and $modules) {
    $hit = $modules | Where-Object { $addr -ge $_.Base -and $addr -lt ($_.Base + $_.Size) } | Select-Object -First 1
    if ($hit) { $module = (Split-Path $hit.Name -Leaf); $offset = $addr - $hit.Base }
  }

  return [pscustomobject]@{
    File      = (Split-Path $File -Leaf)
    Time      = (Get-Item -LiteralPath $File).LastWriteTime
    Signature = $sig
    Exception = if ($code -ne $null) { ('0x{0:X8}' -f $code) } else { '' }
    Meaning   = if ($code -ne $null) { $hex = ('{0:X8}' -f $code); if ($ExcNames.ContainsKey($hex)) { $ExcNames[$hex] } else { 'unknown' } } else { '' }
    Address   = if ($addr -ne $null) { ('0x{0:X8}' -f $addr) } else { '' }
    Module    = $module
    Offset    = if ($offset) { ('+0x{0:X}' -f $offset) } else { '' }
    ThreadId  = $tid
    Modules   = if ($modules) { $modules.Count } else { 0 }
  }
}

$files = @()
if (Test-Path -LiteralPath $Path -PathType Container) {
  $files = Get-ChildItem -LiteralPath $Path -Filter '*DumpFile.dmp' -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending
} else {
  $files = @(Get-Item -LiteralPath $Path)
}
if (-not $files) { Write-Output "No *DumpFile.dmp found under $Path"; return }

$out = foreach ($f in $files) { Get-DumpInfo -File $f.FullName }
$out | Format-Table -AutoSize -Wrap
Write-Output ""
Write-Output "EXCEPTION CODE LEGEND:"
Write-Output "  0xE06D7363 = a C++ 'throw' (the app's own code threw std::exception / CException)."
Write-Output "  Full call stack needs a debugger, e.g.:  cdb -z <dump> -c `".ecxr; k; !analyze -v`""
