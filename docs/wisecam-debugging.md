# WiseCAM — debugging, logs & automation notes

Research notes for the 8SME tools. Goal: understand how **Weihong WiseCAM Tube Steel**
behaves on this machine, where it records diagnostics, and how to capture/automate
experiments (especially **why NC1 import fails**).

Status: **NC1 import does not work on this install because it is licence/edition-gated**
(confirmed 2026-10-10) — see [§5](#5-nc1-nc1-import--why-it-fails). STEP (`.stp`/`.step`)
import works. The real message is **not** in the log file; it is only shown in the app's
on-screen **Log panel**: *"Restricted file format, nc1 file format is unsupported."*.

> **TL;DR** — The installed WiseCAM is not authorized for the **steel-structure
> (钢结构)** module. NC1 (DSTV) import, plus I/T-steel import, are gated behind the
> *"pipe nesting steel structure encryption dog"* (a Weihong licence/dongle), or an online
> login / Free Trial. Until authorized, import `.step` instead of `.nc1`.

---

## 1. Install location & architecture

| Thing | Path |
|---|---|
| Install root | `C:\WeiHong\WiseCAM-Tube-Steel` |
| Launcher | `WiseCAM-Tube-Steel.exe` (32-bit, .NET Framework 4.x) |
| Main managed UI | `NcEditorWPF.dll` (WPF) |
| NC1 → CAD importer | `Nc1ToCad_Tube.dll` (native, `Nc1Translator`, `DeserializeNc1`) |
| Nesting engine | `TubeNestBasic.dll` / `TubeNestProfessional.dll` / `nestKernel.dll` |
| STEP/IGES via OCC | `TKDESTEP.dll`, `TKDEIGES.dll`, … |
| Logging | `NceLog.dll` (native, **log4cplus**-based) |
| Bundled exes | `NestReport.Wpf.exe`, `ReportPlatform\ReportPlatform.exe`, `ParametricDesignForTube\ParametricDesignForTube.exe` |

- The app is **32-bit** — a 64-bit PowerShell cannot `LoadFrom` its assemblies
  ("incorrect format"); use `%WINDIR%\SysWOW64\WindowsPowerShell\v1.0\powershell.exe`.
- Start menu shortcut: `…\Start Menu\WiseCAM-Tube-Steel\WiseCAM-Tube-Steel.lnk`.
- Per-user state lives under `C:\WeiHong\WiseCAM-Tube-Steel\UserConfig\`.

## 2. Logs & crash dumps

| What | Path | Notes |
|---|---|---|
| Main runtime log | `UserConfig\CadCamLog\NcCadCamLog-<YYYY>-<WW>w.txt` | **weekly** rolling (ISO week), e.g. `NcCadCamLog-2026-40w.txt`. This is the file to watch. |
| Crash dumps | `UserConfig\NcEditorV15-[<yyyy-MM-dd-HH-mm-ss>]-DumpFile.dmp` | native minidumps; written when the app crashes. |
| Report logs (separate) | `param` files under `ReportPlatform\Config\Param\*.txt` | report subsystem, not the nest. |
| Parametric module log | `ParametricDesignForTube\logs\myapp.log` | `log4net` (separate tool). |

Log line format (pipe-separated):

```
2026/10/10 14:13:38 |4436  |INFO  |-Start Load File:<path> |D:\CADTubeAgent_1\_work\3\s\src\NcEditor\EditTargets\NestTargetTube.cpp:2677
```

Fields: `timestamp | pid | LEVEL | -message | <compile-time source file:line>`. The source
path leaks the dev machine (`D:\CADTubeAgent_1\_work\3\s\src\NcEditor\…`) — useful to map
behaviour to source files.

Key source anchors seen in the log:

| Source | Meaning |
|---|---|
| `NestTargetTube.cpp:2677` | `Start Load File:<path>` |
| `NestTargetTube.cpp:2684` | `Load File Error At :<stage>` — **the failure reason lives here** |
| `NestTargetTube.cpp:2693` | `Finish Load File:<path>` (per-file success) |
| `NestTargetTube.cpp:2702` | `Finish Thread Load File:ThreadLoadTubePart Success/Failed!` |
| `Action.cpp:283` | `Action:Add NestPart` / `Action:Delete Nset Parts` |

Failure **stages** observed: `LoadData` (NC1 parse) and `CheckTubeSize` (dimension check).

## 3. Command line

**There is no import/scripting CLI.** Entry point `WiseCamTube.Program::Main`
(inside `WiseCAM-Tube-Steel.exe`) only:

1. takes a named `Mutex` for single-instance,
2. if already running, relaunches itself with the internal argument **`id:<pid>`**
   to activate the existing window and shows "already started",
3. otherwise runs the WPF app.

It writes nothing to stdout/stderr — **all diagnostics go to the log file** (§2).
So you cannot script an import by passing a path on the command line; the import must be
driven through the GUI (or via UI automation — see §7).

## 4. Verbose / debug logging

There is no documented debug switch, but these hooks exist:

- **App debug info** — `WiseCAM-Tube-Steel.exe.config` → `<appSettings>`:
  add `<add key="LogDebugInfo" value="true"/>`. Read by
  `NcEditorWPF.Authentication.UserService.GetEnableLogDebugInfo()`
  (compares `ConfigurationManager.AppSettings["LogDebugInfo"]` to `"true"`).
- **Native log config keys** (in `BaseTargets.dll`): `LogConfig`, `LogFiter`
  (sic), `LogShowMemInfo`. Only `\CadCamLog` + `\NcCadCamLog.txt` are currently wired.
- **log4cplus knobs** (`NceLog.dll`): `RunLog`, `LogLevel`; appenders include
  `FileAppender`, `ConsoleAppender`, `Win32DebugAppender` (→ `OutputDebugString`),
  `NTEventLogAppender`.
- **Win32 debug output**: `BaseTargets.dll` imports `OutputDebugStringA`/`W`.
  Capture with **Sysinternals DebugView** (`dbgview.exe`, run as admin, enable
  "Capture Win32") while reproducing.
- **Toolpath trace log**: `config\TubeConfig\NcEditor.ini` `[Help]` →
  `EnableTraceRedrawLog=1` (and `TraceAbnormalTimeThreshold`). Live config is
  `UserConfig\TubeConfig\NcEditor.ini`.

> Runtime config that actually applies is the **UserConfig** copy
> (`UserConfig\TubeConfig\NcEditor.ini`), not `config\TubeConfig\NcEditor.ini`.

## 4b. Do we get the actual exception?

Short answer: **not in the text log, but yes in the crash dumps.**

- The weekly log only records the *stage* (`Load File Error At :LoadData`), never the thrown
  exception or message. The importer returns a result code (`EditTargets.ErrorManager.*`:
  `FILEBAD`, `LOADFILEFAILURE`, …) rather than logging a stack.
- **Native minidumps** are written by an unhandled-exception filter inside **`NceUi.dll`**
  (`SetUnhandledExceptionFilter` → `MiniDumpWriteDump`, literals `DumpFile.dmp`,
  `.?AVCException@@` = a custom `CException`). Output:
  `UserConfig\NcEditorV15-[<yyyy-MM-dd-HH-mm-ss>]-DumpFile.dmp`.
- A minidump carries the **exception record** (code + address) and the module list, but
  **not the exception message string**. Parse it without a debugger with
  [`tools\wisecam-dump.ps1`](#7-automation):

  | dump | exception | meaning |
  |---|---|---|
  | `…-06-53-16…dmp` | `0xE06D7363` | C++ `throw` (`_CxxThrowException`) |
  | `…-09-26-08…dmp` | `0xE06D7363` | C++ `throw` (`_CxxThrowException`) |

  So the app does throw C++ exceptions (the dump source is `NceUi.dll`, faulting address in
  `KERNELBASE!RaiseException`, which is normal at throw time).
- **Caveat:** our reproduced NC1 import failure (14:13) produced **no dump** → it is a
  *handled* failure, not an unhandled exception. To see a handled parse failure you must
  catch it at throw time:
  - attach a debugger and break on first-chance C++ EH: WinDbg/cdb `sxe eh`, or
  - `procdump -e -ma -w WiseCAM-Tube-Steel.exe` (captures on exception), or
  - Visual Studio → Debug → Exceptions → tick **C++ Exceptions** (Thrown).
- **Windows event log** has no WiseCAM APPCRASH (the app swallows it and dumps itself);
  the `WER 1001` floods here are GPU `LiveKernelEvent` watchdog entries, unrelated.
- Full stack from an existing dump (needs WinDbg/cdb, not installed on this box):
  `cdb -z <dump> -c ".ecxr; k; !analyze -v"`.

## 5. NC1 (`.nc1`) import — why it fails

### Evidence

Reproduction (2026-10-10 14:13): importing
`…\Failed tests\11602-03-01 (NW31 Top frames) …\NC files\a1.nc1` writes:

```
14:13:38 |4436| Start Load File:…\a1.nc1            NestTargetTube.cpp:2677
14:13:38 |4436| Load File Error At :LoadData        NestTargetTube.cpp:2684
14:13:38 |4436| Finish Thread Load File:ThreadLoadTubePart Failed!   NestTargetTube.cpp:2702
```

The same pattern appears for **every** `.nc1` in the whole log (all `…LoadData` failures),
while `a1.nc1` is a perfectly valid Tekla **DSTV87** file (see `docs/nc1-dstv-format.md`).
STEP files in the same folder import fine, so it is not a path/permission issue.

### Root cause (CONFIRMED 2026-10-10): licence / edition gate — not a parser bug

The **file log hides the real reason** (it only logs `LoadData`). The reason is shown in the
app's own on-screen **Log** panel (`Group id='Log'`, bottom-right), which reads via UI
Automation. After importing `a1.nc1` it contained exactly:

```
(10/10 14:23:11) Restricted file format, nc1 file format is unsupported.
(10/10 14:23:11) Import nc1 file failed!
(10/10 14:23:11) 部分零件导入失败!            ("Some parts failed to import!")
```

`Restricted file format, nc1 file format is unsupported.` is the resource
`EditTargets.ExportFileTarget.NC1FileNotSupport`. Supporting strings in
`StringResources.en-US.resx` make the nature clear — it is a **licence/edition gate**:

| Key | Text |
|---|---|
| `BaseTargets.SystemParamDlg.No5AxisPemission` | "|W|Unauthorized, please use pipe nesting steel structure encryption dog" |
| `BaseTargets.SystemParamDlg.…` | "Restricted functionality, enabling steel structure version is not allowed." |
| `EditTargets.ImportFileTarget.ImportITSteelNeedAuth` | "Import Isteel or Tsteel needs to use CamSoft!" |
| `EditTargets.NestTarget.NOEFFCTIVELICENCE` | "|F|Valid licence is not found. Please contact the manufacturer." |
| `EditTargets.NestTarget.LICENCEISEXPIRED` | "|F|The licence is expired. Please contact the manufacturer." |
| `NcEditorWPF.About…` | "The authorization was not detected, please contact the supplier or click for free trial." |

Findings on this machine:
- The title bar shows **`Login`** (not authenticated) — this install authorizes **online**
  (`https://api.weihong.com.cn/lockapi/login/*`), not by a local file.
- **No dongle** drivers/literals (`Rockey`/`HASP`/`Sentinel`/`Wibu`) and **no local licence
  file** exist under `UserConfig`.
- `SoftType=8192` / `ApplicationType=1` in `WiseCAM-Tube-Steel.exe.config` select the edition.
- So NC1 (DSTV) import, and I/T-steel import, require the **steel-structure (钢结构)
  authorization** ("encryption dog") from Weihong — or a login / **Free Trial** (About dialog).

**Implication for our tool:** the per-stock-beam output that must round-trip into WiseCAM
should be **STEP**, not `.nc1`, until the steel-structure licence is present. (This matches
AGENTS.md "try both — one will behave in WiseCAM.")

### The importer's own error strings

From `Resources\StringResources.en-US.resx` (search `ImportFileTarget`):

| Resource key | Text |
|---|---|
| `EditTargets.ImportFileTarget.Nc1ParseFail` | **"Nc1 file parsing failed!"** |
| `EditTargets.ImportFileTarget.ProfileError` | **"Configure the correct parameter mapping relationship!"** |
| `EditTargets.ImportFileTarget.TubeTypeError` | "The parsed pipe type is not supported!" |
| `EditTargets.NestTargetTube.ImportTubePartFailByMulTubeType` | "There are multiple tube types, import failed! Please split in nesting software." |

`ProfileError` = *"Configure the correct parameter mapping relationship!"* points squarely
at the configurable **field mapping** below.

### The ST header field-mapping mechanism

WiseCAM does **not** assume a fixed `ST` header layout. It has a *"NC1 Import Parameter
Mapping"* dialog (`BaseTargets.CNc1ParamSettingDlg`, title
`BaseTargets.CNc1ParamSettingDlg.TITLE` = "NC1 Import Parameter Mapping", opened from
*Params Setting* → `BaseTargets.SystemParamDlg.Nc1Config` = "Params Setting").

