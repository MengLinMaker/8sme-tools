# WiseCAM supported formats — what carries orientation, cuts & bevels

Research notes for the 8SME tools. Source of truth: the bundled WiseCAM Tube manual
(*管切独立套料版软件用户手册（管切、钢构、坡口三合一）*, R3, 2024-10-18) plus the
`StringResources.en-US.resx` import filters in the installed build. Read with
`docs/nc1-dstv-format.md` (DSTV), `docs/ncexa-format.md` (native package) and
`docs/canonical-orientation.md` (our stance rules).

> **TL;DR** — **3D files (STEP / IGES / N3DPRT) carry orientation**, and STEP also carries
> cut lines and bevels as real geometry. **NC1 does not carry a machine stance at all** (only
> the DSTV face convention), which is why re-emitting it cannot rotate a part. **NCEX/NCEXA**
> carries stance explicitly (`RotateStyle` / `RotateAngle` / `Invert`). Use STEP in our
> canonical stance for orientation + cuts + bevels; use NCEXA only if per-part stance must be
> dictated.

---

## 1. Import list — observed from the app

Observed directly in the installed WiseCAM's **Add from File** dialog. This is runtime ground
truth and outranks the manual and the resource strings.

| Dialog entry | Extensions | Notes |
|---|---|---|
| IGES | `.igs` `.iges` | 3D surfaces |
| STEP | `.step` `.stp` | 3D BREP |
| NCEP | `.ncep` | native part package |
| NCEX | `.ncex` | native exchange part — **importable** |
| N3DRPT | `.n3dprt` (manual spells `.n3dpart`) | native 3D part |
| NC1 | `.nc1` | Tekla DSTV87 |
| Tekla file | `.t2w` (only leftover in the filter) | Tekla→WiseCAM tube; licence-gated |

**`.ncexa` is *not* in the Add-from-File list.** It is an **export** (machining part / nest
result) that opens directly in the cutting software — it is not re-imported into WiseCAM. The
importable native exchange format is **`.ncex`**.

Corroborating resource filter (`SUPPORT_FORMAT_IMPORT_TUBEPART`):

```
*.igs;*.iges;*.step;*.stp;*.ncep;*.ncex;*.n3dprt;*.nc1;*.t2w
```

The unlicensed "no-NC" filter (`SUPPORT_FORMAT_IMPORT_TUBEPART_NC`) drops `.nc1` and `.t2w`.

### Export list

| Export | Ext | Purpose |
|---|---|---|
| Export part | `.ncep` | part library for re-nesting (one file per part) |
| Export machining part | `.ncexa` | opens directly in the **cutting software** (controller) |
| Export nest result | `.ncex` / `.ncexa` | project / machining package |
| Save / Save As | `.ncex` | project file (re-importable) |

> **Licensing:** export (`Export part` `.ncep`, `Export machining part` `.ncexa`, and Save As
> `.ncex`) is **gated in the free/trial install** — the `.ncexa` samples in this repo were
> produced on a licensed machine. This does **not** block validation: an import test needs
> WiseCAM to *read* our file, not write one. For a ground-truth `.ncex`, the **CAD-only**
> `.ncexa` samples are the same `application/ncex+zip` container — try renaming one to `.ncex`
> and Add from File. (Whether `.ncex` *import* is also gated is unconfirmed; NC1 import is, STEP
> import is not.)

---

## 2. Capability matrix

| Format | 3D? | Orientation | Cut lines | Bevels | Quantity | Mark / etch |
|---|---|---|---|---|---|---|
| **STEP** `.step/.stp` | ✅ BREP | ✅ absolute coordinates (extrusion axis detected on import) | ✅ real cut faces/edges | ✅ real angled faces; needs **识别坡口** on import | ❌ | geometry only (engrave) |
| **IGES** `.igs/.iges` | ✅ surfaces | ✅ absolute coordinates | ✅ curves/surfaces | ✅ as surfaces (less reliable than STEP) | ❌ | geometry only |
| **N3DPRT/N3DPART** `.n3dprt/.n3dpart` | ✅ native 3D | ✅ (native) | ✅ native | ✅ native | ❓ | ✅ native |
| **NCEX/NCEXA** `.ncex/.ncexa` | ⚠️ 2.5D package | ✅ `RotateStyle`/`RotateAngle`/`Invert` + `matrixinfo3d` + toolpath `B` | ✅ SVG layers 0/1 | ⚠️ via technology + `B` axis (`HasBevel`, `machinetype=bevel`) | ✅ `Part.TotalCount` / `Result.PartInfo` | ✅ layer 6 (打标) |
| **NCEP** `.ncep` | ⚠️ part package | ❓ (native part export) | ✅ | ✅ | ✅ | ✅ |
| **NC1** `.nc1` | ❌ | ❌ **no stance field** — only DSTV face letters | ✅ `AK`/`IK`/`BO` | ✅ vertex bevel columns | ✅ `ST` qty | ✅ `SI` block |

