# Architecture — CUT_DEPTH detection (manufactured NC)

Decision log for finding cuts that go **deeper than the part allows** — the beam bottoms out
inside the material (over-cut / CUT_DEPTH). Read with `AGENTS.md`; raw NC facts live in
`docs/nc1-dstv-format.md` and `docs/canonical-orientation.md`.

Status labels: **adopted** · **prototype** · **rejected** · **abandoned** · **open**.

> **This file exists because we keep re-trying the same detectors.** Before adding a new
> CUT_DEPTH probe, check the rejected list below.

---

## 1. Fixtures (no ground truth)

- `M_36.nc1` — `PFC250*90`, L=6134.07, depth 250, flange 90, tf 15, **tw 8**, r 12.
- `M_39.nc1` — same section family, L=5357.7.
- Both live in `/Users/menglinmaker/Downloads/selected-26-Luenard-Balwyn-North.zip/`.
- **Neither has a STEP.** Any detector that needs a ground-truth ideal is out for these parts.

Far-end geometry (identical pattern on both, coordinates from M_36):

- Flanges end at **x = 6054**; the web **tenon** continues to **x = 6134**.
- Web cutout each side: `(6054,0) → (6054,19)`, fillet **r = −11** → `(6065,30)`, then
  `(6134,30) → (6134,225)`, mirror at y = 225…250.
- DSTV notches on `v`: `(6054, 30)` and `(6054, 225)`.
- The 2 invalid cuts are **on the flanges, tw = 8 mm from the corner end where the cut fillets
  exist** (operator). They are the thing to detect; they are *not* in the flange `o`/`u`
  contours (those are plain rectangles ending at 6054).

---

## 2. Rejected approaches (do not re-litigate)

| Approach | Where | Verdict / why |
|---|---|---|
| **Light sabre on the stock**, tilted faces only | `sabre.ts` (`sabreShape`) + old viewer | **Rejected for CUT_DEPTH.** Samples only faces tilted to the member (`|n·axis|` 0.05–0.98), fires a beam, flags `thickness > 25 mm`. Fine for stock bevels; it cannot see a manufactured over-cut. Replaced by `cutReach` in `6d0e35c`. |
| **Sabre on the manufactured solid, default filter** | `reconstructFromNc.ts` + `sabreShape` | **0 samples** on M36/M39: the finished cut faces are square ends (`≈1`) or lengthwise walls (`≈0`), both filtered out. |
| **Sabre with `allFaces: true`** | `sabreShape(..., { allFaces: true })` | **Rejected — false positives.** Flags the long stock skin (bottom face, thickness 90 mm) and the square end caps (infinite). Operator: “so much red … in places with no cut lines too.” |
| **Sabre with a “cut face” filter** (distance to section boundary + skip end caps) | `reconstructFromNc.ts` | **Prototype only.** Localises to the far-end tenon (15 triangle patches at x≈6054–6111), but it is still **face-based, slow**, and highlights faces instead of the cut. |
| **Red face patches** (`SabreFailure.tri` → translucent red mesh) | `PartViewer.tsx` `sabrePatches` | **Rejected.** Wrong abstraction: the user wants the **cut line** marked, not the surface. Also caused an orbit lag (see §4). |
| **`cutReach` on the stock section** | `src/lib/audit/cutReach.ts` | **0 failures on M36.** The stock section has no web tenon, so the beam test on the section cannot see the manufactured over-cut. |
| **CSG diff red surface** (`STEP − manufactured`) | `booleanDiff.ts` / overlay | **Unavailable.** Requires a ground-truth STEP; M36/M39 have none. |
| **1 m flange fillet strip** | `reconstructFromNc.ts` (fillet correction) | **Rejected.** Over-cuts the flange by ~1 m past the end. The fillet is local to the corner; keep the strip bounded. |
| **Stock-edge cut segments without `materialReaches`** | `projectNc` / reconstruction | **Rejected.** The raw-stock outline is not a cut; it must be filtered (see `projectNc` stock-edge + material-reach rules). |

---

## 3. Adopted: sample the NC projection cut lines (prototype)

**Sample the NC projection cut lines, not faces.** Implemented in `projectNc` → `cutSamples`
(1 mm spacing, face outward normal) and `sabreSamples` (beam probe at those points).

Current filter in `reconstructFromNc`:

- flange faces only (`face === 'o' || face === 'u'`),
- skip the part ends (`x > 1 && x < maxX - 1`) — the ends are traced by the perimeter, not bored
  along the member,
- beam along the face outward normal.

Result on the fixtures: **M36 = 16 failing samples (8 per flange), M39 = 18 (9 per flange)**, all
at the far-end corner (`x ≈ 6054` / `x ≈ 5278`) where the `r = −11` fillets are. That is the 2
flange subcuts the operator described — and the failing span is **Tw = 8 mm** from the corner end.

**Never nudge/move a cut line to make the probe hit.** A cut line is where the laser goes; shifting
it 1 mm makes the result inaccurate.

**Gate (final):** follow the beam inward from the cut line for the intended cut depth (`T + r`)
**plus 1 mm**, then test whether that **endpoint is inside the solid**. If it is, the beam did not
exit at the cut depth — it stays inside the material. The entry distance is irrelevant: the beam
may cross air first (e.g. a cut line on a flange end edge, 15.6 mm of air before the web tenon),
which is exactly why the earlier `entry < 1 mm` gate wrongly dropped M36's −Y flange.