- Toggle: `UseNC1FileFieldInfo=1` in `[System]` of `NcEditor.ini`
  ("Use File Into When Import NC1").
- Storage (from `BaseTargets.dll` strings):
  section/key = `NC1FieldSettingParameter`, `NC1FieldSettingParameCount`,
  and per-field `NC1FieldSettingParame%d` with value format
  **`FieldName=%s;LineNumber=%d;`**.
- Fields (`BasicField*` / `IDC_STC_*`): `PartId, FileName, PartMaterial, PartCount,
  WebStartCut, WebEndCut, FlangeStartCut, FlangeEndCut, CodeProfile, FlangeWidth,
  ProfileHeight, Radius, FlangeThickness, WebThickness, SawLength, Line`.
- Also `EditTargets.ExportFileTarget.NC1FileNotSupport` = "Restricted file format, nc1
  file format is unsupported." (export side; may be gated by a licence/dongle —
  cf. `…No5AxisPemission` = "…please use pipe nesting steel structure encryption dog").

On this machine **no `NC1FieldSettingParame*` mapping exists in any config** — the tool
is using built-in defaults.

### (Superseded) parser hypothesis

Earlier we suspected the default field→line mapping, or the `** <filename>` comment Tekla
writes as the 2nd `ST` line, was the cause. The confirmed root cause is the **licence gate**
above — the parser is never reached. The field-mapping mechanism is still documented here
because it matters *if/when* the steel-structure licence is enabled.