Legend: ✅ carried · ⚠️ conditional · ❌ not carried · ❓ not yet reverse-engineered.

---

## 3. How orientation is encoded, per format

### 3.1 STEP / IGES — orientation *is* the coordinates

A STEP/IGES part is a real 3D BREP, so its orientation is literally its XYZ coordinates.
On import WiseCAM asks for:

- **识别装配体** (recognise assembly): on → split an assembly into parts; off → the software
  can only recognise **one part extruded along X, Y or Z**.
- **拉伸方向** (extrusion direction): **自动** (auto-match X/Y/Z) or **非 XYZ** (non-axis;
  the parameter is greyed out).
- **识别坡口** (recognise bevel): must be **on** for a bevel file to be read as a bevel;
  otherwise it is treated as a plain (no-bevel) toolpath.

Consequence: a STEP written in our canonical stance is imported in that stance. This is the
only format we can both author and use to dictate orientation today.

### 3.2 NC1 — no stance, by design

DSTV carries the four face letters (`v/o/u/h`) and per-face coordinates, anchored to the
**profile's standard reference pose**. There is no field for the machine/clamp rotation:

- `ST` fields 17–20 are **web/flange start/end cut angles** (bevel/mitre), not part rotation.
- WiseCAM builds the section in **its own default stance** for the profile type.

Empirically (from the `.ncexa` WiseCAM produced for `Base 2 Hidden Grove`):

| Family | WiseCAM stance in `.ncexa` | Matches our canonical? |
|---|---|---|
| **I** (UB/WB/UC/WC/TFB) | web **vertical** (depth vertical) | ❌ ours is `H` (depth horizontal) |
| **U/C** (PFC/TFC) | web **horizontal** (depth horizontal) | ✅ ours is `n` |
| **M** (RHS/SHS) | long side **horizontal** | ✅ ours is long-horizontal |
| **T** | not exercised by that job | — (see T open item) |

So for NC1: an I-section lands web-vertical regardless of what we write; rotating face
letters/coordinates produces a different physical part, not a rotated stance.

### 3.3 NCEX / NCEXA — explicit per-part stance

`CAD/CadRoot.xml` `<Part>` params carry:

```
RotateStyle=0; RotateAngle=0; Invert=0;
```

These almost certainly encode WiseCAM's **截面工艺 (section technics)** — the field names match
and there is no other stance data in the package. To confirm, apply a section rotation in
WiseCAM, re-export, and diff `CadRoot.xml` (see §6 of `docs/ncexa-format.md`):

- **7.4.7 旋转截面 (rotate section)** — "adjust the part's tube section to match the actual
  machining position so the chuck/fixture can clamp it". Options: auto-recommend
  (90° first turn, 45° second, then repeat), custom angle (special sections only), apply to
  current section / all parts with the same section; CW / CCW / reset buttons. Writes the
  part's `RotateAngle`.
- **7.4.8 镜像截面 (mirror section)** — mirror about the **YOZ** plane (horizontal flip about
  the front view's vertical centre line); special-shaped tubes only. Writes `Invert`.

Every sample we have (2 Hidden Grove, 26 Luenard Balwyn North, per-beam exports) has
`RotateStyle=0; RotateAngle=0; Invert=0`, i.e. none of them apply a section rotation.

**The part SVG is a *partial* unrolling of the visible/outer surface (not a 3D projection).**
WiseCAM develops the outer faces into a rectangle — `x` = perimeter station (centred on the
seam), `y` = along the member. Confirmed on a PFC: the seam is **580 mm** (web 380 + two flange
backs 100 + 100), *not* the 1128 mm full outline perimeter.

The greyed region in the viewer is the **occluded/inner side** of the section (flange insides,
corners, inner wall), not a separate lane. The operator's rule of thumb is that **nothing should
be drawn there** (features may spill onto the edge). The part is still manufactured all round —
the 3D viewer simply does not draw the hidden side — and the 2D lines run to the seam edge as if
continuing onto the back of the flanges/corners.

Holes are `<circle cx=station cy=along>` on the outer development. How a feature that exists
**only** on the hidden/inner side (`h`, inner wall) should be encoded is still open: every `h`
`BO` line in the 2 Hidden Grove job is a Ø0 mark (`m`), not a hole, so there is no worked
example. Until one is found, treat hidden-side cuts as NC1 territory.

**Worked I-section example (UB310\*32, M-3).** WiseCAM's seam is **728.34 mm**, split as:

```
o flange  149 | corner gap 66.17 | v web 298 | corner gap 66.17 | u flange 149
[-364.17 … -215.17]        [-215.17 … -149]      [-149 … 149]      [149 … 215.17]   [215.17 … 364.17]
```

Station rules from the NC (verified against `part235.svg`): `o → -364.17 + y`,
`v → -149 + y`, `u → +215.17 + y`. The gaps are the flange/web corner regions (the greyed
areas) and should normally be empty.

> **WiseCAM bug — UB import draws holes in the corner gap.** M-3 has 8 real `o` Ø14 holes but
> WiseCAM's part SVG contains 12 `o`-size circles: one **extra per pair**, at `cx = -185.42`,
> which lies inside the `[-215.17, -149]` corner gap. It is `layer=0;machining=1`, so WiseCAM
> treats it as a real cut. Our writer must place `o` holes only at `-364.17 + y` and **never**
> mirror them into the gap.

Other orientation carriers in the package:

- `matrixinfo3d="r00,r01,r02,tx r10,… "` on placed `cadpart` instances in the result SVG
  (identity in all samples).
- Toolpath `B=` (tube rotation) in `CNC/Plate*.zua` (e.g. `B=0`, `B=-90`,
  `B=89.9999999999` for a 90° face).

### 3.4 N3DPRT / NCEP

Native WiseCAM 3D part / part-package formats. Not yet reverse-engineered (no samples in the
repo). They are the *native* path and should carry orientation, cuts and bevels, but treat
them as unknown until a sample is imported/exported and inspected.

---

## 4. What the 2 Hidden Grove comparison proved

`Base 2 Hidden Grove` (original) vs `Exported 2 Hidden Grove` (through our app):

- **All 62 shared `.nc1` files are token-identical** — only leading whitespace differs
  (our re-emit normalises indentation). No coordinate, face letter, hole or contour changed.
- **WiseCAM's `.ncexa` renders identical geometry** for every shared mark (identical SVG `d=`
  paths, identical Adobe/SVG, identical `Part` params). So the NC path is orientation-neutral.
