# WiseCAM `.ncep` — format notes & open questions

Reverse-engineering notes for the **NCEP part package** (`*.ncep`), the CAD-only container
WiseCAM's *Add from File* imports. NCEP is **proprietary and undocumented** — there is no public
specification (web searches for "NCEP" return NOAA weather). Everything below comes from 17 real
exports in `~/Downloads/NCEP samples 2 Hidden Grove` (copied to `test/fixtures/ncep/`) plus the
WiseCAM Tube manual §5.1 / §12.1.

Read with `docs/ncexa-format.md` (the shared NCEX container) and `docs/wisecam-formats.md`.

Status: **container + unrolled geometry for PFC/UB/RHS and the reference canonical/marking
variations are decoded; T/angle/round, full bevel generation and some metadata are still open.**
A live Add-from-File test on the licensed machine is the only proof of correctness.

---

## 1. What an NCEP is

- A **ZIP** whose first, **stored** entry is `mimetype` = `application/ncex+zip` (20 bytes, no
  newline).
- An OPC-style package: `META-INF/container.xml` → `CAD/cad.opf`, `CNC/cnc.opf`,
  `ncex.opf`. **The `CNC/` payload is absent** even though the container still lists it.
- **CAD-only**: one stock *Adobe* + one *Part* + their SVGs + technology tables. No toolpath is
  shipped; WiseCAM regenerates it on import.

### File map (real `M-1.ncep`)

```
mimetype                     stored, 20 bytes
META-INF/container.xml       stored
ncex.opf                     manifest (CAD files only)
CAD/cad.opf                  metadata + <cad><item href="CAD/CadRoot.xml"/>
CAD/CadRoot.xml              Adobes + Parts + BaseZone
CAD/Technology.xml           32,316 bytes; 8 layers (cut/punch/mark params)
CAD/CustomizeData.xml        ZoneBlock with 8 empty <customize> stubs
CAD/adobe1843525.svg         stock layout + applied cut paths (3 groups)
CAD/part1843526.svg          unrolled part (start/end trims + section + holes + text/mark bars)
```

ZIP details from the real sample: `mimetype` and `container.xml` are **stored** (method 0);
CAD files are deflated with general-purpose **flags = 6**; `ncex.opf` flags = 0.

---

## 2. Package documents (real M‑1 excerpts)

### `META-INF/container.xml`

```xml
<?xml version="1.0"?>
<container version="1.0" xmlns="http://www.weihong.com.cn/phoenix/ncex">
  <rootfiles>
    <rootfile full-path="CAD/cad.opf" media-type="application/ncex-package+xml"/>
    <rootfile full-path="CNC/cnc.opf" media-type="application/ncex-package+xml"/>
    <rootfile full-path="ncex.opf" media-type="application/ncex-package+xml"/>
  </rootfiles>
</container>
```

### `ncex.opf`

```xml
<?xml version="1.0" encoding="UTF-8" ?>
<package>
    <metadata xmlns="http://www.weihong.com.cn/phoenix/ncex" version="1.0">
        <identifier>2.0.0.0</identifier>
        <title>laser_tube</title>
        <LCSteelFullPath>0</LCSteelFullPath>
        <cnc_laserzua>6.956.20.0</cnc_laserzua>
        <cnc_layerparam>1.0.0.0</cnc_layerparam>
        <machinetype>straight</machinetype>
        <modifier>professional</modifier>
        <remarker>professional</remarker>
        <source>professional</source>
    </metadata>
    <manifest>
        <item href="CAD/CadRoot.xml" />
        <item href="CAD/cad.opf" />
        <item href="CAD/Technology.xml" />
        <item href="CAD/CustomizeData.xml" />
        <item href="CAD/adobe1843525.svg" />
        <item href="CAD/part1843526.svg" />
    </manifest>
</package>
```