### Related: `.step` `CheckTubeSize` failures

Some STEP parts fail with `Load File Error At :CheckTubeSize` — a hard **dimension range
check** against the configured tube, from the resx, e.g.
`|E|The width: %lf and height: %lf of rectangular tube is not within [%.3f, %.3f]. Import
file failed.` / "…of isteel tube…" / "…of tsteel tube…". Fix = widen the tube size range in
the stock/tube config, not the parser.

## 6. Live capture procedure (manual)

1. Find the current weekly log:
   `C:\WeiHong\WiseCAM-Tube-Steel\UserConfig\CadCamLog\NcCadCamLog-<YYYY>-<WW>w.txt`.
2. Record the baseline (line count / byte size) — `tools\wisecam-log.ps1 -Mode baseline`.
3. Reproduce in WiseCAM (drag the file onto the window, or **File → Import**).
4. Read only the new lines — `tools\wisecam-log.ps1 -Mode diff`.
5. The `Load File Error At :<stage>` line is the machine-readable reason.
6. **The real (human) reason is in the app's own on-screen Log panel**, not the file —
   bottom-right `Group id='Log'` (items `LaserTubeMainUserControl_TextBlock_13`). Read it
   with UI Automation (see `tools\wisecam-import.ps1` / the `Get-LogMessages` helper). This
   is where "Restricted file format, nc1 file format is unsupported." is shown.