- The only functional difference: `M-2`, `M-36`, `M-61` failed to import in Base but import in
  Exported (whitespace normalisation fixed them); `M-10`, `M-41` still fail in both.

Conclusion: **the NC1 export cannot be the cause of a wrong stance.** To change how a part is
imported you must change the format (STEP/NCEXA), not the NC bytes.

---

## 5. Guidance for these tools

1. **Use STEP as the orientation + geometry interchange.** Export in our canonical stance
   (already done by the preflight seating). On import the operator must:
   - leave **自动** extrusion direction on (or set **非 XYZ** for an oblique member),
   - tick **识别坡口** when the part has weld prep.
2. **Do not try to encode stance in `.nc1`.** It has no field for it; a "rotated" NC1 is a
   different part. Our faithful re-emit is correct.
3. **If per-part stance must be dictated**, target the importable **`.ncex`** (not `.ncexa`,
   which is export-only to the cutting software): a CAD-only NCEX container with
   `RotateAngle` / `Invert` on each `<Part>`, and quantity in `TotalCount`. An experimental
   writer exists at **`src/lib/wisecam/ncex.ts`** (`buildNcex`); it emits the OPC/ZIP
   container, `CadRoot.xml`, an unrolled part SVG (section + straight end cuts + holes at
   perimeter stations) and the minimal CNC root. The unrolled seam/hole convention is
   validated against WiseCAM's own PFC `part230.svg`; I/T/angle stations and bevelled end
   contours still need samples, and the whole thing needs a real WiseCAM Add-from-File test
   before trusting it.
4. **Bevels** survive in STEP as geometry, but only if **识别坡口** is enabled on import. In
   NC1 they are the explicit vertex bevel columns; in NCEXA they need the bevel machine mode /
   `machinetype=bevel` and `B`-axis toolpath.
5. **Quantity** is not in STEP (WiseCAM drops it). It lives in NC1 `ST`, NCEXA
   `Part.TotalCount`/`Result.PartInfo`, or the `.xlsx` part list.
6. **Marking/etch** is DSTV `SI` (NC1) or layer 6 打标 (NCEXA); in STEP it must be modelled as
   thin geometry.

---

## 6. Sources

- Bundled manual: `Resources\UserManualRes_en-US.chm` — *WiseCAM-Tube 管切独立套料版软件用户手册
  （管切、钢构、坡口三合一）R3*, 2024-10-18. §5.1 (import formats, assembly/extrusion/bevel),
  §7.4.6–7.4.8 (section technics: rotate / mirror), §12 (export .ncep/.ncex/.ncexa).
  Online copy: <https://weihong-gw.oss-cn-hangzhou.aliyuncs.com/product/> (WiseCAM Tube manual R3).
- `StringResources.en-US.resx` in the installed build — `SUPPORT_FORMAT_IMPORT_TUBEPART`,
  `SUPPORT_FORMAT_IMPORT_TUBEPART_NC`, `SUPPORT_FORMAT_IMPORT_OnlyIGES`,
  `NC1FieldSettingParameter`.
- WiseCAM Tube product page: <https://www.weihong.com.cn/en/products/detail/121>
- Cross-refs: `docs/nc1-dstv-format.md`, `docs/ncexa-format.md`,
  `docs/canonical-orientation.md`, `docs/wisecam-debugging.md`.
- Samples: `~/Downloads/Base 2 Hidden Grove`, `~/Downloads/Exported 2 Hidden Grove`,
  `~/Downloads/26 Luenard Balwyn North`.
