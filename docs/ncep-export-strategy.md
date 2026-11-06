# NCEP export strategy and ultimate goals

This is the strategic companion to `docs/ncep-open-questions.md` (specific theories) and
`docs/ncep-probe-log.md` (probe results). Keep it aligned with the actual probes.

## Ultimate goal

Emit a **production-ready NCEP from our NC/STEP pipeline** that WiseCAM imports and cuts without
manual repair, preserving everything NCEP can carry natively. NCEP is the richest of our three
formats, so it is the preferred export target.

## Export priorities

1. **Feature-full NCEP.** Preserve holes, enclosed cuts, inner cuts, slots, notches, counterbores,
   bevels, marks and quantity. NCEP carries more than NC and much more than STEP.
2. **Canonical orientation.** Emit the canonical machine stance so the part drops into
   manufacturing without a manual section rotation.
3. **Remove unmanufacturable UB holes.** Apply the grey-strip column rule to the UB hole set.
4. **Preserve bevels.** Keep the nested `PosMap`/`needSetAdobe` end-trim cluster, and generate it
   from the NC bevel columns.
5. **Preserve welding-location etchings.** `Part.Name` is auto marking and is overwritten by WiseCAM — do not generate it. The target is the **etchings**: `SI` text plus `PU`/`KO` corrected **layer-4 open lines** with `needSetAdobe=true` and `T={};`, matching the real corrected-etch exports. Layer-4 rectangles/lead-line technicals became cuts in the probes. Part-name mark size is not a target.
6. **Quantity.** Preserve the NC/job quantity in `Part.TotalCount` and verify it survives import
   and export.
7. **Part marks vs etchings.** The part-name mark is overwritten; weld/scribe etchings are the
   production-critical content. Do not chase the M-42 part-name mark size.
7. **Inner features.** Inner cuts, slots, notches and counterbores must round-trip, not just holes.

## Explicit non-goals / lower priorities

- **Part-name mark size/placement is not a target.** WiseCAM overwrites `Part.Name`; only the
  etchings matter. Do not pursue the M-42 “mark too large” issue.
- **General stock nesting is not a priority.** One NCEP per part is acceptable; quantity and
  features matter more than reproducing a full nest layout.
- Multi-part packages / result nesting are lower priority than the per-part feature set.
- Exact reproduction of WiseCAM's automatic cut order is not required, but we should understand it.

## Current known-good

- `container.xml` must have **no trailing newline** (fixed).
- Auto marking is no longer emitted from `partSvg` (`Part.Name` is overwritten). NC etchings:
  `SI` text on layer 6, `PU`/`KO` corrected **layer-4 open lines** with `needSetAdobe=true` and
  `T={};`; KO/PU duplicates collapse by points/text. Rectangles and lead-line technicals on
  layer 4 became cuts (`2122–2124`, `2201–2206`); the line form is the current hypothesis,
  tested by round 8.
- Improved M-1/M-35/M-42 NC→NCEP packages load and match controls.
- The section `cadgroup` now emits **true arcs** (`A` commands) with exact corner vertices for
  UB root fillets, PFC web/flange fillets and tube outer/inner radii. The old sampled polylines
  (7 points per 90°) are gone — that form was the arc-probe load blocker.
- PFC needs exact outer vertices; sharp chords were tolerated before, but the writer now matches
  the real arc form too.
- UB front trims/holes/marks are isolated by the feature matrix; M-3 real-hole probes need a retest
  after the `holeBlock` probe-generator fix.
- M-42 needs the real section + real mitred trims; the default mark must be disabled/repositioned.
- M-34 needs the real section; the known u-face hole shift is ~1 mm.
- `TotalCount=2` survives import/export.

## Mark writing (implemented)

`partFromNc` collects `geometry.marks`; `partSvg` now emits them:

- `SI` etch text -> layer-6 `cadtext`.
- `PU`/`KO` scribe geometry -> corrected layer-4 **`cadline`** (open, `T={};`,
  `needSetAdobe=true`). Auto marking is not emitted.
- KO/PU duplicates collapse by text + points (kind is intentionally not part of the key).
- The default part-name text is still emitted, but `Part.Name` remains overwritten by WiseCAM.

M-3 is the first check: generated NC marks are two bars at `x=-125.5..125.5`,
`y=169.2..179.2` and `y=2266.95..2276.95`, matching the real control's two bars. Round-5–7
WiseCAM results: uncorrected layer-6 bars etch (`2121`, `2125`) but are not corrected;
layer-4 rectangles/lead-line technicals become cuts (`2122–2124`, `2201–2206`). Text without
bars does not etch (`2020`, `2023`). The writer now emits corrected layer-4 lines and no auto
marking; round 8 tests this (`2303/2305/2306`).

## Probe naming convention

