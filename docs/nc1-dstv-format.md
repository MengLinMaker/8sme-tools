# NC (`.nc1`) & STEP formats — references

Research notes for the 8SME tools. The `.nc1` files in a job are **not** Weihong-specific:
they are **DSTV NC** files exported by **Tekla Structures**.

## `.nc1` = DSTV NC (DSTV87)

- **DSTV** = *Deutscher Stahlbau-Verband*. It is an industrial, machine-neutral text format
  for describing structural-steel parts to NC machines ("Standard Description for Steel
  Structure Pieces for the Numerical Controls", a.k.a. **DSTV 87**).
- Tekla Structures exports it; extension is `.nc1`. Widely supported by CNC software
  (drills, plasma/laser, saws) — including **Weihong WiseCAM**, which is why the shop imports it.
- ASCII text, organised as **blocks**: a two-letter code on its own line, then indented data
  lines, until the next code.

### Blocks

Official DSTV 87 "code blocs" (7th corrected edition, §code-block table):

| Code | Meaning | German |
|---|---|---|
| `ST` | **Start** — beginning of the piece description (header) | Start |
| `EN` | **End** — end of the piece description | Ende |
| `BO` | Holes (plain, slotted, counterbore/stepped, threaded) | Bohrung |
| `SI` | Numbering / **marking** (the etch text) | Signierung |
| `AK` | External contour: end cuts, copes, miters, bevels | Außenkontur |
| `IK` | Internal contour: rectangular openings / cut-outs | Innenkontur |
| `PU` | Powder / scribe layout marking | Pulver |
| `KO` | Mark (centre/punch dot) | Körner |
| `SC` | Cut (saw, cutting) — the special 3-D cuts `AK` cannot express | Schnitt |
| `TO` | Tolerance | Toleranz |
| `UE` | Camber | Überhöhung |
| `PR` | Profile description | — |
| `KA` | Bending / bend lines (plates) | Kanten |
| `En` `Bn` `Sn` `An` `In` `Pn` `Kn` | the same block on **numbered plane n** (`n` = 0…9) | — |
| `**` | **Comment line** (free text; must survive a re-export) | — |

Syntax: the code block occupies columns 1–2 and the rest of its line is empty; **data lines
start with two spaces**; the separator is a space (a letter↔number transition also separates).

### Face codes (first token of a data line)

`v` = front / web (Vorderseite) · `o` = top (Oben) · `u` = bottom (Unten) · `h` = behind
(Hinten). The standard's own legend: **V = Web = front face, U = Bottom, O = Top, H =
Behind**; `Np` = zero point, `T` = displacement (transport) direction.

Coordinates are **per face**: X along the member from the start end (the smallest X of a piece
is `0.0`), Y within that face. The letters name the profile's four *view directions* in the
machine's reference planes; **which physical surface each is depends on the profile type and
stance** — see `docs/canonical-orientation.md` §3. Skew cuts: the **web** skew cuts are shown
in the front (`v`) view, the **flange** skew cuts in the bottom (`u`) view.

### `ST` header (order matters)

Each header field is prefixed with `2x` (two leading spaces). Official order, per the DSTV 87
header-data table:

| # | Field | Unit |
|---|---|---|
| 1 | Order identification | text |
| 2 | Drawing identification | text |
| 3 | Phase identification | text |
| 4 | Piece identification (mark) | text |
| 5 | Steel quality (grade) | text |
| 6 | Quantity of pieces | integer |
| 7 | Profile | text |
| 8 | Code profile (type letter) | text |
| 9 | Length, Saw length | mm |
| 10 | Profile height | mm |
| 11 | Flange width | mm |
| 12 | Flange thickness | mm |
| 13 | Web thickness | mm |
| 14 | Radius | mm |
| 15 | Weight by meter | kg/m |
| 16 | Painting surface by meter | m²/m |
| 17 | Web start cut | degree |
| 18 | Web end cut | degree |
| 19 | Flange start cut | degree |
| 20 | Flange end cut | degree |
| 21–24 | Text info on piece (×4) | text |

> **The skew-cut angles are mandatory** (given in any case). For plate/sheet (`B`) profiles the
> geometry columns map to width / thickness instead.

### `BO` (holes)

`face  X  Y  diameter  [depth/angle …]`. Slotted holes and counterbores add fields (a
counterbore is often two paired lines). Suffix letters on coordinates indicate the
reference edge.

Slotted holes carry a fabrication letter `l` after a `ttt.tt` code field, then three values:
`face X Y diameter ttt.ttl width height angle`. `X`/`Y` is the slot's **start end centre**
(not its centre); `width`/`height` are the slot vector to the far end *before* rotation and
`angle` (deg, CCW) rotates it to the slot's true direction — e.g. `0.00l 0.00 10.00 69.95` is a
10 mm end-to-end slot tilted ~20° off the face's Y axis. The slot index ignores the tilt if only
`width`/`height` are used (see `slotOffset` in `src/lib/parsers/ncGeometry.ts`).

### `AK` / `IK` (contours)

Polyline of X/Y vertices; a third value is a **bulge/radius** (arc to the next vertex),
which is how curved copes/miters appear.

### Profile types

Official "code profile" list (the `ST` header's profile-type field):

| Code | Profile |
|---|---|
| `I` | I profile (our UB / UC / TFB) |
| `L` | L profile (angle) |
| `U` | U profile (channel / PFC) |
| `B` | Sheets, plate, teared sheets, etc. |
| `RU` | Round (solid bar) |
| `RO` | Rounded tube (CHS) |
| `M` | Rectangular tube (RHS / SHS) |
| `C` | C profile (cold-formed) |
| `T` | T profile |
| `SO` | Special profile |

> Per the standard §"Used Profiles". Note **`RO` = tube, `RU` = solid bar** — the two letters are
> easy to swap (our earlier notes had them backwards).

### Value formats

| Value | Unit | Format |
|---|---|---|
| Free text | – | `a` (left-aligned, ≤ 80 chars) |
| Integer | – | `i` |
| Length | mm | `f` |
| Angle | degree | `f` |
| Weight by metre | kg/m | `f` |
| Painting surface by metre | m²/m | `f` |
| Empty column | – | `x` |

Angles are positive **anti-clockwise** (mathematical orientation). Lengths are millimetres.

### Coordinate system & standard views

Every face is a 2-D "sheet": **X runs along the member** (from the start end; the smallest X of a
piece is `0.0`) and **Y across that face**. The four faces unfold around the profile as **Front
(`v`) / Top (`o`) / Bottom (`u`) / Behind (`h`)**. The zero point (`Np`) and transport
(displacement) direction (`T`) are marked in the standard's per-profile scheme (page 7); the
reference *pose* differs by profile type — see the face maps in `docs/canonical-orientation.md`
§3.

> This matches our files exactly: `ST` → `CO-7255` (order) → mark → grade `C300` →
> qty → profile `BT100*15` → type **`T`** → length → dims `[b, d/2, tf, tw, r, …]`, then
> `AK`/`BO` blocks with `v`/`o`/`u`/`h` faces. The `BO` rows (e.g. `v 135.08 24.56 14.00`)
> are the **Ø14 holes** that match the drawing's “8 - 14 Ø HOLES”.

## STEP (`* .stp/.step`)

- **ISO-10303-21**, AP214 (`AUTOMOTIVE_DESIGN`) from Tekla/OpenCASCADE.
- Holds the true 3D BREP (surfaces, holes, curves, miters) but **no quantity** — which is
  why WiseCAM drops quantity on import (use the DSTV `ST` quantity or the `.xlsx` part list).
- Public specification: ISO 10303. Parsed here via `replicad`/OpenCASCADE (WASM).

## Weihong G-code (NcStudio) — the machine language

WiseCAM translates DSTV/STEP into **Weihong NcStudio G-code**, which the controller executes.
It is essentially standard ISO G-code plus Weihong extensions (not the DSTV input format).

- Modal groups: **G00** rapid, **G01** linear, **G02/G03** circular (CW/CCW) — `G1 X_Y_Z_F_`
  or `G2 X_Y_Z_I_J_K_F_` / `R_`.
- Coordinates/WCS: **G17/G18/G19** planes, **G53** machine coords, **G54–G59** workpiece
  coordinate systems, **G68/G69** rotation, **G90/G91** absolute/incremental, **G92/G921/
  G922** set WCS, **G20/G21** inch/metric.
- Canned cycles: **G73–G89** drilling/boring cycles, **G80** cancel.
- Spindle/laser power: `M03`/`M05` on/off (laser power on/off), plus `M`, `S`, `F`, `T`.
- Subprograms & expressions: `M98`/`M99`, `M801`/`M802` module data, `#` variables.

Manual: **NcStudio Programming Manual R6.1** —
<https://weihong-gw.oss-cn-hangzhou.aliyuncs.com/product/Software%20support/Developer%20tool/NcStudio%20Programming/NcStudio%20Programming%20Manual-R6.1.pdf>.
Laser control (LS3000):
<https://forsuncnc.com/wp-content/uploads/2022/02/Fiber-laser-of-Ncstudio-V15-Laser-Cutting-LS3000-CNC-Control-System-R1.pdf>.
WiseCAM Tube (produces the toolpath): <https://www.weihong.com.cn/en/products/detail/121>.

## Validating our parsing with the existing ecosystem

Rather than trust our own DSTV parser, **cross-check against a proven implementation**:

- **Dev-time validator**: run the Rust [`dstv`](https://github.com/tluijken/dstv) crate or the
  Python [`dstvparser`](https://github.com/serg-you-lin/dstvparser) over the same job files and
  compare header + element counts/positions (holes, contour vertices) with ours.
- **Manual spot-check**: open a file in [NC1-Viewer.com](https://www.nc1-viewer.com) and compare
  the rendered holes/contours to our output.
- Optionally compile the Rust `dstv` crate to **WASM** so the validator runs in-app.

## Sources

- **DSTV 87 standard** (7th corrected ed.) — *Standard Description for Steel Structure Pieces for the Numerical Controls*, Tekla-hosted PDF: <https://support.tekla.com/dist/sxf/document/dstv_nc_eng.pdf> — pp. 5–9 are the source of the block, unit, profile-code, coordinate and header tables transposed above.
- Tekla — DSTV file description: <https://support.tekla.com/doc/tekla-structures/2026/int_nc_dstv_file_description>
- Tekla — Creating NC files (DSTV / BO block notes): <https://support.tekla.com/doc/tekla-structures/2020/int_create_nc_files>
- Klietsch — DSTV/NC1 overview (profile types, blocks): <https://klietsch.com/?action=240827&lang=en&m=page>
- NC1-Viewer — block codes reference: <https://www.nc1-viewer.com/guides/dstv-block-codes>
- NC1-Viewer — profile types: <https://www.nc1-viewer.com/guides/dstv-profile-types>
- Kinetic USA — DSTV import supported blocks: <https://www.kineticusa.com/PrimecutHelp/dstv_file_format.html>
- Tectonix — what an NC1 file contains: <https://www.tectonixsteel.com/fabricator-faq/what-is-dstv-nc1-file-format>
- The Fabricator — file-export fundamentals (plain-language `v`/`o`/`u`/`h` + machine clearances): <https://www.thefabricator.com/thefabricator/article/cadcamsoftware/file-export-fundamentals-in-structural-steel-fabrication>
- Weihong — WiseCAM Tube (producer of the toolpath the machine runs): <https://www.weihong.com.cn/en/products/detail/121>
- Weihong — NcStudio G-code programming manual: <http://doc.weihong.com.cn:8889/en-us/doc/gcode_programming/index_en.html>

## Existing DSTV / NC1 tools & libraries

| Tool | Lang | What it does | Licence |
|---|---|---|---|
| [tluijken/dstv](https://github.com/tluijken/dstv) | Rust | Parses DSTV NC/NC1, renders **SVG**. Element types: OuterBorder(AK), InnerBorder(IK), Hole(BO), Numeration(SI), Bend, Slot, Cut. | MIT |
| [serg-you-lin/dstvparser](https://github.com/serg-you-lin/dstvparser) | Python | Parses `.nc`/`.nc1`, header + geometry, inclined-cut detection. | (repo) |
| [azwsd/OpenSteel](https://github.com/azwsd/OpenSteel) | JS (web) | **Viewer + steel profile library + linear nesting**; imports multiple NC1. Blocks BO/AK/IK/SI/PU/KO. Konva.js + jszip. | Non-commercial |
| [NC1-Viewer.com](https://www.nc1-viewer.com) | Web | Free online viewer/editor; runs client-side. | Free |
| Klietsch *DSTV Assistant* | Desktop | Converts between DSTV variants / edits. | Commercial |
| Tekla `DSTVtoDXFConverter.exe` | Desktop | DSTV → DXF. | Tekla |

Notes:
- **No maintained npm/TypeScript DSTV library** — but the format is simple line/token text, so
  parsing `AK`/`IK`/`BO`/`SI` ourselves is small.
- **OpenSteel** is the closest to what we want (viewer + nesting) — but its licence is
  **non-commercial**, so treat it as a reference only, don't copy code.
- The **Rust** `dstv` crate and **NC1-Viewer** are useful for cross-checking our parser output.

## Implications for these tools

- **Visualise from `.nc1`**: parse `AK`/`IK` (contours) and `BO` (holes) to draw a part even
  when its STEP is corrupt (e.g. `m170`, `m198`, `m217` on NW31 Top).
- **Etch = `SI` block** in DSTV: emit an `SI` block (face, X, Y, text height, angle, text) to
  carry the part mark, rather than a home-grown token.
- **Quantity** comes from the `ST` header / part list, never from STEP.
- The DSTV ST header already encodes the **profile type `T`** and the fingerprint dims, which
  is exactly what `inferParentUb` reconstructs.

## See also

- **`docs/ncexa-format.md`** — WiseCAM's own native `.ncexa` exchange format (OPC/ZIP +
  `CAD/CadRoot.xml` + SVGs + `.zua` toolpath). It carries **quantity + marking** natively; its
  layer-6 `打标` mark text is the native counterpart of the DSTV `SI` block, and
  `Result.PartInfo` the counterpart of the `ST` quantity.
