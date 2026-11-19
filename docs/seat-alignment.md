# Stock alignment (seating) — technique batches

How a STEP part is rotated onto the catalogue **stock** section, and the batches that chose the
method. Companion to `docs/architecture.md` §16 and `docs/canonical-orientation.md`.

The operator's complaint that started this: on **J12095 Hex Module Frames** —

| part | symptom |
|---|---|
| `item1` (PFC250) | "floating in the middle of nowhere" |
| `item10` (200UB25) | "decent" |
| `item11` (200UB25) | "quite bad" |
| `item12` (200UB25) | "still lopsided" |

## The rig

`seatFit.ts` + `seat-batches.test.ts`. Every candidate seat is scored the same way, from **stock
planes**:

1. The catalogue section is read as **flats**: maximal runs of collinear outline edges, outward
   normals, offsets and lengths. Arcs (root fillets, tube corners) break runs, so a UB yields its
   four outer faces, the two flange undersides and the two web faces.
2. The seated model's planar faces are read the same way, in the viewer's section frame:
   `u = −world Z`, `v = +world Y` (`CANONICAL_X_AXIS` / `CANONICAL_Y_AXIS`).
3. Each catalogue flat is matched to the model face with the same outward normal (≤10°) and the
   nearest offset. Score = **length-weighted** mean offset error, worst offset, mean normal error
   ("tilt"), and the count of unmatched flats.

Two numbers matter, and they catch different faults: **offset** is placement (a part in the wrong
place), **tilt** is rotation (a part rolled or leaning). The original heuristic scored offset ~0
while tilt was 9° on `item13` — invisible to a bounding-box or containment test.

The rig only reads a matrix, never calls the seating code, so a technique cannot flatter itself.

## Batch 1 — technique screening

