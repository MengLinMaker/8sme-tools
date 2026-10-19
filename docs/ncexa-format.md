# WiseCAM `.ncexa` (NCEX) — format & reverse-engineering notes

Research notes for the 8SME tools. Goal: understand the **native WiseCAM Tube exchange
format** (`*.ncex` / `*.ncexa` / `*.ncexb`) well enough to **parse** it and — later —
**author** it, because unlike STEP it carries **quantity + marking (etch) + technique**
natively. Everything below was reverse-engineered from 10 real `.ncexa` exports in
`~/Downloads` (the `26 Luenard Balwyn North` job, `Exported 2 Hidden Grove`,
`Base 2 Hidden Grove`).

Status: **read/parse is tractable; authoring is plausible but unverified.** Nothing here has
been round-tripped through WiseCAM yet — an import test (see `docs/wisecam-debugging.md` §7)
is required before trusting any generated file.

> **TL;DR** — a `.ncexa` is an **OPC/ZIP container** (EPUB-like): `mimetype` +
> `META-INF/container.xml` + three `.opf` package files, then **`CAD/`** (an XML master +
> SVG geometry) and **`CNC/`** (a tiny custom *.zua* text DSL holding the toolpath). A
> **CAD-only** export needs no toolpath and is the realistic thing for us to generate;
> WiseCAM re-nests/re-generates the paths on import.

---

## 1. Container

`file(1)` reports `application/ncex+zip`. It is a **ZIP** whose **first, stored
(uncompressed)** entry is `mimetype` containing exactly (20 bytes, no newline):

```
application/ncex+zip
```

Then an OPC-style `META-INF/container.xml` naming the package roots:

```xml
<?xml version="1.0"?>
<container version="1.0" xmlns="http://www.weihong.com.cn/phoenix/ncex">
  <rootfiles>
    <rootfile full-path="CAD/cad.opf" media-type="application/ncex-package+xml"/>
    <rootfile full-path="CNC/cnc.opf" media-type="application/ncex-package+xml"/>
    <rootfile full-path="ncex.opf"  media-type="application/ncex-package+xml"/>
  </rootfiles>
</container>
```

Two namespaces are used throughout:

| Prefix | URI | Used by |
|---|---|---|
| `phoenix/ncex` | `http://www.weihong.com.cn/phoenix/ncex` | OPF/container metadata |
| `cadcam` | `http://www.weihong.com.cn/cadcam` | `CadRoot.xml`, SVGs (`wh:`), zua |

`ncex.opf` is a manifest listing every payload file; `cad.opf` / `cnc.opf` are per-root
documents carrying a `metadata` block:

```xml
<metadata xmlns="http://www.weihong.com.cn/phoenix/ncex" version="1.0">
  <identifier>2.0.0.1</identifier>      <!-- ncex format version -->
  <title>laser_tube</title>
  <cnc_laserzua>6.953.9.3</cnc_laserzua><!-- WiseCAM laser-kernel version -->
  <cnc_layerparam>1.0.0.0</cnc_layerparam>
  <machinetype>bevel</machinetype>       <!-- bevel | straight -->
  <modifier>standard</modifier>
  <remarker>standard</remarker>
  <source>professional</source>
</metadata>
```

Observed values: `identifier` `2.0.0.0`/`2.0.0.1`; `cnc_laserzua` `6.953.9.3` (bevel) vs
`6.956.20.0` (straight); `machinetype` **`bevel`** for the per-beam PFC files and
**`straight`** for the whole-job / CAD-only exports.

## 2. File map