## 7. Automation

Helpers in `tools\` (read-only; they never modify Weihong files):

| Tool | Purpose |
|---|---|
| `wisecam-log.ps1` | locate the weekly log, baseline / diff / watch, and parse import results to `OK` / `FAIL <stage>` per file |
| `wisecam-dump.ps1` | parse `NcEditorV15-*-DumpFile.dmp`; prints exception code (with meaning) + faulting module |
| `wisecam-import.ps1` | **drive the import dialog via UI Automation** (clicks *Add From File*, fills the Open dialog, clicks OK), then reports the result by reading the app **Log panel** + watching for new dumps |
| `wisecam-dbgout.ps1` | capture Win32 `OutputDebugString` traces (DebugView-equivalent, no install) |

`wisecam-import.ps1` is the automation backbone: it renders "import + detect why" as a loop
over files. The dialog is a standard `#32770` "Open" window (found by searching the desktop
**subtree**); the file field is the ComboBox with `AutomationId=1148`; OK is button `1`.
If UIA invoke is ignored, fall back to a real mouse click at the element's bounding rect.

Because there is no CLI, "auto experimentation" has these layers:

**A. Log capture & result summarisation (fully automated)** — `tools\wisecam-log.ps1`.
It locates the current weekly log, snapshots a baseline, and parses `Start / Error / Finish`
records into a compact **one line per file** result, optionally following the file live.
Drive a batch by importing many files in the GUI; the script prints `OK`/`FAIL <stage>` per
file. Example:

```powershell
# baseline before you start importing
pwsh tools\wisecam-log.ps1 -Mode baseline
# ... import files in WiseCAM ...
# summarise everything since the baseline
pwsh tools\wisecam-log.ps1 -Mode diff
# or follow live while you drag files in
pwsh tools\wisecam-log.ps1 -Mode watch
```

**B. Fully headless import (not currently possible).** The importer is native
(`Nc1ToCad_Tube.dll`, `Nc1Translator::TranslatorNc1File`) behind a GUI flow; there is no
documented entry point. Options if we need it later:
- Drive the GUI with **Windows UI Automation** (PowerShell `UIAutomationClient` /
  FlaUI) — open import dialog, paste path, click OK. Fragile but doable.
- Focus/activate the running window and synthesise the **drag-drop**/keystrokes.
- Ask Weihong for the NC1 field-mapping spec / a supported sample file and mirror it.

**C. Bisect the parser cheaply.** Generate NC1 variants from `a1.nc1` and import each,
using §7A to read the result:
1. remove the `** a1.nc1` comment line,
2. re-order pad/trim the `ST` header,
3. try a WiseCAM-native `.nc1` sample if one exists.
Whichever variant flips `LoadData`→success isolates the rule.

> Automation policy: the helper only **reads** the log. It never edits Weihong files.
> Enabling `LogDebugInfo`/`LogConfig` or changing the field mapping is a manual,
> documented change.

## 8. Next steps

- [ ] Authorize the steel-structure module (Weihong login / Free Trial / dongle) and re-test
      NC1 import — that is the only thing that will make `.nc1` work.
- [ ] Until then, **generate STEP** as the interchange format (§9) and test that path.
- [ ] If NC1 becomes available: *Params Setting → NC1 Import Parameter Mapping* and record the
      `NC1FieldSettingParame*` values.