Candidates (all start from the section detector's frame when present, as the app does):

| technique | idea |
|---|---|
| `detector` | baseline: PCA member axis + principal-angle roll + containment vote (`seatQuaternion`) |
| `faces-boundary` | stock-face frame, faces weighted by boundary length |
| `faces-area` | stock-face frame, faces weighted by area |
| `quarter-search` | enumerate the 4 quarter-turns, pick the best by stock-plane score ("face identification") |
| `corners` | lengthwise edge directions for the member; the 4 stock corners for the roll ("edge matching") |

Scores below are `offset / worst` in mm and `tilt` in degrees (best per row in bold).

| part | detector | faces-boundary | faces-area | quarter-search | corners |
|---|---|---|---|---|---|
| item1 | **0.77** / 0.55 | 18.81 / 8.92 | 0.77 / 0.55 | 0.77 / 0.55 | 5.59 / 6.96 |
| item9 | 0.00 | 0.00 | **20.0** | 0.00 | 0.00 |
| item10 | **0.00** / 0.27 | 0.00 | 0.00 | 0.00 / 0.27 | 0.00 / 0.27 |
| item11 | 1.19 / 0.33 | 1.19 | 1.19 | 1.19 / 0.33 | 1.19 / 0.33 |
| item12 | **20.0** / 10.0 | 20.0 | 20.0 | 20.0 | 20.0 |
| item13 | 1.20 / **9.23** | 1.20 | 1.20 | 1.20 / 9.23 | 1.20 / 9.23 |
| item35 | 0.00 | 0.00 | 0.00 | **0.00** | 0.00 |

Conclusions:

- **Edge/corner matching lost.** On real Tekla exports the corner lines are interrupted by cuts,
  chamfers and copes, and a 4-point Procrustes then over-constrains: item1 19.93 mm, item12 20 mm.
  It is a good *correspondence* idea and a bad *measurement*.
- **Boundary-length weighting lost** on an open section: the PFC's long narrow faces outranked the
  web and flipped the frame (item1 18.81 mm). Area weighting is safer.
- **Quarter-turn search cannot fix a roll** (item12 stays at 20 mm): the error is continuous, not a
  multiple of 90°.
- The baseline already fails one item completely (`item12` 20 mm) and leaves a 9° roll on another
  (`item13`) — both invisible to the old containment vote.

## Batch 2 — iterate the winner

Winner: **stock-face frame + section-plane ICP** (`seatFromStockFaces`).

1. **Frame** — a stock face's normal *is* a section axis; two perpendicular normals span the cross,
   so `u × v` is the member direction. Candidates are built per axis assignment (the heaviest
   normal is not reliable on an open section) and scored.
2. **ICP** — one linearised step per iteration solves roll `δ` + section translation from the
   matched stock planes; damped to 50% of a ≤7° step, up to 24 iterations.
3. **Acceptance** — the refined seat is returned only if it scores better than the seat it started
   from. This is what makes the change safe on parts where the frame read fails.

Result: `item12` **20 mm → 0.77 mm, 0.01°**, `item13` **9.23° → 1.38°**, everything else unchanged
or better. `item1` stays at its baseline (the refinement declines).

Three traps, each cost a debugging round — do not "simplify" them away:

- **The rotation term needs a real point on the face.** Using the plane's foot point `n·d` makes
  `n·(δ × p)` identically zero, so the roll is unconstrained and the solve diverges (`item11`
  produced −210°).
- **`fitSectionPlanes` returns the error, not the correction.** Apply `−angle`. Feeding it back
  positive doubles the misalignment — `item10` went from perfect to 20 mm.
- **Re-centring must keep the existing translation.** `T(−centre)` drops it; the correct new
  translation is `position − centre`. With the wrong form the iterated fit walks the part by exactly
  one section dimension (m137: 100 mm).

## Batch 3 — refinement

- **Robust pass.** After convergence, refit using only planes inside `max(1 mm, 2 × median
  residual)`. This pulls the worst-case planes in without moving the bulk: `item11` tilt 0.33° →
  **0.02°**, `item13` 1.38° → **0.02°**.
- **Variant check.** The remaining offset (~1.2 mm on items 11–13) is *not* a seating error: scoring
  the same seat against `200UB18.2` / `200UB22.3` is worse, so the detected `200UB25.4` is right and
  the residue is real model-vs-nominal geometry. Do not chase it with the seat.

Final shipped column:

| part | detector offset / tilt | shipped offset / worst / tilt |
|---|---|---|
| item1 | 0.77 / 0.55° | 0.77 / 20.0 / 0.55 |
| item9 | 0.00 / 0.00° | 0.00 / 0.00 / 0.00 |
| item10 | 0.00 / 0.27° | 0.00 / 0.00 / **0.00** |
| item11 | 1.19 / 0.33° | 1.19 / 4.22 / **0.02** |
| item12 | **20.0** / 10.0° | **0.77** / 3.08 / **0.01** |
| item13 | 1.20 / 9.23° | 1.20 / 6.44 / **0.02** |
| item35 | 0.00 / 0.00° | 0.00 / 0.00 / 0.00 |

(`item1`'s "missing 8" are catalogue flats a channel genuinely does not present at this length —
not an alignment fault.)

## Why the old seat failed at all

Two independent causes, both fixed:

1. **PCA over the vertex cloud.** The member axis came from the point cloud's principal axis, which
   mixes cut faces and uneven tessellation. On the real `UB250*31` (`test/fixtures/ub`, M_12) that
   tilted the member 0.14° — 12.8 mm of false depth over 5.3 m; on `item12` it left the part ~9°
   rolled.
2. **Flat faces reported as non-planar.** Tekla exports a flat as a B-spline patch, so
   `BrepFace.planar` was false on every stock face and *nothing* stock-face-based could run. `mesh.ts`
   now tests planarity **geometrically** (boundary points vs their best-fit plane, 0.1 mm).

## Where this lands in the code

| file | role |
|---|---|
| `src/lib/step/seatFit.ts` | flats, scoring, association + damped rigid step (the rig's maths) |
| `src/lib/step/seat.ts` | `seatFromStockFaces`: frame candidates → ICP → robust pass → acceptance |
| `src/lib/step/mesh.ts` | geometric planarity for B-spline flats |
| `src/lib/step/seat-batches.test.ts` | the batch table + the pinned outcome |
| `src/lib/step/seat-ub.test.ts` | the single-part UB regression (exact bbox after seating) |

Log a new technique here (name, idea, score table) before shipping it — the rig is cheap to extend
and the table is the argument.