| Path | Role |
|---|---|
| `mimetype`, `META-INF/container.xml` | container (see §1) |
| `ncex.opf`, `CAD/cad.opf`, `CNC/cnc.opf` | package metadata + manifest |
| `CAD/CadRoot.xml` | **master document**: Adobes / Parts / BaseZone / Results (see §3) |
| `CAD/Technology.xml`, `CAD/TechnologySets.xml` | laser layer/technology params (see §6) |
| `CAD/adobe<id>.svg` | **adobe** = a stock-layout template drawing (cross-section + length) |
| `CAD/part<id>.svg` | **part** geometry (holes/curves/marks) |
| `CAD/part<id>-a.svg` | same part **plus applied cut paths** (`USERPATH` group; see §4) |
| `CAD/<resultId>_0.svg` | **result** = the finished nest, with placed `<cadpart>` instances |
| `CAD/CustomizeData.xml` | per-zone custom-parameter stubs (`<customize id="0..7" params=""/>`) |
| `CNC/Base.xml`, `CNC/Plate0.xml` | joiner docs → `<item href="…zua">` + `<TubeInfo>` |
| `CNC/GlobalParam.zua`, `Plate0-GlobalParam.zua` | machine/laser params (`GP = {…}`) |
| `CNC/CncParam.zua` | machine mode (`machinetype=…`, axes, limits) |
| `CNC/Plate0-1.zua` | **the toolpath** (`Path{…}` + `Laser.*` opcodes) |
| `CNC/Plate0-GlobalZua.zua`, `Plate0-Truncate.zua` | ranges + truncate (end-cut) paths |
| `CNC/CustomParam.zua`, `Plate0-CustomParam.zua` | per-layer custom params (usually empty) |

## 3. Two export flavours (important)

| Flavour | Examples | Contains |
|---|---|---|
| **CAD exchange** (part library) | `Exported 2 Hidden Grove`, `Base 2 Hidden Grove` | Adobes + Parts + SVGs; `CNC/Base.xml` only. **No `Results`, no `Plate0` toolpath.** |
| **Machine / project export** | per-beam `Mxx + Myy.ncexa`, whole-job `26 Luenard Balwyn North.ncexa` | adds `BaseZone` + `Results` + `CNC/Plate0*.zua` |

The **CAD-only** package is the authorable target: WiseCAM can ingest `.ncex` as a *tube
part* (`docs/wisecam-debugging.md` §9) and will re-compute the toolpath itself.

### `CAD/CadRoot.xml`

```xml
<cadroot version="1.0" xmlns="http://www.weihong.com.cn/cadcam">
 <Adobes>
  <Adobe idref="1723706" svgname="adobe1723706.svg"
    params="Type=8199;Name=M_33;Thickness=8.0;LegThickness=15.0;
            OuterLeadLength=2;OuterLeadOutLength=2;OuterLeadDir=0;
            Length=10500;RCornerMaxRadius=999;Area=0;TotalCount=1;NestedCount=1;"
    technologyID="F0710FB2-…"/>
 </Adobes>
 <Parts>
  <Part idref="1719810" svgname="part1719810.svg"
    params="Type=8199;Name=M_33;TotalCount=1;NestedCount=1;Thickness=8.0;…;RotateAngle=0;Invert=0;"/>
 </Parts>
 <BaseZone idref="1723704" count="0" adobeid="1723706"/>
 <Results>
  <Result idref="1723411" count="2" adobeid="1723706"
    params="Utilization=0.9225;Count=1;ResultName=…;HeadLength=0;TailLength=100;
            PartInfo=(1719810,1)(1719850,1);"/>
 </Results>
</cadroot>
```

- **Adobe** = one stock layout template (a section + a length). An adobe SVG **never**
  contains `cadpart`.
- **Part** = one physical piece.
- **BaseZone** = the base/reference zone (references the "base" adobe `idref=94`).
- **Result** = a finished nest; `PartInfo=(partId,count)…` is the **quantity** payload
  (what STEP loses), and `ResultName` is human-readable (`…300x90 D8 T16 L10500 R0`).
  The `_0.svg` alongside it holds the placed instances.
- `params` throughout is a flat `key=value;` string (not nested XML).

> **Gotcha**: `CadRoot.xml` in some exports contains **mis-encoded bytes** in `ResultName`
> (Chinese text). Strict XML parsers (`ElementTree`, DOMParser) throw. Parse it tolerantly
> (regex / streaming / `errors="replace"`).

