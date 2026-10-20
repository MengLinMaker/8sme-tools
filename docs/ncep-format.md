# WiseCAM `.ncep` — format notes & open questions

Reverse-engineering notes for the **NCEP part package** (`*.ncep`), the CAD-only container
WiseCAM's *Add from File* imports. NCEP is **proprietary and undocumented** — there is no public
specification (web searches for "NCEP" return NOAA weather). Everything below comes from 17 real
exports in `~/Downloads/NCEP samples 2 Hidden Grove` (copied to `test/fixtures/ncep/`) plus the
WiseCAM Tube manual §5.1 / §12.1.

Read with `docs/ncexa-format.md` (the shared NCEX container) and `docs/wisecam-formats.md`.

Status: **container + unrolled geometry for PFC/UB/tube are decoded; T/angle/round, bevelled
ends and some metadata are still open.** A live Add-from-File test on the licensed machine is the
only proof of correctness.

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
CAD/part1843526.svg          unrolled part (2 end cuts + section + holes + mark)
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
| `Name` | the **mark** (`M-1`) | not the profile |
| `Length` (Adobe) | `3000` in every sample | base-stock template, not the part length |
| `RCornerMaxRadius` | `5` for I/U; the section radius for tubes | |
| `technologyID` | a **valid GUID**, unique per part, **not** present in `Technology.xml` | format matters; meaning unknown |
| `BaseZone idref` | same value as `CustomizeData`'s `ZoneBlock idref` | |
| `adobeid` | the Adobe `idref` | |
| `TotalCount` | quantity | all samples = 1 |
| `RotateStyle/RotateAngle/Invert` | stance knobs | all samples = 0/0/0 |

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

### Structure (real `part1843526.svg`)

```xml
<svg version="1.1" xmlns:wh="http://www.weihong.com.cn/cadcam" ...>
 <style>… .layer0 … .layer6 …</style>
 <g wh:id="15280187" wh:class="cadpart" wh:layer="-1" wh:isfill="0" wh:machining="1"
    wh:refid="1843526" wh:matrixinfo3d="1,0,0,0 0,1,0,0 0,0,1,0" class="layer-1">
  <path ... d="M-290,0 L290,0" wh:params="IsTrucate=1;TrucateType=0;InnerCad=…"/>
  <path ... d="M290,5084.2 L-290,5084.2" wh:params="IsTrucate=1;TrucateType=1;Part=M-1;InnerCad=…"/>
  <path ... d="M-190,50 L190,50 L190,-50 … A14,14 0 0,1 158.5,40 …"/>   <!-- section -->
  <path ... d="M-172.5,-50 … A14,14 …"/>                              <!-- inner section -->
  <circle ... cx="-240.00" cy="135.00" r="11.00"/>
  …
  <text wh:class="cadtext" wh:layer="6" x="260.00" y="2480.20" font-family="Arial"
        font-size="40" transform="rotate(90 260.00,2480.20)"
        wh:params="IsLabel=true;LabelType=0;LabelContent=M-1;LabelWidth=1;LabelHeight=40;
                   LabelRotate=90.0;LabelSource=1;">M-1</text>
 </g>
</svg>
```

Key attributes:

| Attribute | Meaning |
|---|---|
| `wh:class="cadpart"` | root group; `wh:refid` = the `<Part idref>` |
| `wh:class="cadgroup"` | inner group holding geometry |
| `wh:layer` | `0` cut, `1` lead/applied, `6` mark, `-1` container |
| `wh:machining` | `1` = actually cut/marked |
| `wh:isfill` | fill flag |
| `IsTrucate=1;TrucateType=0\|1` | start (0) / end (1) cut contour (note the typo "Trucate") |
| `InnerCad=…` | discretised copy of the curve (`x,y,radius` triples, `N`-separated) |
| `Part=M-1` | mark repeated on the end-cut params |
| `IsLabel=true;LabelContent=…` | the etch/mark text |

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

---

## 4. What we are still unsure about