- File and `CadRoot.Name` use `<code> <description>`, e.g. `2101 original sweeps`,
  `2121 real text uncorrected bars`.
- Controls keep the real marks.
- Unique descriptive names avoid WiseCAM cache reuse and make results readable without filename
  comments.

## Strategic rules

1. **Use a real NCEP as the container/Adobe/Technology template.** Do not synthesize the whole
   package from scratch if a real reference can be a control.
2. **Control-first, one variable per file.** Keep probes small and paired with controls.
3. **Unique CadRoot names.** Avoid WiseCAM cache reuse; controls keep their real names.
4. **Parser pass is necessary, not sufficient.** Only WiseCAM import/export is proof.
5. **Record negative results.** They define the boundaries and prevent re-testing.

## Mark overwrite vs etch correction

- `Part.Name` is the authoritative mark and is overwritten by WiseCAM.
- The etched text/bars must persist independently; losing them means the marking encoding or layer
  is wrong.
- Uncorrected bars are **layer 6** and etch. Moving the same bars to **layer 4** with
  `needSetAdobe=true` made WiseCAM treat them as cuts in the probes. Text stays layer 6.
- Probe `2020–2025` / `2120–2125` isolates text, uncorrected bars and corrected bars.

## Round-trip acceptance protocol

This is the strongest validation available:

1. Import the generated NCEP into WiseCAM.
2. Export it back (`.ncexa` / `.ncep`) from WiseCAM.
3. Parse the export and compare against a real control:
   - hole count and coordinates
   - end/start trim geometry
   - section path count/arcs/bbox
   - mark text/bars/layer
   - quantity
   - inner cuts/slots/notches/bevels
4. Record the diff in the probe log. A clean parser pass without this is not acceptance.

The existing `probes.ncexa`/`controls.ncexa` exports are a usable first round-trip proxy.

## Cut order (assumption to verify)

- NCEP does **not** carry a cut order; WiseCAM generates the toolpath.
- Assumption: cut order is **automatic** (inferred from geometry/nesting/technology).
- How to verify: export a real project `.ncexa` with `CNC/Plate0-1.zua` and inspect the `Path`
  order, or import a quantity-2 / multiple-part package and compare the generated path order.
- Open questions: shortest-first? per-face? lead-in/out effects? Does quantity duplicate paths or
  nest them?

## Quantity

- NCEP carries `Part.TotalCount`; `1831` confirms 2 survives.
- M-35/M-42 improved packages export `qty=3` from the NC quantity.
- Decide the canonical export policy: NC quantity (job) vs 1 (part library). Keep unique marks
  regardless.
- Nesting/multi-part layout is not required for the first acceptance pass.

## NCEP vs NC vs STEP (feature coverage)

| Feature | NCEP | NC (DSTV) | STEP |
| --- | --- | --- | --- |
| 3D geometry | developed section + unrolled skin | per-face contours | full B-rep |
| Holes | yes | yes | yes (geometry) |
| Enclosed/inner cuts | yes | yes | yes (geometry) |
| Bevels | native nested cluster | bevel columns | geometry only |
| Marks/etch | yes, layer 6/4 | `SI`/`PU`/`KO` | geometry only |
| Quantity | `TotalCount` | `ST` quantity | **lost** |
| Canonical stance | native section group | per-face | native 3D |
| Stock/Adobe/USERPATH | yes | no | no |

This is why NCEP is the preferred export: it is the only format that carries **quantity + mark +
bevel/technology intent**.

## What can be tested now

1. **Fixed M-3 hole variants** (`1606–1608`, `1801/1803/1805/1808`) — confirm the missing-hole
   result was the probe bug.
2. **Per-corner arc roles** (`1900–1908` UB, `1910–1917` tube) — identify which arcs are
   manufacturable.
3. **Grey-strip hole removal** (`1920–1924`) — validate the UB column removal form.
4. **Bevel nesting** (`1940–1944`) — confirm nested child paths are required.
5. **M-34 handedness** (`1930–1932`) — u-face hole shift.
6. **Quantity** — already confirmed for 2/3; decide export policy.
7. **Cut order** — inspect a real exported `CNC/Plate0-1.zua`; no new NCEP needed.
8. **Round-trip comparison** — use the existing `.ncexa` exports from the loaded probes.

## Next implementation targets

1. ~~True arc section generation in the writer (UB/tube).~~ **Implemented 2026-11-04**; needs a
   WiseCAM import check.
2. Accurate shaped/mitred end-cut development (M-42).
3. Grey-strip hole filter for UB.
4. Bevel `PosMap` cluster generation from NC.
5. Corrected mark bars/layer-4 + short-part/no-mark rules.
6. Inner cuts/slots/notches/counterbores.
7. Use real NCEP templates for container/Adobe/Technology; one package per part.
8. Round-trip acceptance tests against real controls.