## 4. SVG geometry grammar

All drawings are single SVG files with `xmlns:wh="http://www.weihong.com.cn/cadcam"`. Every
element carries `wh:` attributes:

| Attr | Meaning |
|---|---|
| `wh:id` | element id (unique per file; matches zua `CadId`s sometimes) |
| `wh:layer` | layer index: `0` outline cut, `1` lead/applied, `6` **marking/etch**, `-1` container |
| `wh:machining` | `1` = actually cut/marked, `0` = construction/reference geometry |
| `wh:isfill` | fill flag (`1` on closed contours / truncate lines) |
| `wh:direction` | arc/circle direction |
| `wh:params` | `k=v;…` (see below) |
| `wh:technical` | `T={…LeadLine…}` — lead-in/out params |
| `wh:refid` | (on `cadpart`) the `CadRoot` Part idref |
| `wh:matrixinfo3d` | (on placed `cadpart`) placement transform |

Element classes: `cadpart` (root of a part / placed instance), `cadgroup`, `cadrelationgroup`
(`params="Truncation=Both;"`), `cadpolyline` (SVG `d` path: `M`/`L`/`A`/`Z`), `cadcircle`
(`cx,cy,r`), `cadline` (`x1,y1,x2,y2`), `cadrectangle` (`x,y,width,height`), `cadtext`
(`x,y`, `font-family`, transform), plus `cadarc`/`cadellipse` (seen in the wild). Transforms
are SVG `rotate(deg cx,cy)`.

Notable `wh:params` keys:

- `IsTrucate=1;TrucateType=0|1` — an end-truncation line (note the typo "Trucate").
- `InnerCad=…` — the discretised copy of the same curve (polyline vertex dump).
- `IsLabel=true;LabelType=0;LabelContent=M_33;LabelWidth=1;LabelHeight=40;LabelRotate=90;LabelSource=1`
  — a **part-mark** text element (also `IsCadLabel=true;LabelSource=1` on layer-6 lines).
- `USERPATH=USERPATH` — user-applied cut-path group (only in `*-a.svg`).
- `ANGLE_DISTINGUISH_LW=1;ANGLE_DISTINGUISH_MODE=0` — corner-angle handling.

**The part mark is real geometry**: layer-6 `cadtext` and layer-6 `cadline`/`cadrectangle`
(e.g. `LabelContent=M_33`). This is the native equivalent of the DSTV `SI` block and matches
the AGENTS.md rule "etch the part mark".

### `partNNN.svg` vs `partNNN-a.svg`

`partNNN-a.svg` is byte-identical to `partNNN.svg` **plus** a trailing
`<g wh:params="USERPATH=USERPATH" class="layer-1">` group carrying the **separating cut
paths** (layer-1 lead-in polylines + layer-0 connectors). So `-a` = "with applied cut
paths" (the contour the laser actually follows to part it from stock).

### The result SVG (`<resultId>_0.svg`)

This is the nest drawing: a `cadrelationgroup` (`Truncation=Both;`) wrapping
`<g wh:class="cadpart" wh:refid="1719810" wh:matrixinfo3d="1,0,0,0 0,1,0,0 0,0,1,0">`
instances holding the placed geometry, plus one `cadtext` per mark.

## 5. CNC layer — the `.zua` DSL

`CNC/*.zua` are **not XML**; they are a small custom text DSL (Huawei-style config):

```
GP = {
[0] = { Arris = { Speed = 9, Power = 35, … },
        Name = [[大图形]],            // [[…]] = localisable string
        IsUsed = true,
        Cut = { Speed = 6000, Power = 100, … }, },
};
```

Rules: `key = value,` · `key = [[string]],` · nested `key = { … }` · indexed `[0] = { … }` ·
`Path{ … };` blocks. `Plate0.xml` ties it together:

```xml
<global>
  <item href="CNC/Plate0-GlobalParam.zua"/>
  <item href="CNC/Plate0-GlobalZua.zua"/>
</global>
<cnc>
  <item href="CNC/Plate0-1.zua" from="0" count="36"/>
</cnc>
<additionalInfo>
  <TubeInfo Param="Type=5;Length=10500.000;ChannelWidth=300.000;ChannelHeight=90.000;
     ChannelWidthThickness=8.000;ChannelHeightThickness=16.000;ChannelOuterLead=2;Radius=0;Area=5108;"/>
  <bound>-152,152,0,6055.01</bound>
  <validLayers>0,1,6</validLayers>
  <HasBevel>0</HasBevel><IsCutPoint>0</IsCutPoint><HasCounterbore>0</HasCounterbore>
</additionalInfo>
```

`CNC/Plate0-1.zua` is the toolpath. Machine coordinates are `X,Y,Z,B` (Y = along the tube,
**B = tube rotation**):

```
Path{
Index=4; LayerIndex=1; PathType=0; CadId=16042469;
StartPosition={X=1.35, Y=145.95, Z=150.0, B=89.9999999999};
Laser.ArcCornerBegin;{Radius=10.9996, Index=1};
Parser.PlaneSelect;{[0]=0,[1]=1,[2]=2};
Laser.CcwToEx;{X=-9.65,Y=134.95,Z=150.0,B=89.99,CX=1.35,CY=134.95};
Laser.ArcCornerEnd;{Radius=10.9996, Index=1};
Laser.LineTo;{X=…,Y=…,Z=…,B=…};
Laser.OutLeadProcess;{LayerIndex=0};
Laser.OutLeadProcessOut;{LayerIndex=0};
};
```

| Opcode | Meaning |
|---|---|
| `Laser.LineTo` | straight move |
| `Laser.TranceOn` | mark/rotate laser on (note the typo "Trance"); opens a `Parser.LineTo` run |
| `Laser.SharpCorner{Angle,Index}` | corner insert |
| `Laser.ArcCornerBegin{Radius,Index}` / `Laser.CcwToEx{X,Y,CX,CY}` / `Laser.ArcCornerEnd` | arc insert |
| `Laser.OutLeadProcess` / `OutLeadProcessOut` | lead-in / lead-out |
| `Parser.PlaneSelect{[0]=0,[1]=1,[2]=2}` | cutting-plane select |

`PathType`: **`0`** = contour, **`1`** = rare (counterbore-class), **`4`** = truncate-forward,
**`5`** = truncate-reverse (see `Plate0-Truncate.zua` / `Base-Truncate.zua`, which also carry
richer `PathInfo`/`CadInfo` with `FaceAngle`, `CurrentSegment`, `OutLeadLine`). `CncParam.zua`
sets the machine mode and axis limits:

```
GlobalParam={Cad={OpfExtendMetaData=[[machinetype=straight;]],nMajorAxis=1,nMinorAxis=0,
  MajorRotateVec={0,1,0},MinorRotateVec={1,0,0},MaxRotateLimit={90,360,0},…},…}
```

## 6. Layer / technology model

`CAD/Technology.xml` defines 8 layers (each with a full Punch/Cut/Acris parameter set);
`TechnologySets.xml` is the same data wrapped for the set editor. Layer names are Chinese:

| Layer | Name | Role (inferred) |
|---|---|---|
| 0 | 大图形 ("large shape") | main outline cut |
| 1 | 中图形 ("medium shape") | medium contour / leads |
| 2 | 小图形 ("small shape") | small contour |
| 3 | L1 | user layer 1 |
| 4 | L2 | user layer 2 |
| 5 | L3 | user layer 3 |
| 6 | 打标 ("marking") | **etch / part mark** |
| 7 | CUTFILM (type `[[CUTFILM]]`) | film cutting |

`<validLayers>` in the plate docs lists the layers actually used (usually `0,1,6`).

## 7. Encoding gotchas