1. **`o`/`u` handedness on I-sections.** Mirrored parts swap which flange is `o`:
   - `M-3`, `M-4`, `M-5` → `o` on the negative flange (formula above).
   - `M-30`, `M-39` → `o` on the **positive** flange.
   - `M-9` → `u` is Y-reversed within its flange.
   All have `RotateAngle=0;Invert=0`, so handedness is not in the header. The writer exposes
   `flipFlanges`, but a rule (or a STEP-derived cue) is still missing.
2. **No T / angle / round samples.** `partFromNc` returns `null` for `T`, `L`, `RO`.
3. **Bevelled/mitred end cuts.** The end contour (`TrucateType=1`) can be a shaped polyline with
   bevel/angle columns; our writer emits a straight line. Not decoded.
4. **Adobe `USERPATH` group.** The real adobe has three `cadgroup`s, one
   `wh:params="USERPATH=USERPATH;"` carrying the applied cut paths. Ours emits a single group.
   Whether import requires it is untested.
5. **`technologyID`.** A valid GUID is required (we previously emitted invalid groups). Whether
   the *value* must reference something (registry/technology set) is unknown — it does not appear
   in `Technology.xml`.
6. **`InnerCad` / `InnerT` / section arcs.** Real SVGs carry a discretised `InnerCad` and draw
   the section with arcs; ours omits `InnerCad` and uses a sampled polyline. Unknown if required.
7. **ZIP flags/compression.** Real CAD entries use flags `6`; `mimetype`/`container.xml` are
   stored. Our writer stores only `mimetype`. Likely harmless, unproven.
8. **Quantity > 1.** Every sample is `TotalCount=1`; the multi-quantity behaviour is unverified.
9. **Hidden-side cuts.** NCEP develops only the front surface; how a cut that exists only on the
   back/inner face should be encoded is unknown.
10. **`Length`/`RCornerMaxRadius`.** Matched to real samples (`3000`, `5`/section radius), but the
    semantics are unconfirmed.

---

## 5. Our generated package vs the real one

| Item | Real `M-1.ncep` | Ours (latest) | Status |
|---|---|---|---|
| Files | 9, no `CNC/` | 9, no `CNC/` | ✅ |
| `mimetype` | stored, first | stored, first | ✅ |
| `Name` | `M-1` | `M-1` (passed explicitly) | ✅ |
| `technologyID` | valid GUID | valid GUID | ✅ |
| Adobe `Length` | `3000` | `3000` | ✅ |
| `RCornerMaxRadius` | `5` (I/U), `r` (tube) | same | ✅ |
| Part SVG | arcs + `InnerCad` + `USERPATH` adobe | polylines, no `InnerCad`, single adobe group | ⚠️ |
| ZIP flags | CAD entries flag 6; container stored | flags 0 | ⚠️ |
| End cuts | shaped/mitred | straight | ⚠️ (no bevel yet) |

---

## 6. Validation matrix (licensed machine)

Generated into `~/Downloads/ncex-probes/`:

| File | Isolates |
|---|---|
| `30-real-M1.ncep` | control (byte-for-byte real) |
| `30b-real-M1-rezipped.ncep` | ZIP writer/flags/order |
| `31-real-M1-badguid.ncep` | invalid `technologyID` format |
| `32-real-M1-randomguid.ncep` | valid-but-unknown GUID value |
| `33-real-M1-ourpart.ncep` | real package + our part SVG |
| `20-ncep-M-1.ncep` | our full package |

Read it as: `30 OK` → `30b` (container) → `31`/`32` (GUID) → `33` (geometry) → `20` (metadata).

---

## 7. Sources / cross-refs

- Real samples: `~/Downloads/NCEP samples 2 Hidden Grove/*.ncep`;
  fixtures `test/fixtures/ncep/` (`M-1`, `M-3`, `M-34`, `M-35`, `M-42` + matching `.nc1`).
- WiseCAM Tube manual R3 — §5.1 (import list), §12.1 *Export Part (.ncep)*.
- `docs/ncexa-format.md` — shared NCEX OPC/ZIP container, SVG grammar, `.zua` DSL.
- `docs/wisecam-formats.md` — supported formats and capability matrix.
- Code: `src/lib/wisecam/layout.ts` (stations), `ncex.ts` (package/SVG writer),
  `fromNc.ts` (NC → NCEP).