### `CAD/CadRoot.xml`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<cadroot version="1.0" xmlns="http://www.weihong.com.cn/cadcam">
 <Adobes>
  <Adobe idref="1843525" svgname="adobe1843525.svg"
    params="Type=8199;Name=M-1;Thickness=9.9999999999993321;LegThickness=17.500000000000114;
            OuterLeadLength=2;OuterLeadOutLength=2;OuterLeadDir=0;Length=3000;RCornerMaxRadius=5;
            Area=0;TotalCount=1;NestedCount=0;"
    technologyID="C067B776-7314-4F4B-AA8F-639D6989CFE6"/>
 </Adobes>
 <Parts>
  <Part idref="1843526" svgname="part1843526.svg"
    params="Type=8199;Name=M-1;TotalCount=1;NestedCount=0;Thickness=9.9999999999993321;
            LegThickness=17.500000000000114;Area=0;RotateStyle=0;Priority=5;
            RotateAngle=0;Invert=0;"/>
 </Parts>
 <BaseZone idref="1843523" count="0" adobeid="1843525"/>
</cadroot>
```

Observed conventions:

| Field | Real value | Notes |
|---|---|---|
| `Type` | `8195` tube · `8199` channel · `8200` I | enum not documented |
| `Name` (Part) | the **mark** (`M-1`) | not the profile; authoritative over `LabelContent`/`<text>` |
| `Length` (Adobe) | `3000` in every sample | base-stock template, not the part length |
| `RCornerMaxRadius` | `5` for I/U; the section radius for tubes | |
| `technologyID` | a **valid GUID**, unique per part, **not** present in `Technology.xml` | format matters; meaning unknown |
| `BaseZone idref` | same value as `CustomizeData`'s `ZoneBlock idref` | |
| `adobeid` | the Adobe `idref` | |
| `TotalCount` | quantity | real samples = 1; probe `Part.TotalCount=2` survives re-export |
| `RotateStyle/RotateAngle/Invert` | stance knobs | real samples = 0/0/0; probes keep the flags but do not bake them into the part SVG |

### `CAD/CustomizeData.xml`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<root xmlns="http://www.weihong.com.cn/cadcam">
 <ZoneBlock idref="1843523">
  <customize id="0" params=""/>
  <customize id="1" params=""/>
  ...
  <customize id="7" params=""/>
 </ZoneBlock>
</root>
```

---

## 3. The part SVG — unrolled surface

WiseCAM develops the **cuttable/front surface** into a rectangle:

- **x = perimeter station** (mm)
- **y = distance along the member** (mm)

Only the front surface is developed. For an I-section that is the two flange outer faces + the
web; the inner/back faces are not drawn (the viewer greys them out). A feature that only exists
on the hidden side is not represented here.

### Structure (representative real part SVG)

```xml
<svg version="1.1" xmlns:wh="http://www.weihong.com.cn/cadcam" ...>
 <style>… .layer0 … .layer4 … .layer6 …</style>
 <g wh:id="15280187" wh:class="cadpart" wh:layer="-1" wh:isfill="0" wh:machining="1"
    wh:refid="1843526" wh:matrixinfo3d="1,0,0,0 0,1,0,0 0,0,1,0" class="layer-1">
  <path ... d="M-290,0 L290,0" wh:params="IsTrucate=1;TrucateType=0;InnerCad=…"/>
  <circle ... cx="-240.00" cy="135.00" r="11.00"/>
  …
  <rect wh:class="cadrectangle" wh:layer="6" wh:isfill="0" wh:machining="1"
        x="-126.30" y="40" width="252.60" height="10" wh:direction="0" .../>
        <!-- mark bar (UB/PFC reference exports; M-1 has text only) -->
  <text wh:class="cadtext" wh:layer="6" x="260.00" y="2480.20" font-family="Arial"
        font-size="40" transform="rotate(90 260.00,2480.20)"
        wh:params="IsLabel=true;LabelType=0;LabelContent=M-1;LabelWidth=1;LabelHeight=40;
                   LabelRotate=90.0;LabelSource=1;">M-1</text>
  <path ... d="M290,5084.2 L-290,5084.2" wh:params="IsTrucate=1;TrucateType=1;Part=M-1;InnerCad=…"/>
 </g>
 <g wh:id="15280294" wh:class="cadgroup" wh:layer="0" wh:isfill="0" wh:machining="1" class="layer0">
  <path ... d="M-190,50 L190,50 L190,-50 … A14,14 …"/>   <!-- outer section -->
  <path ... d="M-172.5,-50 … A14,14 …"/>                  <!-- inner section (PFC/tube only) -->
 </g>
</svg>
```