- Read `.zua` as **latin-1** (or GBK) — they mix bytes and `[[中文]]` strings.
- `CadRoot.xml` / `GlobalParam.zua` embed mis-encoded Chinese → parse tolerantly.
- `mimetype` must be the **first** ZIP entry and **stored**, or OPC readers reject the file.

## 8. How we'd parse it

1. Unzip; validate `mimetype`; read `container.xml` + `ncex.opf` manifest.
2. Parse `CAD/CadRoot.xml` tolerantly → `{adobes, parts, baseZone, results}`, splitting each
   `params` string on `;`→`=`.
3. Parse each SVG into typed entities from the `wh:` attrs. **Filter `wh:machining=1`** and
   keep layer 6 separately → per-part true geometry **plus the mark**. This is directly
   comparable to our STEP/NC output and to the DSTV `AK`/`IK`/`BO`/`SI` blocks.
4. (Optional) Parse the result `_0.svg` via `cadpart wh:refid` + `matrixinfo3d` to recover
   the nest layout.
5. (Optional) Parse `CNC/Plate0-1.zua` + `Plate0-Truncate.zua` for WiseCAM's **own**
   reference toolpath — useful to sanity-check our reconstructed cut paths (`B` = rotation).

## 9. How we'd generate it (unverified)

Author a **CAD-exchange** `.ncexa`:

1. `mimetype` (stored, first) + `META-INF/container.xml`.
2. `ncex.opf` manifest; `CAD/cad.opf` (copy metadata shape; `machinetype=straight`).
3. `CAD/CadRoot.xml`: one `<Adobe>` for the stock + one `<Part>` per piece + `<BaseZone>`.
   `params` = `Type=…;Name=…;Thickness=…;Length=…;TotalCount=…;`, `technologyID` = arbitrary GUID.
4. One `CAD/part<id>.svg` per piece: a `cadpart` group with `cadpolyline`/`cadcircle`/`cadtext`
   carrying correct `wh:layer`/`wh:machining`, and a `-a` variant with the `USERPATH` cut group.
5. A minimal `CNC/Base.xml` (+ empty `GlobalParam.zua`) so the CNC root resolves.

**Open risks** (must be resolved by a WiseCAM import test):
- The **profile enum** `Type=8195 | 8199 | 8200` and the `TubeInfo Type=1 | 5` mapping are
  unconfirmed.
- `technologyID` GUIDs, `cnc_laserzua` version, and whether import validates them.
- Whether the CAD root alone is enough, or a plate/`Base.xml` must match the adobe exactly.

## Implications for these tools

- **Parse route**: an `.ncexa` parser gives us a *second* ground-truth geometry source
  (incl. holes/curves **and the mark**) to cross-check STEP/NC reconstruction — the same role
  `docs/nc1-dstv-format.md` proposes for `.nc1`.
- **Generate route**: a native `.ncexa` is the only candidate interchange that carries
  **quantity + mark + technique**; STEP does not. Worth pursuing once a Windows import test
  is available.
- **Marking**: layer 6 = 打标 is the native etch channel; our generated STEP currently
  engraves the mark as thin geometry — a `.ncexa` writer would instead emit layer-6 `cadtext`.
- **Quantity**: lives in `Result.PartInfo` / `Part.TotalCount`, mirroring the DSTV `ST`
  quantity and the `.xlsx` part list.

## Sources / cross-refs

- `docs/wisecam-debugging.md` §9 — supported import formats, and "reverse a WiseCAM-exported
  `*.ncex`/`*.n3dprt` sample" (this doc answers that TODO).
- `docs/nc1-dstv-format.md` — DSTV `AK`/`IK`/`BO`/`SI` blocks (the analogous marking/quantity).
- Samples reverse-engineered: `~/Downloads/26 Luenard Balwyn North/**/*.ncexa`,
  `Exported 2 Hidden Grove.ncexa`, `Base 2 Hidden Grove.ncexa`.
- Weihong — WiseCAM Tube (producer): <https://www.weihong.com.cn/en/products/detail/121>
