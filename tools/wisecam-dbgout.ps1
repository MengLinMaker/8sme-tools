<#
.SYNOPSIS
  Capture Win32 OutputDebugString traces (the app's "Win32DebugAppender" channel).

.DESCRIPTION
  WiseCAM's native logging (NceLog.dll) can emit to the Win32 debug channel
  (OutputDebugString), which normal log files do not show. This implements the standard
  DBWIN_BUFFER listener (same mechanism as Sysinternals DebugView) so you can capture
  those traces without installing anything.

  Run it in one terminal, then reproduce the action in WiseCAM. Only ONE DBWIN listener may
  run at a time (so close DebugView first).

.PARAMETER OutFile
  Append captured lines to this file as well as stdout.

.PARAMETER Filter
  Only print lines whose owning process name matches this regex (default: WiseCAM).

.PARAMETER DurationSec
  Stop after N seconds (0 = run until Ctrl+C).

.EXAMPLE
  pwsh tools\wisecam-dbgout.ps1 -OutFile "$env:TEMP\wisecam-dbgout.txt" -DurationSec 120
#>
[CmdletBinding()]
param(
  [string]$OutFile,
  [string]$Filter = 'Wise|Nc|Wei|CAM',
  [int]$DurationSec = 0
)
$ErrorActionPreference = 'Stop'

if (-not ('DbwinListener' -as [type])) {
  Add-Type -Namespace '' -Name 'DbwinListener' -MemberDefinition @'
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern IntPtr CreateFileMapping(IntPtr hFile, IntPtr lpAttributes,
      uint flProtect, uint dwMaximumSizeHigh, uint dwMaximumSizeLow, string lpName);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern IntPtr MapViewOfFile(IntPtr hMap, uint dwDesiredAccess,
      uint dwFileOffsetHigh, uint dwFileOffsetLow, uint dwNumberOfBytesToMap);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern IntPtr CreateEvent(IntPtr lpAttributes, bool bManualReset,
      bool bInitialState, string lpName);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern IntPtr OpenEvent(uint dwDesiredAccess, bool bInheritHandle, string lpName);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool SetEvent(IntPtr hEvent);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool UnmapViewOfFile(IntPtr lpBaseAddress);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool CloseHandle(IntPtr hObject);
'@
}

$PAGE_READWRITE = 0x04
$FILE_MAP_READ = 0x0004
$EVENT_MODIFY_STATE = 0x0002
$SYNCHRONIZE = 0x00100000
$WAIT_OBJECT_0 = 0
$WAIT_TIMEOUT = 258

$hMap = [DbwinListener]::CreateFileMapping([IntPtr](-1), [IntPtr]::Zero, $PAGE_READWRITE, 0, 4096, 'DBWIN_BUFFER')
if ($hMap -eq [IntPtr]::Zero) { throw 'CreateFileMapping failed (maybe another DebugView/listener is running).' }
$pBuf = [DbwinListener]::MapViewOfFile($hMap, $FILE_MAP_READ, 0, 0, 4096)
$hReady = [DbwinListener]::OpenEvent($EVENT_MODIFY_STATE, $false, 'DBWIN_BUFFER_READY')
$hData = [DbwinListener]::OpenEvent($SYNCHRONIZE, $false, 'DBWIN_DATA_READY')
if ($hReady -eq [IntPtr]::Zero -or $hData -eq [IntPtr]::Zero) {
  [DbwinListener]::CloseHandle($hMap) | Out-Null
  throw 'OpenEvent failed (another listener may own the events).'
}

Write-Output "listening for OutputDebugString (filter='$Filter') ..."
$procNames = @{}
$sw = [Diagnostics.Stopwatch]::StartNew()

try {
  while ($true) {
    if ($DurationSec -gt 0 -and $sw.Elapsed.TotalSeconds -ge $DurationSec) { break }
    # signal we're ready for the next message
    [DbwinListener]::SetEvent($hReady) | Out-Null
    $r = [DbwinListener]::WaitForSingleObject($hData, 500)
    if ($r -ne $WAIT_OBJECT_0) { continue }
    # read pid (first 4 bytes) and the NUL-terminated ascii string after it
    $bytes = New-Object byte[] 4096
    [Runtime.InteropServices.Marshal]::Copy($pBuf, $bytes, 0, 4096)
    $pid2 = [BitConverter]::ToUInt32($bytes, 0)
    $end = 4
    while ($end -lt 4096 -and $bytes[$end] -ne 0) { $end++ }
    $msg = [Text.Encoding]::Default.GetString($bytes, 4, $end - 4)

    if (-not $procNames.ContainsKey([int]$pid2)) {
      try { $procNames[[int]$pid2] = (Get-Process -Id $pid2 -ErrorAction Stop).ProcessName } catch { $procNames[[int]$pid2] = '' }
    }
    $pname = $procNames[[int]$pid2]
    if ($Filter -and $pname -and $pname -notmatch $Filter) { continue }

    $line = ('[{0}] {1}: {2}' -f (Get-Date -Format 'HH:mm:ss.fff'), $pid2, $msg)
    Write-Output $line
    if ($OutFile) { Add-Content -LiteralPath $OutFile -Value $line }
  }
} finally {
  [DbwinListener]::UnmapViewOfFile($pBuf) | Out-Null
  [DbwinListener]::CloseHandle($hData) | Out-Null
  [DbwinListener]::CloseHandle($hReady) | Out-Null
  [DbwinListener]::CloseHandle($hMap) | Out-Null
}
Write-Output 'stopped.'
