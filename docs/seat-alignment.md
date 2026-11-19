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
| item1 | 0.06 / 0.14 | 18.81 / 8.92 | 0.06 / 0.14 | 0.06 / 0.14 | 20.0 / 10.0 |
| item9 | 0.00 | 0.00 | **20.0** | 0.00 | 0.00 |
| item10 | 0.00 / 0.27 | 0.00 | 0.00 | 0.00 / 0.27 | 0.00 / 0.27 |
| item11 | 1.24 / 0.33 | 1.24 | 1.24 | 1.24 / 0.33 | 1.24 / 0.33 |
| item12 | **20.0** / 10.0 | 20.0 | 20.0 | 20.0 | 20.0 |
| item13 | 1.24 / **9.23** | 1.24 | 1.24 | 1.24 / 9.23 | 1.24 / 9.23 |
| item35 | 0.00 | 0.00 | 0.00 | **0.00** | 0.00 |

> **Rig pitfall, fixed.** The first run had `item1` at 0.77 / 20 mm / 8 "missing" flats — a *rig* lie,
> not a part fault. `sectionFlats` accepted runs ≥ 3 mm, and a sampled root fillet (r ≈ 12 mm at
> ~1.5 mm sampling) yields 3 mm chords with oblique normals, so the arcs were scored as stock
> faces. With `minLength = 8` item1's catalogue is 8 flats, **all 8 matched at ≤ 0.12 mm**. Any rig
> that reads sampled geometry as primitives must exclude chords: a flat is a run, an arc is not.

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
| item1 | 0.06 / 0.14° | 0.06 / 0.12 / **0.03** |
| item9 | 0.00 / 0.00° | 0.00 / 0.00 / 0.00 |
| item10 | 0.00 / 0.27° | 0.00 / 0.00 / **0.00** |
| item11 | 1.24 / 0.33° | 1.24 / 4.22 / **0.04** |
| item12 | **20.0** / 10.0° | **0.80** / 3.08 / **0.03** |
| item13 | 1.24 / 9.23° | 1.24 / 6.44 / **0.02** |
| item35 | 0.00 / 0.00° | 0.00 / 0.00 / 0.00 |

**Open:** items 11–13 still carry a 4–6 mm residual on *one* plane while the tilt is 0.02–0.04° and
the rest of the section is within ~1 mm. That is one face not where the catalogue puts it, not a
pose error — the next diagnostic is to print that flat's normal/offset (variant swaps were already
ruled out).

## How "floating in the middle of nowhere" happens

A seat is a rigid fit; "floating" is its **translation null space**. Two mechanisms produce it, and
this codebase has had both:

1. **Moment-based initialisation.** `baseSeat` and `recentre` centre the model on its **own bbox**.
   A part whose stock faces are cut away on one side (a longitudinal cope, a broken-out corner) has
   a smaller bbox than the stock, so centring shifts the whole part by half the missing material.
   The seat is then "correct" for the model's extent and wrong for the stock.
2. **Plane-to-plane fitting is translation-invariant along the planes.** Sliding a part parallel to
   a matched plane does not change that plane's residual. If the planes that would pin the sliding
   direction are missing or unmatched (a channel's faces, a coped region), the fit's Jacobian has a
   null space and the solver may drift through it freely — a perfect score on the faces it *has*,
   the part sitting off the stock.

That is why the acceptance rule and the candidate scoring matter: they compare *all* catalogue
flats, not just the current associations. A solver that only minimises its current residual cannot
see a null space.

## Literature — what applies to this problem

The problem is **model-based registration with a known template** (the catalogue section), in the
section plane, with outliers (cut faces, arcs, chamfers). Relevant methods, and how each maps here:

| method | idea | fit for us |
|---|---|---|
| **ICP / point-to-plane ICP** — Besl & McKay 1992; Chen & Medioni 1992 | iterate nearest-point correspondences, minimise plane distance | our solver; **local** convergence only — needs a decent pose and has a translation null space |
| **RANSAC** — Fischler & Bolles 1981; SAC-IA, Rusu et al. 2009 | sample a minimal correspondence set, count inliers | the right *global* guard: sample 2–3 catalogue flats, solve roll+translation, score. With only 8–12 flats, **enumerate instead of sample** (deterministic, no seed) |
| **Generalized Hough** — Ballard 1981 | vote pose parameters from feature correspondences | same enumeration, expressed as voting; a plane pair fixes roll, a third fixes translation |
| **4PCS / Super4PCS** — Aiger et al. 2008; Mellado et al. 2014 | congruent 4-point bases under rigid motion | strong for scan-to-model with no initial pose; heavy for a 2-D template |
| **PPF** — Drost et al. 2010 | hash point-pair features, vote | industrial bin-picking standard; a plane-pair feature is the analogue here |
| **TEASER / TEASER++** — Yang & Carlone 2019/2021 | certifiably optimal, decoupled rotation/translation, extreme outlier rejection | the modern answer to "bad initial pose + outliers"; overkill now, the right ceiling if we ever register free-form 3-D scans |
| **FGR / Go-ICP** — Zhou et al. 2016; Yang et al. 2016 | robust global optimisation; branch-and-bound | same role, more machinery than a 2-D template needs |
| **Chamfer / distance-transform matching** — Borgefors 1986; Liu et al. 2010 | rasterise the template, distance transform, search pose | natural for a 2-D section polygon; cheap and global |
| **3-2-1 datum locating** — ASME Y14.5 / fixture design | locate from a primary (3 DOF) + secondary (2) + tertiary (1) datum feature | exactly our stock planes; explains *which* planes should constrain which DOF, and why a channel's missing faces leave a DOF free |

**Recommended next batch (batch 4): exhaustive plane-pair RANSAC.** Enumerate compatible
(catalogue flat, model face) pairs, solve roll + translation per pair, score each hypothesis with
the existing rig by inlier count, keep the best, then ICP-polish. It is O(8 × 30) — microseconds —
removes the initial-pose dependence entirely, and directly closes the translation null space that
"floating" lives in. It also subsumes the quarter-turn search (a wrong stance simply scores no
inliers).

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
