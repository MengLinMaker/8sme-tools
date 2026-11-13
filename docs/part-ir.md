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

- **NC → IR → NC: strict at the semantic level.** Same contours, radii, bevels, refs, holes/slots,
  notches, marks, quantity and dimensions. Output is a clean canonical NC, not byte-identical.
  At a shared face edge the face letter may legitimately canonicalise to the adjacent face; compare
  the **chart station**, not the letter. Small mitre/corner overshoots are extrapolated, not clamped.
- **NCEP → IR → NCEP: ideal at part level.** Exact package reproduction is not expected
  (Adobe/Technology/section presentation); compare section, cuts, holes, marks and quantity.
  The importer/exporter round-trip is covered by `toNcep.test.ts`.
- **STEP → IR → STEP: deliberately partial.** The 2-D IR carries cut boundaries well; full STEP
  needs cut surfaces/booleans. 3-D export is deferred until the 2-D IR is stable.

## Files

- `src/lib/part/ir.ts` — types and chart/face lookups.
- `src/lib/part/fromNc.ts` — DSTV NC → PartIR.
- `src/lib/part/toNc.ts` — PartIR → canonical DSTV NC.
- `src/lib/part/fromStep.ts` — seated STEP cut edges → PartIR. STEP cut edges are mapped point-by-point from the B-rep wire order, so rounded-corner cut lines stay curved and end cuts stay connected. Planar inner-cavity faces are excluded so flange cuts are not duplicated. Connected runs are merged and split at the seam. Corner points are mapped from the section's known corner circles (centre + radius) by arc angle. Signed bevels are carried per vertex, and NC tube root-line bevels are shifted to the outer skin for display/diff only (round-trip data stays authored).
- `src/lib/part/fromNcep.ts` — NCEP part SVG → PartIR (holes, truncates, marks, start/end).
- `src/lib/part/toNcep.ts` — PartIR → NCEP part/package (shaped start/end derived from IR cuts).
- `src/lib/part/toNcGeometry.ts` — PartIR → face-space NC geometry, the coordinate transform the 3D projector consumes.
- `src/lib/part/svg.ts` — layered view (section + one layer per chart), with STEP-over-NC overlay.
- IR charts use the canonical NCEP coordinates on screen: **x positive right, y positive down**. This is also the coordinate system NCEP generation expects. `orientation: 'wisecam'` is available for comparison experiments.
- The preflight viewer is now IR-driven: NC cut lines/marks, STEP cut lines and the NCEP unrolled preview all build from `PartIR` (with the old NC parser only as a fallback when the IR cannot be built).
- Preflight → viewer → **Surface (IR)** renders the same pane count as the 3D view (STEP / NC / diff) with **synced pan-zoom**. The diff pane draws STEP cuts over the NC net: red = overcut (deeper into material), blue = undercut, grey = coincident. Raw-stock edges are tagged in NC IR and excluded from the diff (drawn as faint face boundaries in both views). The diff base includes NC holes/slots, so coincident STEP loops are omitted entirely. Rounded faces are drawn as grey corner strips (developed width r·π/2), not as face lines. Segment colour is the signed offset from the nearest NC cut, so a pure lateral shift is not mistaken for a material difference.
- Strokes are regenerated at `1/zoom`, keeping them thin at any zoom instead of fattening the lines.
- `src/lib/part/*.test.ts` — fixture round-trips; `test/fixtures/part-ir/` holds real job files
  that exposed edge cases (boundary holes, mitre overshoot, `h` marks, notches).
