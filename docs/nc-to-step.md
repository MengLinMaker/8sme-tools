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

## Open items

- Confirm which matrix variant registers as UB.
- Decide the correct representation of the overlapping `u` holes.
- If metadata does not explain it, compare the reconstructed cross-section against a real UB STEP
  (flange taper/root fillet/product structure).