Result with the endpoint-inside gate: **M36 = 18 (9 per flange), M39 = 17 (8 + 9)** — both flange
subcuts on both parts, spanning **Tw = 8 mm** from the corner end.

**Findings severity: `CUT_DEPTH` is an `error`.** A cut that stays inside the material past
`T + r` has removed metal that cannot be put back — it is scrap, not a warning.

The probe requires the beam to **enter the solid at the cut line** (first hit < 2 mm) and **stay
inside past the intended cut depth** (`thickness > T + r + 0.5`). A beam that misses the solid
(entry metres away) or exits at `T + r` is not a failure, so no red line is drawn where the area
does not go into the solid.

**Beveled cut lines are excluded.** A welding-prep bevel (any non-zero angle or distance) is a
slanted cut **surface**, not a square wall-piercing cut: the face normal is not its cut path. The
normal probe then reports the section width as "depth" (e.g. a T flange side bevel) and flags a
cut that never goes through the wall. Only plain segments (`angle 0`, `distance 0`) feed
`cutSamples`.

Rendering (final style):

- Projection depth is **`T + r`** — face thickness (`faceThickness(frame, section, face)`) plus the
  root radius (`header.dimensions[4]`, the same `r` the web cut uses). M36/M39 = 15 + 12 = 27 mm.
- The failing cut line is swept into the material into a **1 mm closed slab** (`PartViewer`
  `sabrePoints`), rendered on the **layer-1 pass** (depth buffer cleared) so it shows through the
  solid while its own faces depth-sort — constant translucency, no view-dependent darkening.
- A **red thick cut line** is drawn along the failing span (the actual NC cut line), matching the
  area.
- Not the full entry→exit bore (that spans the section and turns the wrong way on an end edge),
  and not face patches.

This is fast (1 mm samples on the sparse cut path, no whole-solid face scan) and has no stock-skin
or end-cap false positives.

- The cut lines are already projected for the viewer (`projectNc` → `NcLineSets`), sparse and in
  scene/canonical coordinates.
- Fire the beam only at points **on the cut line**, along the face normal, and test against the
  manufactured solid (or the section where the solid is not needed).
- Mark the **failing cut-line span** in red (line, not a face patch). This is what the operator
  asked for: “testing via cut lines is so much faster — NC projection cut lines.”
- The cut-line sample set also removes the stock-skin / end-cap false positives by construction:
  those surfaces are not cut lines.

Open: the exact 2-flange-subcut pattern (tw = 8 mm from the corner end at the fillet) still
needs to be pinned to a concrete cut-line span so the check reports exactly 2 findings on each
of M36/M39.

---

## 4. Repeated implementation mistakes (check these first)

- **Highlighting faces when the operator wants cut lines.** Surface patches read as “red
  everywhere” and hide the actual cut. Draw the guilty cut-line span.
- **Sampling all solid faces.** The stock skin and end caps are not cut faces; firing into them
  reports material no cut removes.
- **Running the solid probe on every reconstruction.** It is the slow path. Prefer the sparse
  projected cut lines; do not put a multi-second mesh probe on the rebuild hot path.
- **Unstable array props re-run the viewer scene effect.** `sabrePatches={failures.map(...)}`
  allocates a new array every render; the `PartViewer` effect depends on it, so the whole
  three.js scene is rebuilt and **orbiting lags**. Memoize the array (`useMemo`) — this, not the
  sabre, was the rotation lag.
- **Authored vs canonical frame.** Any 3D result produced before the rollback (`tri`, `point`,
  `normal`, `entry`, `exit`) must be rolled back with the solid: channel `(x,y,z) → (x,z,−y)`,
  I-section `(x,y,z) → (x,−z,y)`. The viewer seats the canonical frame only.
- **Arc sign.** `sagittaArcTo(b, radius >= 0 ? sagitta : -sagitta)` must match `arcSamples`
  (`sign = radius >= 0 ? -1 : 1`). This fixed the M36/M39 fillet curves.
- **Spares / pairing.** Do not pair identical left/right pieces or add spares. The two halves of
  a stock beam are independent (`AGENTS.md`).
- **Splitting the UB first.** Never split the beam lengthwise before cutting; keep it clamped and
  split locally.
- **NCEP probe strategy.** Start from a real control, change one variable per file, keep packs
  small. Do not generate whole packages from scratch.

---

## 5. Related files

- `src/lib/step/sabre.ts` — light-sabre probe (`sabreShape`, `SabreFailure.tri`).
- `src/lib/parsers/ncProject.ts` — projected cut lines (`projectNc`, `NcLineSets`).
- `src/lib/parsers/ncGeometry.ts` — parsed NC contours/notches; `arcSamples`.
- `src/lib/audit/cutReach.ts` — stock cut-reach audit (section-based).
- `src/lib/step/reconstructFromNc.ts` — manufactured solid build (authored → canonical rollback).
- `src/features/preflight/PartViewer.tsx` — manufactured pane, NC line projection, overlays.
- `docs/architecture.md` — the overlay-diff decision log (same format).