`cadgroup` is a **sibling of `cadpart`**, not a child. Holes, cut paths, `rect` marks and
`text` are direct children of `cadpart`; the section outline(s) follow in the trailing
`cadgroup`. Getting this nesting wrong leaves an empty `cadpart` / misplaced section and
WiseCAM rejects the part even though the SVG is well-formed.

Key attributes:

| Attribute | Meaning |
|---|---|
| `wh:class="cadpart"` | part geometry group; `wh:refid` = the `<Part idref>` |
| `wh:class="cadgroup"` | **sibling** group holding the section outline(s), not a child of `cadpart` |
| `wh:class="cadpolyline"` | a cut/trim/section/bevel path |
| `wh:class="cadcircle"` | a hole |
| `wh:class="cadrectangle"` | a marking bar |
| `wh:class="cadtext"` | the label/etch text |
| `wh:layer` | `0` cut, `1` lead/applied, `4` corrected mark, `6` mark, `-1` container |
| `wh:machining` | `1` = actually cut/marked |
| `wh:isfill` | fill flag; real start/end trims are `1`, section and holes are `0` |
| `IsTrucate=1;TrucateType=0\|1` | start (0) / end (1) cut contour (note the typo "Trucate") |
| `InnerCad=…` | discretised copy of the curve (`x,y,radius` triples, `N`-separated) |
| `Part=M-1` | mark repeated on the end-cut params |
| `PosMap={…}` | position mapping for a bevelled/mitred end segment or a shaped cut |
| `needSetAdobe=true` | corrected mark/cut adjustment; WiseCAM keeps this through re-export |
| `IsLabel=true;LabelContent=…` | the label text **node**; the actual mark is also encoded by `rect` bars |

### Unrolled station formulas (validated on 17 samples)

**Channel (`U`, e.g. `PFC380*100`)** — centred on 0, order `u, v, o`:

```
seam  = depth + 2·flange                       // 380 + 2×100 = 580
half  = seam / 2
u: x = -half + y            v: x = -half + flange + y       o: x = -half + flange + depth + y
```

Real M‑1 holes: `u y=50 → x=-240`, `v y=115/265 → -75/+75`, `o y=50 → +240`.

**I (`I`, e.g. `UB310*32`)** — centred on 0, order `o, gap, v, gap, u`:

```
gap   = (flange - tw)/2 - r·(2 - π/2)
seam  = 2·flange + depth + 2·gap                // 2×149 + 298 + 2×66.17 = 728.34
o: x = -half + y
v: x = -half + flange + gap + y
u: x = +half - flange + y
```

Real M‑3 holes: `o y=27.25 → -336.92`, `v y=99 → -50`. The `gap` regions are the flange/web
corners and should normally be empty.

**Markings on the hidden face are silently dropped (`I`/`U`).** The NC can carry `KO`/`PU`
marks on `h` as well as `v`, but the I/U layout above has **no `h` region**. WiseCAM imports
only the `v` copy, so the rear-web marks are never machined. This is a WiseCAM limitation, not
a bad NC: M‑2 (`UB530*92`) has mirrored `v`/`h` marking rectangles (e.g. `v x=252.75…262.75`,
`h x=262.75…252.75`) and the exported NCEP contains the `v` mark only. Contrast M‑26
(`SHS89*89*5`, `M`): the tube layout develops **all four** faces, so its `o` **and** `u` marks
both survive. The preflight viewer draws the `h` marks faithfully; filter them to the developed
faces when checking what WiseCAM will actually produce.

**Tube (`M`, e.g. `RHS200*100*9`, `SHS89*89*5`)** — stations `0 … seam`, seam starts at the
**`v` face centre**; developed face = `side - r·(2 - π/2)`:

