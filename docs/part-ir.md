# Part IR — canonical intermediate representation

Canonical form for switching between NC, NCEP, STEP and the visualisers. Code lives in
`src/lib/part/`.

## Model

The IR is **2-D unwrapped UV only**:

- `station` — perimeter station in mm, **centred on the seam** (`-seam/2 … +seam/2`).
- `along` — distance along the member in mm.
- No face tag on a feature. A chart's layout maps `station → (DSTV face, authored across)`.

A part has one or more **charts**. A chart is one continuous unwrap with its own layout:

- `front` — the NCEP/machinable surface, built from `unrolledLayout`.
- `rear` — a face the front net cannot represent (typically `h` on I/U/PFC), so strict NC
  round-trip does not silently drop it.
- `inner` — reserved for cavity/inner-wall work.

This keeps features coordinate-only while still covering every surface a format carries.

## Contents

- `PartIr`: mark, profile code/type, dimensions, section/inner outlines, length, quantity,
  grade/order, charts, features, marks.
- `PartFeature`: `cut` / `hole` / `slot` / `notch`, chart id, shape (`polyline` with optional
  radii, `circle`, `slot`), plus DSTV semantics needed for export (contour class, bevels, refs,
  hole type/extra, notch type).
- `PartMark`: `etch` (SI) / `marking` (PU/KO), chart, shape, block, optional text.

No provenance, confidence, source blobs or duplicate interpretations. Importers canonicalise.

## Round-trip contracts

- **NC → IR → NC: numerically exact at DSTV precision.** Every contour/hole/notch/mark station,
  along-coordinate, radius, bevel, ref and header value round-trips with **0.0 mm** difference;
  `toNc.test.ts` asserts this with a `1e-9` tolerance. Output is a clean canonical NC, not
  byte-identical. At a shared face edge the face letter may legitimately canonicalise to the
  adjacent face; compare the **chart station**, not the letter. Small mitre/corner overshoots are
  extrapolated, not clamped.
- **NCEP → IR → NCEP: ideal at part level.** Exact package reproduction is not expected
  (Adobe/Technology/section presentation); compare section, cuts, holes, marks and quantity.
  The importer/exporter round-trip is covered by `toNcep.test.ts`.
- **STEP → IR → STEP (cut lines): strict.** STEP cut edges use the same
  `projectCutEdgesToFaces` pass as the 3-D viewer, then the same development as NC. An m71
  round-trip test checks the IR projects back onto the identical face lines (0.0 mm reverse,
  <0.05 mm mean forward).
- **STEP → IR → STEP (full solid): not implemented.** The 2-D IR carries cut boundaries well; full
  STEP needs cut surfaces/booleans. 3-D export is deferred until the 2-D IR is stable.

## Files

- `src/lib/part/ir.ts` — types and chart/face lookups.
- `src/lib/part/fromNc.ts` — DSTV NC → PartIR.
- `src/lib/part/toNc.ts` — PartIR → canonical DSTV NC.
- `src/lib/part/fromStep.ts` — seated STEP cut edges → PartIR. Cut edges use the same
  `projectCutEdgesToFaces` projection as the 3-D viewer, then develop onto the unrolled chart and
  dedupe overlapping corner segments. Through holes/slots keep only the **nearest outer-face rim**
  (the side the cut cylinder sits on), so STEP matches the single machined line the NC authors
  without depending on the NC. Closed rims are classified as holes/slots. A hole is assigned to a
  face by its **cylinder axis** (a drill is normal to its face), then the side nearest the cylinder
  centre — scoring the centre's direction from the section centroid mislabelled an I-section web
  hole as a flange hole and added a phantom flange-centre column (M/12). Bevels are carried per
  vertex; NC tube and angle root-line bevels are shifted to the outer skin for display/diff only
  (round-trip data stays authored). An angle is one-sided, so a full-wall prep sets the outer skin
  back at both ends whatever its signed side; the drawn line shifts into the material at each end.