- [ ] Run `tools\wisecam-import.ps1` over a folder of STEP files — this is the automated
      "import + detect why" loop.
- [ ] Reverse a WiseCAM-exported `*.ncex`/`*.n3dprt` sample to see if it is authorable (§9).
- [ ] Remember: **our generator currently emits `.nc1` per stock beam** — switch it to STEP.

## 9. Supported formats & what to generate

From `StringResources.en-US.resx` + the `*ToCad` translators present in the install.

### Tube-part import

`EditTargets.NestTarget.SUPPORT_FORMAT_IMPORT_TUBEPART`:

> `*.igs;*.iges;*.step;*.stp;*.ncep;*.ncex;*.n3dprt;*.nc1;*.t2w`

`EditTargets.NestTarget.SUPPORT_FORMAT_IMPORT_TUBEPART_NC` (**the un-licensed/"no-NC"
variant — note it drops `.nc1` *and* `.t2w`**):

> `*.igs;*.iges;*.step;*.stp;*.ncep;*.ncex;*.n3dprt`

`EditTargets.ImportFileTarget.SUPPORT_FORMAT_IMPORT_OnlyIGES` (neutral CAD only):

> `*.igs;*.iges;*.step;*.stp`

| Format | Ingest (no licence)? | Carries | Authorable by us? | Verdict |
|---|---|---|---|---|
| **STEP** `.step/.stp` | ✅ | true solid BREP: holes, slots, curves, mitres | ✅ (replicad/OCC, already used) | **best** |
| IGES `.igs/.iges` | ✅ | surfaces/curves (solids less reliable) | ✅ | fallback |
| DXF/DWG/PLT/G/NC | ✅ (2D) | flat/2D geometry, wrapped parts | ✅ | for flat/wrap only |
| NCEP `.ncep` | ✅ | WiseCAM part package (proprietary) | ❓ unknown | can't author yet |
| NCEX/NCEXA/NCEXB | ✅ | WiseCAM exchange / machining parts | ❓ | reverse-engineer maybe |
| N3DPRT `.n3dprt` | ✅ | WiseCAM 3D part (native) | ❓ | reverse-engineer maybe |
| **NC1** `.nc1` | ❌ **gated** | DSTV geometry **+ quantity + `SI` mark** | ✅ (we have a writer) | blocked |
| **T2W** `.t2w` | ❌ **gated** | Tekla→WiseCAM tube (3D) | ❌ | blocked |

### Export

- **G-code / NC** (`*.g;*.nc`) — the machine output (`OpfExtendMetaData=machinetype=…`).
- **NCEX/NCEXA** exchange + machining parts; **SVG**; **DXF**.
- **NC1 export** is the same gated path (same "unsupported" message).

### Recommendation

1. **Use STEP (AP214/AP203) as the interchange format.** It is the only *full-BREP* format
   that (a) we can generate and (b) this un-licensed install still imports. It preserves the
   holes/curves/mitres AGENTS.md requires, and the STEP path is testable today.
2. Keep the **part mark/etch as modelled geometry** in the STEP (engraved thin contours using
   the bundled Liberation Sans), since quantity/marking are not carried by STEP.
3. Treat `NCEX`/`N3DPRT` as a possible future upgrade: they are the *native* formats and may
   carry quantity + marking + techniques, but they are proprietary. To evaluate, export a
   sample from WiseCAM and inspect its container before investing.
4. Do **not** depend on `.nc1`/`.t2w` in the automated pipeline until the steel-structure
   licence is present.

## Sources / cross-refs

- `docs/nc1-dstv-format.md` — DSTV87 block/header reference.
- Bundled manual: `Resources\UserManualRes_en-US.chm` (extract with
  `hh.exe -decompile <dir> <chm>`).
- Weihong WiseCAM Tube: <https://www.weihong.com.cn/en/products/detail/121>