```
seam = 2·(w + h) - 8r + 2πr                     // rounded-rect perimeter
order from the seam: v, o, h, u
o centre = (developed v)/2,  u centre = P - (developed u)/2
```

For SHS89×89×5: `seam=334.54`, `o/u` centre at `83.63 / 250.90` — matches the real M‑35 circles.

### Holes

```xml
<circle wh:class="cadcircle" wh:layer="0" wh:isfill="0" wh:machining="1"
        cx="-240.00" cy="135.00" r="11.00" wh:direction="1"
        wh:params="InnerCad=…;" wh:technical="T={LeadLine=…};" class="layer0"/>
```

- `r` is the **hole radius** (Ø22 → 11).
- `wh:technical` carries the lead-in/out (WiseCAM's own default).
- `InnerCad` is the discretised circle.

### Reference variation set (2026-10-24)

`~/Downloads/ncep-export-variations/` contains 19 real NCEP variants and one `.ncexa` export
with 20 parts. The set is copied into `test/fixtures/ncep/reference-variations/` and hash-guarded
by `referenceFixtures.test.ts`; use the repo copy for validation. The extra part is `UB canonical corrected marking and hole`; it has no matching
input NCEP and is a combined reference. These files are the current golden set for validating
both the parser and the generator.

Variations per family:

| Family | Variants |
| --- | --- |
| PFC (8/15; bbox 250×90) | `PFC`, `corrected marking`, `no marking`, `canonical`, `90 clockwise`, `90 anti-clockwise` |
| UB (6.1/10.2; bbox 165×304) | `UB`, `corrected hole`, `corrected marking`, `no marking`, `canonical`, `90 clockwise`, `90 anti-clockwise`, plus the combined `.ncexa` part |
| RHS 100×50×5 | `RHS`, `canonical`, `90 clockwise`, `90 anti-clockwise` |
| Beveled PFC (4.2/6.7) | `Beveled PFC`, `Beveled PFC remove bevel` |

#### Canonical orientation

Canonical changes the **section `cadgroup` only** in these files. Holes, marking rectangles and
text keep the same developed coordinates. Do **not** apply canonical as a whole-part transform.

| File / family | Section bbox (mm) | Transform from base | Equivalent file |
| --- | --- | --- | --- |
| `PFC`, `PFC canonical` | x −125…125, y −45…45 | none — already canonical | — |
| `PFC 90 clockwise` | x −45…45, y −125…125 | `(x,y) → (y,−x)` | — |
| `PFC 90 anti-clockwise` | x −45…45, y −125…125 | `(x,y) → (−y,x)` | — |
| `UB` (base) | x −82.5…82.5, y −152…152 | web-vertical (Tekla stance) | — |
| `UB canonical` | x −152…152, y −82.5…82.5 | `(x,y) → (−y,x)` | **identical to `UB 90 anti-clockwise`** |
| `UB 90 clockwise` | x −152…152, y −82.5…82.5 | `(x,y) → (y,−x)` | — |
| `RHS`, `RHS canonical` | x −50…50, y −25…25 | none — already canonical | — |
| `RHS 90 clockwise` | x −25…25, y −50…50 | `(x,y) → (y,−x)` | — |
| `RHS 90 anti-clockwise` | x −25…25, y −50…50 | `(x,y) → (−y,x)` | — |

So PFC and RHS base exports are already in canonical stance; **UB base is not**. For UB the
canonical section is the base rotated 90° CCW (`−y, x`) and is interchangeable with the
`90 anti-clockwise` variant.

#### Marking correction

The mark is encoded twice in these files: as `cadtext` and as one or more `cadrectangle` bars.
`corrected marking` fixes the **bars**, not the text:

| Family | Text | Bars | Correction |
| --- | --- | --- | --- |
| PFC | `5M-2` | 1 bar at `(-5, 3306)`, 110×10 | `wh:layer` 6 → 4; add `wh:params="needSetAdobe=true;"` |
| UB | `5M-5` | 4 bars at y = 40, 1188.5, 1808, 5982 | same layer/param change; positions unchanged |
| RHS | none | none | — |

- Bar positions and the `<text>` node are unchanged by the correction.
- `no marking` removes **both** the bars and the text node.
- The `.ncexa` preserves the corrected `layer=4` + `needSetAdobe=true` bars.
- `Part.Name` is a probe label here (`UB corrected marking`), while the etched mark stays
  `5M-5`. Treat the text/bar content separately from `Part.Name`; keep them consistent in
  production files.

#### UB hole correction

`UB corrected hole` removes whole developed-x columns, not isolated holes:

| Removed column | Holes | Radius | Along positions |
| --- | --- | --- | --- |
| `x = +178.857` | 7 | 6.999 | 250, 1150, 2050, 2950, 3850, 4750, 5650 |
| `x = -178.857` | 4 | 11.0 | 135.5, 235.5, 5754.5, 5854.5 |

Base has **47** holes; corrected has **36**; no holes are added. This is the current golden
correction for this UB part. It is not yet known whether the same columns are dropped by a
general rule or whether this is specific to the part's source geometry — validate a second UB
before generalising.

The `.ncexa` combined part has the canonical UB section, 36 corrected holes, and the corrected
bar layer/params.

#### Beveled end

`Beveled PFC` keeps the normal start and end trims, then **nests the bevel cluster inside the
end-trim `<path>` element**:

- start: normal `TrucateType=0` path;
- middle: 6 holes;
- end: one `TrucateType=1;Part=…` path whose **child elements** are several `<path>` segments
  carrying `PosMap={Src:4,Dst:…}` / `needSetAdobe=true` (layer 0 and 1).

`Beveled PFC remove bevel` removes those nested child paths; the outer `TrucateType=1` trim,
start trim, holes, text and section are unchanged. Both variants survive the `.ncexa` re-export.

A parser must walk the end-trim's child elements; they are **not** siblings in `cadpart`. A
validator still requires the two outer trims. A generator must emit the cluster as nested children
of the end-trim path, not replace the end trim with a polyline.

### Validator / generator contract

A validator that matches these references should check:

1. Root children are `style`, one `cadpart`, one `cadgroup`; `cadgroup` is a sibling, never
   nested inside `cadpart`.
2. `cadpart` has exactly one `TrucateType=0` start trim and one `TrucateType=1` end trim. A
   bevelled end keeps the end trim and nests `PosMap` child paths inside it.
3. `cadgroup` has **one** section path for UB and **two** for PFC/tube; section paths have
   `wh:isfill="0"`, trims have `wh:isfill="1"`.
4. Holes are `cadcircle` direct children of `cadpart`, with `cx`, `cy`, `r`, `wh:direction`,
   `InnerCad` and `wh:technical`.
5. Marks are separate `cadrectangle` bars and `cadtext`; corrected bars are `layer=4` with
   `needSetAdobe=true`, uncorrected bars are `layer=6`; text is `layer=6`.
6. Canonical section section-group transforms match the table above; do not transform holes,
   bars or text with the section.
7. Bevel segments are **child paths of the end trim** and may carry `PosMap`/`needSetAdobe`;
   parse them separately, but keep requiring both outer trims.
8. `Part.Name` can differ from the etched mark in a probe; for production keep `Name`,
   `LabelContent`, the text node and the mark bars consistent.

A generator should use a real NCEP as the container/adobe/Technology template, write only the
part SVG, emit the canonical section group for the family, preserve unrolled hole/mark
coordinates, encode corrected marks as `layer=4` bars with `needSetAdobe=true`, and emit bevels
as the `PosMap` cluster. Do not generate a blank part: the start/end trim paths and section
group are structural.

### Known false negatives / parser gaps

A clean parse is **not** proof that WiseCAM will import the file. Known failures and what the
parser currently says:

| Known-failing package | Old parser | Current parser | Pattern |
| --- | --- | --- | --- |
| 121–124 (real container + our part) | pass | **error**: `section`, warning `nested-group` | our section group was nested inside `cadpart` |
| 33 / 40 (old single-group writer) | pass | **error**: `truncate-count`, `section` | no direct trim paths, no sibling section |
| 226 (our level-6 M-1) | pass | **error**: `section-count`; warning `adobe-userpath` | PFC has only **1** section path, not 2; Adobe also lacks USERPATH |
| 240 (own M-1) | pass | warning `adobe-userpath` (no errors) | PFC section count is correct; Adobe lacks USERPATH |
| 242 (own M-3) | pass | warning `adobe-userpath` (no errors) | UB section count correct; Adobe lacks USERPATH |
| 243 / 244 (own tube/RHS) | pass | pass | M adobes correctly have no USERPATH |
| 245 (own M-34) | pass | warning `adobe-userpath` (no errors) | PFC lacks USERPATH |

The strongest pattern so far is the Adobe:

- real **U/I** adobes have **three** root groups, the middle one `USERPATH=USERPATH` with the
  applied cut paths;
- real **M** (tube/RHS/SHS) adobes have **two** groups and no `USERPATH`;
- all our generated **U/I** adobes have two groups and no `USERPATH`, and those packages fail.

That correlation points at the missing U/I `USERPATH` group as a likely cause of the 240/242/245
failures, but it is not yet proven. The parser reports it as a **warning**, not an error, until a
WiseCAM control confirms it. The `section-count` gap is now a hard error (PFC/M need 2 section
paths, UB needs 1).

Remaining parser gaps:

1. It does not validate Adobe group structure beyond “no cadpart”; the U/I `USERPATH` pattern is
   only a warning.
2. It does not validate `Technology.xml`, `cad.opf`/`ncex.opf` manifest consistency, or the
   presence/semantics of every referenced file.
3. It does not model WiseCAM's acceptance of generated section geometry, applied cuts, or
   technology/lead parameters.
4. A pass therefore means “structurally plausible NCEP”; negative fixtures such as 226 and the
   240-series must remain in the regression set.

---

## 4. What we are still unsure about

1. **`o`/`u` handedness on I-sections.** Mirrored parts swap which flange is `o`:
   - `M-3`, `M-4`, `M-5` → `o` on the negative flange (formula above).
   - `M-30`, `M-39` → `o` on the **positive** flange.
   - `M-9` → `u` is Y-reversed within its flange.
   All have `RotateAngle=0;Invert=0`, so handedness is not in the header. The writer exposes
   `flipFlanges`, but a rule (or a STEP-derived cue) is still missing.
2. **No T / angle / round samples.** `partFromNc` returns `null` for `T`, `L`, `RO`.
3. **Bevelled/mitred end cuts.** The reference `Beveled PFC` shows a bevel as **child paths
   nested inside the end-trim `<path>`**, carrying `PosMap`/`needSetAdobe`. The reference is
   decoded and the parser exposes them as `truncate.bevels`, but the generator still emits only
   straight ends; the NC→cluster mapping is not implemented.
4. **Adobe `USERPATH` group.** Real **U/I** adobes have three root groups; the middle one is
   `wh:params="USERPATH=USERPATH;"` and carries the applied cut paths. Real **M** adobes have
   two groups and no `USERPATH`. Generated U/I adobes omit it and fail; this is the strongest
   current suspect for the 240/242/245 failures, but still needs a controlled WiseCAM test.
5. **`technologyID`.** Real exports use a fresh GUID per part/adobe, so we emit one. It is not
   validated (`not-a-guid` imports, probe 63) and is **not** the blocker: 30b keeps the control's
   ID and still imports. It does not appear in `Technology.xml`.
6. **`InnerCad` / `InnerT` / section arcs.** Real SVGs carry a discretised `InnerCad` and draw
   the section with arcs; ours omits `InnerCad` and uses a sampled polyline. Unknown if required.
7. **ZIP flags/compression.** Real CAD entries use flags `6`; `mimetype`/`container.xml` are
   stored. `zipQt` reproduces that, but fflate's ordinary `zipSync` metadata (flags 0) also
   imports (31/32), so the ZIP dialect is not the blocker.
8. **Quantity > 1.** Real samples are `TotalCount=1`; probe 400–531 shows `Part.TotalCount=2`
   survives re-export. Whether WiseCAM actually nests/cuts two is still unverified.
9. **Hidden-side cuts/marks.** NCEP develops only the front surface (`o`/`v`/`u` for I/U; all
   four for M). `h` marks are **silently dropped** for I/U (see the I-section note above); how a
   cut that exists only on the back/inner face should be encoded is still unknown.
10. **`Length`/`RCornerMaxRadius`.** Matched to real samples (`3000`, `5`/section radius).
    Adobe `Length` alone does **not** drive geometry (probe 305); the end cut/`InnerCad` must be
    edited. `RCornerMaxRadius` semantics are still unconfirmed.
11. **Mark bar semantics.** The reference correction changes `cadrectangle` from layer 6 to
    layer 4 + `needSetAdobe=true`. What layer 4 tells WiseCAM, and whether the text node is
    required alongside the bars, is still untested.
12. **UB hole-correction rule.** One UB reference removes two whole x-columns (47→36 holes). A
    second UB is needed to know whether this is a general duplicate-column rule or part-specific.
13. **Canonical is section-only here.** The reference canonical files rotate only `cadgroup`;
    holes/marks/text remain fixed. Verify this is WiseCAM's intended machine-stance import
    behaviour on a second family before relying on it for production nesting.

---

## 5. Our generated package vs the real one

| Item | Real `M-1.ncep` | Ours (latest) | Status |
|---|---|---|---|
| Files | 9, no `CNC/` | 9, no `CNC/` | ✅ |
| `mimetype` | stored, first | stored, first | ✅ |
| `Name` | `M-1` | `M-1` (passed explicitly) | ✅ |
| `technologyID` | valid GUID | **fresh random GUID** | ✅ |
| Adobe `Length` | `3000` | `3000` | ✅ |
| `RCornerMaxRadius` | `5` (I/U), `r` (tube) | same | ✅ |
| Part SVG | arcs + `InnerCad` + `USERPATH` adobe | sibling `cadgroup`; polylines, no `InnerCad` | ⚠️ |
| ZIP flags | CAD entries flag 6; container stored | matches real (`zipQt`) | ✅ |
| Canonical section | PFC/RHS already canonical; UB rotated `(−y,x)` | section builder emits canonical stance | ✅/⚠️ verify UB |
| Marks | `cadtext` + `cadrectangle` bars; corrected bars layer 4 + `needSetAdobe` | text only; no `cadrectangle` bars | ⚠️ |
| Adobe groups | U/I: three groups incl. `USERPATH`; M: two groups | U/I: two groups, no `USERPATH` | ⚠️ suspected U/I failure |
| End cuts | shaped/mitred | straight | ⚠️ (bevel cluster not generated) |

---

## 6. Validation matrix (licensed machine)

> **Historical (2026-10-21).** Do not rerun this broad matrix. The current golden set is
> `~/Downloads/ncep-export-variations/` and the current strategy is small, control-first probes
> (see `docs/ncep-probe-log.md`). This section is kept for the ZIP/GUID/part finding, not as a
> test plan.

Generated by `probes.test.ts` into `~/Downloads/ncex-probes/`.

**Known result:** the old `33-real-M1-ourpart.ncep` (real package + our part SVG) **crashed
WiseCAM**. The fix in `ncex.ts` makes the part SVG follow the real grammar exactly:

- cut/end lines, holes and the mark are **direct children** of `cadpart` (the section outline
  lives in a trailing `cadgroup`, as in every real export);
- **every** hole and truncate line carries `wh:params` with an `InnerCad` vertex dump;
- every element carries `wh:technical` (`T={};` or the hole lead template);
- the mark text carries its `transform="rotate(90 x,y)"` and the `wh:font-*` attributes.

Run the set in this order — the first failure names the required feature:

| File | Isolates |
|---|---|
| `30-real-M1.ncep` | control (byte-for-byte real) |
| `30b-real-M1-rezipped.ncep` | ZIP writer/flags/order |
| `31-real-M1-badguid.ncep` | invalid `technologyID` format |
| `32-real-M1-randomguid.ncep` | valid-but-unknown GUID value |
| `33b-real-M1-ourpart-fixed.ncep` | real package + our part SVG (fixed grammar) |
| `34-real-M1-our-adobe.ncep` | real package + our adobe SVG |
| `35-real-M1-our-part-and-adobe.ncep` | both our SVGs in the real package |
| `36-real-docs-our-cad.ncep` | our whole CAD payload, WiseCAM's package docs |
| `20-ncep-M-1.ncep` | our full generated package |
| `37-real-M1-ourpart-no-innercad.ncep` | fixed part minus `InnerCad` |
| `38-real-M1-ourpart-no-technical.ncep` | fixed part minus `wh:technical` |
| `39-real-M1-ourpart-no-text-transform.ncep` | fixed part minus the mark `transform` |
| `40-real-M1-ourpart-old-structure.ncep` | fixed part in the old single-`cadgroup` layout |
| `41-real-M1-adobe-no-userpath.ncep` | real adobe minus the `USERPATH` group |

Read it as: `30/30b` (container) → `31`/`32` (GUID) → `33b` (part) → `34`/`35` (adobe) →
`36` (docs) → `20` (full). If `33b` still fails, `37`–`40` say which part-SVG feature is
required.

---

## 7. NC → NCEP converter prototype

`tools/nc-to-ncep.mjs` converts DSTV `.nc1`/`.nc` files directly with our writer:

```sh
pnpm nc-to-ncep -i part.nc1 -o out/ --mark M-1 --suffix=-A
pnpm nc-to-ncep -i nc-folder/ -o out/ --suffix=-A
```

Use `--suffix` (or a new `--mark`) for every repeated test — WiseCAM caches by `Name`.
The command writes `conversion-report.json` with profile, length, section-path count, holes,
section vertices and package size. Supported today: **I** (UB/WB/UC/WC), **U** (PFC/TFC) and
**M** (RHS/SHS/CHS). **T**, angle and round profiles return unsupported until a real NCEP
sample exists.

The programmatic gate is `src/lib/wisecam/ncToNcep.test.ts`: it converts M-1/M-3/M-34/M-35/M-42,
checks the 9-file package, 1-vs-2 section paths, open PFC cavity vs closed hollow void, hole
count, mark consistency, fresh `technologyID`, determinism and unsupported-`T` rejection.
The remaining gate is still physical: import the generated files in WiseCAM and confirm the cut
geometry, then add any newly discovered behaviours as tests. Known writer gaps from the reference
set: no `cadrectangle` mark bars, no `PosMap` bevel cluster, and UB canonical stance still needs
an explicit verification against the reference.

## 8. Sources / cross-refs

- Real samples: `~/Downloads/NCEP samples 2 Hidden Grove/*.ncep`; all 17 are committed under
  `test/fixtures/ncep/` with `manifest.json` + a hard-failing guard test. Five also have matching
  `.nc1`. Known-good generated imports are in `test/fixtures/ncep/working/` (`30`, `30b`, `31`,
  `32`, `77`). See that folder's `README.md` — do not delete or rewrite them.
- WiseCAM Tube manual R3 — §5.1 (import list), §12.1 *Export Part (.ncep)*.
- Reference variations: `test/fixtures/ncep/reference-variations/` (19 NCEPs + one `.ncexa`;
  copied from `~/Downloads/ncep-export-variations/`), documented above. These are the
  canonical/marking/hole/bevel golden set used by the validator and probe generator.
- `docs/ncexa-format.md` — shared NCEX OPC/ZIP container, SVG grammar, `.zua` DSL.
- `docs/wisecam-formats.md` — supported formats and capability matrix.
- Code: `src/lib/wisecam/layout.ts` (stations), `ncex.ts` (package/SVG writer),
  `fromNc.ts` (NC → NCEP).