- `src/lib/part/fromNcep.ts` — NCEP part SVG → PartIR (holes, truncates, marks, start/end).
- `src/lib/part/toNcep.ts` — PartIR → NCEP part/package (shaped start/end derived from IR cuts).
- `src/lib/part/toNcGeometry.ts` — PartIR → face-space NC geometry, the coordinate transform the 3D projector consumes.
- `src/lib/part/svg.ts` — layered view (section + one layer per chart), with STEP-over-NC overlay.
- IR charts use the canonical NCEP coordinates on screen: **x positive right, y positive down**. This is also the coordinate system NCEP generation expects. `orientation: 'wisecam'` is available for comparison experiments.
- The preflight viewer is now IR-driven: NC cut lines/marks, STEP cut lines and the NCEP unrolled preview all build from `PartIR` (with the old NC parser only as a fallback when the IR cannot be built).
- Each IR pane colours its cuts from the thickness key of the 3D pane it mirrors: the STEP pane uses the detected STEP section's face frame and thickness scale, the NC/diff panes use the NC's. Sharing one map recoloured the STEP IR whenever the NC carried a different set of wall thicknesses, so the unrolled view stopped agreeing with the projected model it exists to cross-check.
- A cut polyline is coloured **per segment, by the face the segment rides** (its midpoint), not once from its first vertex. The 3D projection colours each face's trace separately, and a developed end cut crosses faces with different walls (a PFC end cut runs across u → v → o: flanges one plate, web another). Keying the whole line off a corner (which ties to one face) made the flange cuts read as web thickness. This is why a PFC could never match with a single colour per polyline.
- **The IR is faithful, not cosmetic.** It keeps the NC's authored cut line — often on a bevel's root/inner wall — and does **not** shift it to the outer skin. The STEP IR draws the real geometry, which meets the outer skin `wall·tan(prep)` away from that line, so a beveled end can differ between the NC IR and STEP IR by a couple of millimetres. That is a genuine NC/STEP (or NC imperfection) difference: do not offset the IR to hide it. The 3-D projection may shift a line for display, but the IR data and view stay authored.
- **Angles are a section of a prism, not a closed tube.** The front chart is the two outer leg faces as one continuous strip: `unrolledLayout('L', …)` puts `u` (reversed) on the negative side and `v` on the positive side, sharing the sharp outer corner at station 0, with `seam = legA + legB`. No per-face charts and no gap — the a1/a2 NC author each face's across from the corner (`y = 0` at the corner), which a1's mitre confirms (the `u`/`v` start arcs meet at the same along only when both read `y = 0` at the corner). This layout also lets the STEP IR exist for an angle at all (`unrolledLayout` used to return null).
- **The STEP IR may only label a segment against a face the chart develops.** On a one-sided section two letters can resolve onto the same material side (an angle's `o`/`u` both point at the bottom leg). An unfiltered lookup took the first (`o`, which has no chart region) and returned no station, silently dropping every bottom-leg cut from the STEP IR while the 3-D pane still drew them — the STEP IR showed half-strips. `brepProjectedRuns` / `cylinderFeatures` filter their planes to `layout.faces`, and the closed rims (holes/slots) are harvested from the developed edges even when the exact-projection cut path is used.
- Preflight → viewer → **Surface (IR)** renders the same pane count as the 3D view (STEP / NC / diff) with **synced pan-zoom**. The diff pane draws STEP cuts over the NC net: red = overcut (deeper into material), blue = undercut, grey = coincident. Raw-stock edges are tagged in NC IR and excluded from the diff (drawn as faint face boundaries in both views). The diff base includes NC holes/slots, so coincident STEP loops are omitted entirely. Rounded faces are drawn as grey corner strips (developed width r·π/2), not as face lines. Segment colour is the signed offset from the nearest NC cut, so a pure lateral shift is not mistaken for a material difference.
- The dark material panel (and the clip over the reference strips) is the strip between `startCut` and `endCut`. It is only used when both cuts reach the net edges and the traced strip is a simple polygon; otherwise the panel falls back to the full net rectangle. A square-cut end develops to one station (no trim), and a notched end can step back, so clipping regardless used to blank the panel and hide the rounded-corner strips. Never sort a cut by station to build the polygon — that reorders a notch's step into a crossing.
- Strokes are regenerated at `IR_LINE_SCALE/zoom` (`IR_LINE_SCALE = 1.8`), keeping them readable at any zoom instead of fattening the lines; the base width is scaled to the part length, and the extra weight matters because the unrolled net is shown much smaller than the 3D model on a low-contrast screen.
- `src/lib/part/*.test.ts` — fixture round-trips; `test/fixtures/part-ir/` holds real job files
  that exposed edge cases (boundary holes, mitre overshoot, `h` marks, notches).
