# NC → STEP generation and WiseCAM section recognition

Companion to `docs/ncep-probe-log.md` and `docs/ncep-open-questions.md`.

## Goal

Generate a STEP from a DSTV `.nc1` that WiseCAM imports as the **standard UB/PFC section** (not a
custom section), with holes, end cuts and overlapping features preserved.

## Tool

```sh
pnpm nc-to-step -i <file.nc1|directory> [-o <file.stp|directory>]
```

Implementation: `tools/nc-to-step.mjs`, using `reconstructStepFromNc` (`src/lib/step/reconstructFromNc.ts`).

Current outputs:

- `~/Downloads/M_12-corrected.stp` — valid M_12 STEP
- `~/Downloads/M_12-corrected.ncep` — matching NCEP
- `~/Downloads/M_12-corrected.nc1` — re-emitted NC

STEP bbox is `5308.97 × 252 × 146 mm`; the solid imports and measures correctly.

## Overlapping holes (M_12)

`M_12` has two intersecting hole pairs on the `u` face:

| Hole A | Hole B | Centre distance | Sum of radii |
|---|---|---|---|
| `(200, 33) Ø14` | `(205, 38) Ø22` | 7.07 mm | 18 mm |
| `(200, 113) Ø14` | `(205, 108) Ø22` | 7.07 mm | 18 mm |

- The NC itself encodes the overlap; this is not a parser bug.
- Cutting all 62 holes as one OCC `compoundShapes` boolean causes `memory access out of bounds`.
- Cutting holes **sequentially** succeeds. `reconstructFromNc` now does this.
- The NCEP still carries both overlapping circles, so WiseCAM may still flag a collision. Decide
  from the drawing whether these are two real intersecting holes (merge the cut contour) or a
  Ø22 counterbore around the Ø14 hole.

## UB section recognition

Observed in WiseCAM:

- **PFC STEPs register correctly.**
- Generated **UB STEPs register as a custom section**, even though our own section detector
  (`detectStepSection`) identifies the geometry as `250UB31.4` with score 1.0.
- Metadata-only changes to AP242 exports did not help.

Common pattern in the working J12095 UB STEPs:

- **AP203** / `CONFIG_CONTROL_DESIGN` (`150UB14`, `200UB18`, `200UB25`).
- The designation appears in **both `FILE_NAME` and `PRODUCT`**.
- Format is **digits + `UB` + digits**, no decimal and no `*`: `200UB25`, not `250UB31.4` or
  `UB250*31`.

Test matrix: `~/Downloads/M_12-step-matrix.zip` — 12 STEPs, identical geometry, varying schema and
metadata. See `README.md` in the zip for the labelled test order.

Highest-priority variants:

1. `09 AP203 file+product 250UB31 (best).stp`
2. `10 AP242 file+product 250UB31 (schema test).stp`
3. `12 AP203 filename only 250UB31.stp`

If `09` works and `10` does not, AP203 is required. If `12` works alone, WiseCAM reads `FILE_NAME`.
If none work, the remaining difference is the Tekla/SolidWorks product/assembly structure, not the
section designation string.

## Stock section arcs (implemented)

The section builders (`src/lib/sections/stock.ts`) return a **sampled polyline**: every rounded
corner is ~6 chords. Drawing that polyline into the extruded stock gives a faceted section, and
WiseCAM reads it as a **custom** profile instead of the standard RHS/SHS/UB it is. An earlier fix
fitted a radius per sampled vertex (`sectionArcRadii`), which helped UB root fillets but left two
problems: a corner became a *chain* of small arcs, and the inner void of a hollow was still drawn
as a chorded polygon (so a rebuilt RHS had 4 outer cylinders and a 28-sided hole).

`sectionPath` (`src/lib/sections/sectionPath.ts`) now decomposes the contour into **real
primitives**: each run of co-circular samples collapses into **one circular arc**, and a full round
contour (CHS, a bored circle, a round void) into **one circle**. `sectionSketch`
(`src/lib/step/sectionBrep.ts`) draws that path, so an extruded stock has a single cylindrical
brep face per corner — **outer outline and inner void alike** — and a CHS is a true cylinder.

The merge is exact, not a smoothing pass: builder samples are exactly on their circle (they come
from `cos`/`sin`, and the stance rotations are exact), so the co-circularity tolerance is 1e-6 mm.
A run must also be a genuine sampled arc — at least three steps, a plausible radius, a sub-180°
sweep, tangent continuity with its own chords, and **evenly spaced samples** (the builders walk an
arc in equal angular steps; a circle fitted across a straight edge and the start of a corner has
one huge step beside one tiny one). Without those tests a long flat face merges into a near-tangent
"arc" of absurd radius. Sharp corners stay sharp.

Regression: `sectionBrep.test.ts` round-trips each built stock through STEP and asserts the RHS has
4 + 4 cylindrical corners of 22.5 / 13.5 mm (no planar facets on the corners), the CHS is one
cylinder of the OD, and a UB keeps 4 cylindrical root fillets; `sectionPath.test.ts` covers the
contour decomposition itself.

This is applied to every manufactured NC→STEP rebuild. The `NCEP` cadgroup writer still uses the
sampled points.


## Cutting through the root fillet (implemented)

A lengthwise cut — a web-tenon tab edge, or one the preflight moved off the fillet with
`moveCutInNc` — is drawn on the **web face plane**, but the rolled web/flange root fillet bulges
`r` in front of that plane. The I-section side (`v`/`h`) silhouette is trimmed through the web
plate only, which is what keeps a flange tip past a mitred web (TR9 `3uc-101`/`3uc-104`). That
web-only trim leaves the fillet material standing along the cut, and after a fillet move removes
the **whole fillet band at the tab start**, so the manufactured STEP was wrong.

The rebuild now also clears the root fillet: each band (`tf…tf+r` and `d−tf−r…d−tf` in the
centred depth coordinate) is clipped out of the face's notch and cut across the fillet width —
and only inside the band, so the flange plates and mitred tips are untouched. This is the same
"follow the cut through the stock root radius" rule the PFC web face already used
(`buildFaceCut`), applied to an I-section's web silhouette. Once both fillet cuts are applied,
`UC250-clean` produces a STEP whose tab start is the flat web, with no curved fillet wing.

Regression: `reconstructFromNc.test.ts` applies the two real `UC250-clean` fillet moves, rebuilds
the STEP, and asserts no material remains in the fillet band past the flange end while the web
tenon still reaches the NC end.

## Open items

- Confirm which matrix variant registers as UB.
- Decide the correct representation of the overlapping `u` holes.
- If metadata does not explain it, compare the reconstructed cross-section against a real UB STEP
  (flange taper/root fillet/product structure).
