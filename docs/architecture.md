# Architecture — overlay diff (manufactured vs STEP ideal)

Decision log for how we compute and render the **overcut / undercut** overlay: comparing the
manufactured (NC-reconstructed) solid against the STEP ideal. Read with `AGENTS.md`; the raw NC
facts live in `docs/nc1-dstv-format.md` and `docs/canonical-orientation.md`. Adjacent decisions on
the same job data are recorded here too — §18 explains why nesting cut progress cannot be derived
from `.ncexa` and must stay manual.

Status labels: **adopted** · **prototype** · **rejected** · **abandoned** · **open**.

---

## 1. The problem

The overlay must show, on the real part, where the manufactured model *disagrees* with the ideal:

- **overcut (red)** — `STEP − manufactured`: material the ideal keeps that the NC removed. Scrap.
- **undercut (blue)** — `manufactured − STEP`: leftover material the ideal lacks. Rework.

The manufactured model is **reconstructed** from the NC (`reconstructFromNc.ts`), not imported, so
it is an *approximation* of the same part the STEP describes. The two models share almost all of
their surface but never coincide exactly. Diffing two near-coincident solids is the whole problem.

Observed symptoms (reported by the operator): skin artifacts, volumes slightly smaller than they
should be, patchy red, and **missing undercut**. Example part: **m148** (`SHS100*100*6.0`, hollow,
L≈3966 mm, ≈8.95e6 mm³).

---

## 2. Constraints (do not re-litigate)

From `AGENTS.md`:

- Diff output feeds the shop; over/under must be legible and trustworthy, not pretty-but-wrong.
- The viewer must show **real** geometry (holes/curves), never simplified prisms.
- One NC + one STEP per stock beam; the job runs through WiseCAM regardless.

---

## 3. Experiment timeline (git)

| commit | experiment | verdict |
|---|---|---|
| `08e2dac` | Surface-distance flagging (`diffHighlight.ts`): flag triangles > tol from the other mesh | **Abandoned alone** — paints both sides of any offset face as a fake solid shell |
| `72ebf5d` | Real boolean, `three-bvh-csg` (`booleanDiff.ts`), over/under solids | **Prototype** — slivers + dropped coplanar faces |
| `b766738` | Component filter (`extractComponents`, `KEEP_SIZE/CLEAR/OPEN_SKIN`) | **Adopted** — hides CSG crumbs but also real sub-threshold diffs |
| `bde8632` | `probeDiffPresence` fast verdict before the full boolean | **Adopted** — speed only |
| `4db943e` | Remesh attempt (`KEEP_OPEN_SKIN` branch) | **Abandoned** — net −66 lines, didn't pay off |
| `f73ef49` | `diffAlpha` clearance gradation | **Adopted** — cosmetic |
| `71a2cbf` | `pruneThinSkin` + thinness-weighted Laplacian `smoothGeometry`; `manifoldDiff.ts` added | **Prototype** — smoothing "works for some, not all"; Manifold **never wired in** |

Net: today the diff is `three-bvh-csg` → component filter → thin-skin prune → Laplacian smooth →
prune again. Every step after the boolean treats the *symptom* in mesh space ("our smoothing
algorithm"), none removes the cause.

---

## 4. m148 investigation (this session)

Fixture: `test/fixtures/nw31-bottom/m148.{nc1,stp}` (see `test/fixtures/README.md`).
Harness: `src/lib/step/scratch-m148.test.ts` (renders panels with a small software rasterizer to
`test/.out/m148/{side,iso,end}.png` + `results.txt`). Reproduce:
`pnpm vitest run src/lib/step/scratch-m148.test.ts`.

### 4.1 What the ideal actually is

STEP surface census: `CIRCLE` radii **15 ×4, 9 ×4**; `CYLINDRICAL_SURFACE` **15 ×6, 9 ×6**. The
reconstruction builds `roundedRect(100,100,15)` outer / `roundedRect(88,88,9)` void — the section
**matches the ideal exactly** (same ±50 walls, same fillet radii). The disagreement is not the
section; it is the ends plus a sub-mm surface offset.

### 4.2 Surface separation (made ↔ ideal)

`diffHighlight.createMeshQuery` flag-shares (per-triangle, any vertex beyond tol):

| tol | made-far | step-far |
|---|---|---|
| 0.02 mm | 88.0 % | 98.5 % |
| 0.05 mm | 81.5 % | 96.1 % |
| 0.10 mm | 54.1 % | 69.1 % |
| 0.20 mm | 26.0 % | 37.9 % |
| 0.50 mm |  7.2 % | 20.0 % |
| 1.00 mm |  7.2 % | 20.0 % |

Made and ideal bboxes are **identical** (`[-0.1,-50,-50]..[3966.2,50,50]`). So the models are
aligned; they differ by a **0.05–0.5 mm shell over most of the part** (mean ≈0.05 mm), with a
localized worse region at one end (nothing sits between 0.5 and 1.0 mm).

### 4.3 Algorithms compared (rendered)

| panel | algorithm | over mm³ | under mm³ | verdict |
|---|---|---|---|---|
| A | current: three-bvh-csg + filter + prune + smooth | 23,716 | 9,355 | **broken** — undercut a tiny patch, over a speck. Reproduces the report |
| B | OCC B-rep `cut()` (no glue/fuzzy) | 10,147 | 39,179 | captures the shell, blotchy |
| — | `commonFace` glue only | 1.68e6 | 0 | **rejected** — no-op returning the whole ideal |
| — | glue + fuzzy 0.1 | 5.74e6 | — | **rejected** — garbage spikes |
| E | signed-distance **deviation map** | 3,790 | 327,471 | **adopted** → `deviationDiff.ts` (harness sums *all* deviations, no threshold) |

The root cause is now explicit: **the pipeline's `KEEP_CLEAR_MM = SKIN_MAX_THICKNESS_MM = 1 mm` bar
is coarser than the genuine 0.05–0.5 mm mismatch**, and `three-bvh-csg` mishandles the
near-coincident surfaces; so the filter/prune/smooth stack erases the real signal. No amount of
post-filtering fixes a boolean that was ill-conditioned at the source.

---

## 5. Research (what the field actually does)

Two distinct, well-established answers:

1. **Nominal-vs-actual comparison = signed-distance *deviation map***, not a boolean. This is the
   standard in metrology/inspection (Creo *Deviation Analysis*, Verisurf, GOM, Dragonfly "signed
   deviation map", pyvista `compute_implicit_distance`). You align, then colour each surface point
   by its signed distance to the other surface. Robust to near-coincidence because there is no
   surface intersection.
   - Robust sign: **generalized winding number** (Jacobson, Kavan, Sorkine-Hornung, SIGGRAPH 2013;
     "Fast and Exact Winding Numbers for Triangle Meshes", 2025) or the cheaper pseudo-normal
     signed distance (libigl `SIGNED_DISTANCE_TYPE_PSEUDONORMAL`).
2. **Robust booleans on near-coincident meshes** need **exact predicates + snap-rounding**
   (CGAL `corefine_and_compute_difference` + `apply_iterative_snap_rounding`; Barki et al. 2015;
   Cherchi et al., SIGGRAPH Asia 2022). Manifold's exact predicates do **not** solve it — see its
   open issue [#1706](https://github.com/elalish/manifold/issues/1706) "Boolean emits sliver tris
   on near-coincident inputs". CGAL is not browser-viable here; OCC's fuzzy boolean is the
   practical stand-in, and it works (panel B) but yields thin shells, not clean blobs.

---

## 6. Decision

**Adopt signed-distance deviation analysis as the diff — adopted and wired.** Implemented in
`src/lib/step/deviationDiff.ts` (`deviationDiff` / `cachedDeviationDiff`), unit-tested in
`deviationDiff.test.ts`, and called by `PartViewer.runDiff` in place of the `three-bvh-csg` boolean.
The red surface-flagging fallback remains for over-budget inputs. `booleanDiff.ts` stays as the
solid-boolean reference (and the source of the shared `BooleanDiff` shape); it is no longer on the
viewer's critical path.

- Rigid align (already done — `orientToReference` / seating).
- Per made vertex: nearest point on the ideal mesh + **signed** distance (pseudo-normal now;
  generalized winding number as the robustness upgrade).
- Colour the made surface by deviation (red = negative = overcut, blue = positive = undercut);
  threshold at a tolerance for bounded regions.
- **Volume** by divergence-theorem integration, `V ≈ Σ areaₜ · devₜ`, with the tolerance applied
  per triangle. Compare against the current legend volume for parity.
- Keep the OCC B-rep fuzzy cut (raw `BRepAlgoAPI_Cut` + `SetFuzzyValue`) as the route to a *true
  solid* over/under when a watertight body is needed. Do **not** use `commonFace` glue.

Why: it is the known, industry-standard method for exactly this task, it is inherently insensitive
to the near-coincidence that breaks every mesh boolean we tried, and it matches the required
semantics (+dev = leftover/undercut, −dev = overcut).

---

## 7. Did it live up to promise?

**Yes, for the reported problem** — the deviation map cleanly and smoothly surfaces the undercut that
the old pipeline reduced to a speck, with no slivers and no prune/smooth hacks. Production numbers
on m148: `over 0 mm³`, `under ≈235k mm³` (tolerance-gated at 0.15 mm; the scratch panel E summed
*all* deviations with no threshold, hence its larger 327k). That `over = 0` is the point: m148 has
**no** significant overcut — the model is uniformly a hair large, and the real defect is undercut,
which the `KEEP_CLEAR_MM = 1` filter used to erase. **Still to harden:**

- The closest-point index is a uniform grid with a bounded ring search (fine for the sub-mm,
  near-coincident case); a BVH would be the general fix.
- Sign is pseudo-normal (robust for watertight inputs); generalized winding number is the upgrade.
- Volume is a tolerance-gated **surface integral** (`Σ areaₜ · devₜ`), not a boolean volume — exact
  for thin shells, drifting for large offsets and convex corners.
- Tolerance (0.15 mm) and colour scale are fixed defaults; they need operator tuning per family.
- Not yet exercised on the full NW30/NW31 job set.

## 8. Upstream root cause (fix here too)

The reconstruction is the source of the sub-mm offset, independent of the diff algorithm:

- `stock.ts:281` — section fillets are **6-segment polylines**, not true arcs (≈0.13 mm sagitta on
  r=15). Build real arcs.
- `reconstructFromNc.ts:42` — `LASER_KERF = 0.2 mm` offsets the trimmed-axis surfaces by 0.1 mm.

Removing both brings made within <0.05 mm of ideal, after which any method — deviation map *or*
OCC boolean — gives a clean, small diff.

## 9. Follow-up: m116 / m12 / m122 and the deviation **volume** correction

The operator reported m116, m12, m122 still failing (large "skins", wrong volume). Diagnosis
(`scratch-nw31.test.ts`):

- **Calibration was not the problem.** A brute-force per-vertex min-distance equals the grid query
  on every part — the readings are real, not a query bug.
- **Volumes:** made vs ideal bbox is identical and volume matches to ~0.1 % on all four parts, so
  the models agree; the deviations are **localized**. Per-vertex median deviation is ~0 (m148 0.06,
  m116 0.00, m12 0.00, m122 0.08 mm) while p95 is 3–24 mm — i.e. a few features off by mm.
- **The "large skin" is presentation granularity.** m122 has only 384 triangles, so one stray
  vertex flags a whole 3966 mm face. The deviation map paints whole triangles.
- **The deviation *volume* is inflated 30–60×.** m122: deviation says over 2.9M / under 7.6M mm³,
  but the boolean says 81k / 106k. The pseudo-normal per-vertex distance reads the Euclidean gap to
  the nearest surface point — large at edges/gaps even when the material difference is tiny — so
  `Σ areaₜ·devₜ` overcounts. **Do not trust the deviation volume.**
- **m12 is a reconstruction failure** (OCC volume overlap **0.315** — no orientation aligns it);
  the boolean and voxel agree at ~0.8–1.1M mm³ each way. No diff algorithm fixes that.

## 10. Voxel diff — the current best

`src/lib/step/voxelDiff.ts` (+ `voxelDiff.test.ts`): rasterise each mesh's triangles into wall
cells, per-column scanline parity fill, diff occupancy, emit the boundary shell. Independent of the
input tessellation, bounded output, exact volume on the grid. Validated at **0.5 mm**
(`scratch-nw31.test.ts`):

| part | section | over mm³ | under mm³ | primary (true) | geom tris | time |
|---|---|---|---|---|---|---|
| m148 | SHS100×6 | 37,365 | 76,794 | 8.41M (8.37M) | 2.1M | 16 s |
| m116 | PFC100×50 | 2,633 | 5,906 | 3.00M (3.06M) | 0.3M | 5 s |
| m12 | PFC100×50 | 903,315 | 784,342 | 3.43M (2.97M) | 8M† | 12 s |
| m122 | SHS100×9 | 107,592 | 125,619 | 11.80M (11.77M) | 3.1M | 15 s |

† hit the 4M-triangle emit cap.

**Verdict:** the voxel volumes are the trustworthy ones — they agree with the OCC boolean (m122:
108k/126k vs 81k/106k), fix the boolean's under-reporting on m148 (voxel under 77k vs 9k) **and**
the deviation's 30–60× inflation. `primaryVolume` tracks the true volume to 0.2–0.5 % on the clean
parts (m12's +15 % is the broken reconstruction).

**Costs at 0.5 mm** (the blocker for wiring): ~0.12–0.33 G cells (≈0.3–1 GB per mesh), 5–16 s, and
2–8 M **blocky** triangles to render. Production needs, in order: **marching cubes** (compact
surface instead of blocky shells) → **GPU/WebGPU compute** voxelisation (kills the time/memory) →
LOD. On a 4 m shaft, 0.5 mm dense is inherently ~0.3 G cells, so CPU-dense will not ship.

**Wired, then superseded:** `PartViewer.runDiff` briefly called `cachedVoxelDiff`/`voxelDiff`
(0.5 mm). It was replaced by the fastest method (§12) — 0.5 mm dense is far too heavy for the viewer.
`voxelDiff.ts` stays as the ground-truth cross-check; `deviationDiff.ts` (inflated volume, §9) stays
as a module. Both are off the critical path.

## 11. Open questions

- Voxel as the production diff, and at what resolution (0.5 mm is accurate but 5–16 s / M-tris)?
- Marching cubes + decimation before wiring, or ship blocky at a coarser grid for speed?
- GPU (WebGPU compute) voxelisation — the only way to keep 0.5 mm on 4 m parts.
- m12's reconstruction/orientation (overlap 0.32) must be fixed regardless.
- Default tolerance and colour scale per part family (`resolveDiffTolerance` today).

## 12. Method comparison

Wired next (`manifoldDiff.ts` gained async `manifoldDiff`/`cachedManifoldDiff`; `PartViewer.runDiff`
now `async` and calls them). Same inputs, all four methods:

| part | three-bvh-csg | deviation | voxel 0.5 mm | **manifold** | manifold tris |
|---|---|---|---|---|---|
| m148 | 23.7k / 9.4k | 0 / 235k | 37.4k / 76.8k | **31.9k / 36.0k** | 3.3k |
| m116 | 0 / 4.0k | 0 / 274k | 2.6k / 5.9k | **1.5k / 4.8k** | 4.0k |
| m12 | 1.105M / 1.108M | 299k / 669k | 903k / 784k | **1.105M / 1.108M** | 3.5k |
| m122 | 81k / 106k | 2.9M / 7.6M | 108k / 126k | **100k / 114k** | 2.5k |

Manifold is exact-predicate (robust on the near-coincident surfaces), its volumes agree with the
voxel and boolean, and it yields a **compact** watertight solid — **2.5–4k triangles** vs the voxel's
2–3 M blocky ones, in well under a second. `primaryVolume` is the true solid volume. So:

- **Shipped: the fastest diff — the grid surface-distance probe at a fixed 1 mm margin.**
  `PartViewer.runDiff` (sync) runs `computeDiffMasks` through `diffHighlight`'s grid query (the same
  query the presence probe uses — no boolean, no kernel), with `DIFF_MARGIN_MM = 1`. Manufactured
  faces beyond the margin render blue (undercut); ideal faces red (overcut). The margin absorbs the
  ~0.05 mm reconstruction offset and tessellation noise, so sub-margin surfaces never read as a skin.
  It is the fastest of every method tried and needs no new dependency (the in-repo query is the
  BVH-equivalent).
- Runner-up: Manifold is exact and compact (2.5–4k tris) but its thin near-coincident shells cover
  the whole part → "huge surface artifacts"; a boolean is the wrong tool for this *presentation*.
  `booleanDiff` (three-bvh-csg), `deviationDiff` (inflated volume, §9) and `voxelDiff` (ground-truth
  cross-check, slow) remain modules, off the critical path.
- The "strange line artifacts" were `EdgesGeometry` outlining every voxel cube in the blocky shell —
  the edge pass is off for the solid shells.

## 13. Margin effect (and why some parts stay large)

`deviationDiff` at a 1 mm margin (mean per triangle), flagged triangles / total:

| part | @0.15 mm | **@1 mm** | where the >2 mm verts are |
|---|---|---|---|
| m148 | 97/416 | **30/416 (7%)** | 100% ends |
| m116 | 158/820 | **106/820 (13%)** | void 36 + outer 36 |
| m12 | 308/820 | **220/820 (27%)** | ends 72 + void 60 + outer 60 |
| m122 | 237/384 | **162/384 (42%)** | 100% ends (240 verts, up to 11.8 mm) |

The margin collapses m148/m116 to the real features. m122/m12 stay large because their manufactured
models genuinely differ by 1–2 mm over much of the surface **plus** the ends — no margin below ~2 mm
hides that, and above it the real features vanish. The root cause remains §8: `reconstructFromNc`'s
end/mitre path (m148/m122 are clean, isolated cases) and the PFC section/mid-span (m116/m12). Fix
those and the diff — at any margin — snaps clean.

## 14. OCC fuzzy boolean — stabilised

`occDiff.ts` (`occFuzzyDiff`): import both STEPs, seat them by the viewer matrices
(`BRepBuilderAPI_Transform` + `gp_Trsf`), `BRepAlgoAPI_Cut` both ways, mesh the results. Wired into
`PartViewer.runDiff` (async, probe as fallback).

**The instability was a real bug, not the kernel:** `BRepAlgoAPI_Cut` **mutates its arguments by
default**, so reusing `made`/`ideal` across the second cut (and the fuzzy retries) corrupted them
and the result went non-deterministic (over/under ≈ the whole operand). Fix:
`op.SetNonDestructive(true)`. After that the same inputs give the same sane result every time.

The fuzzy value is still non-monotonic, so `occFuzzyDiff` scans a candidate set largest-first and
takes the first whose volumes validate. The validation is three-part: the cut must be strictly
smaller than the operand it came from (`over < ideal · 0.99`, `under < manufactured · 0.99`); it must
not be a **paper-thin membrane** (`impliedThickness = 2·V/A ≥ MIN_SOLID_THICKNESS_MM`, 0.5 mm); **and**
it must agree (within 5 %) with the over/under derived from the **common volume taken at the same
fuzzy** — `over = ideal − common`, `under = manufactured − common`. Taking the common at the cut's
own fuzzy makes the sub-mm reconstruction offset count as coincident, so a matching part's expected
diff is ≈ 0 rather than a thin shell over its whole surface (the "long stretches of skin"), while a
merge (≈ the whole operand) still fails to agree and is rejected. `a2` (EA75×75×6) used to report
≈96 %/95 % despite a 99.95 % material overlap; it now reads 0 %/0 %, guarded by
`occDiff.overgrown.test.ts`. Results after the fixes:

| part | auto fuzzy | over mm³ | under mm³ | tris |
|---|---|---|---|---|
| m148 | 1.0 | 17,028 | 27,768 | 428 |
| m116 | 1.0 | 0 | 4,028 | 360 |
| m12 | 0.5 | 1,105,671 | 2,036,537 | 1,472 |
| m122 | 0.5 | 54,554 | 98,476 | 1,040 |

The thickness gate is what the volume checks alone could not catch: **m180** cut cleanly by volume at
the largest fuzzy (1 mm) but to a ~0.035 mm, whole-part shell — 391,000 mm² of surface for only
6,900 mm³ — because a membrane has negligible volume. The gate makes the scan skip `f = 1/0.5/0.3`
for `f = 0.2`, which agrees with the independent surface probe (over ≈ 13,773 vs 13,745 mm³) and
leaves real material; guarded by `occDiff.skin.test.ts` (m180 fixture).

All sane and compact (hundreds–1.5k tris), and m122 agrees with the boolean/voxel (~100k). `m12`
stays large — its broken reconstruction (§9). So this is the "good when it works" result made
reliable: the kernel uses the largest fuzzy it can handle and falls back to the probe otherwise.

## 15. Diff in the OCC worker (eager, all three panes ready)

The boolean used to run on the main thread inside `PartViewer.mountScene` (deferred one frame), so
the overlay pane filled in seconds after the STEP and manufactured panes. It now runs in the shared
OCC worker pool as a `diff` task (`stepWorker.ts`, `occFuzzyDiff` + `serializeDiff`), so it never
blocks the UI and can be prewarmed.

- **The view's seating, never its own.** The NC pipeline is independent of the STEP, so the two are
  built in different frames — but the *viewer* already seats both in the section's canonical frame
  (`seat.ts` `seatedPair`). `diffForViewer` (`viewerModel.ts`) meshes the two and passes the worker
  the relative transform that maps the STEP's raw frame onto the manufactured frame
  (`relativeSeat`); `occFuzzyDiff` then cuts with `compareMatrix` and the result is parented to the
  seated primary group. The worker no longer runs `alignToReference` — the diff cannot pick a flip
  that disagrees with what is drawn. `diffForViewer` memoises on the two byte objects *and the
  profile* (weak, so it self-clears), and the boolean result crosses the thread as plain typed
  arrays (`DiffPayload`), since `BufferGeometry` is not cloneable.
- **Eager.** `PreflightPage` kicks the diff off as soon as the viewed part's manufactured bytes
  land (foreground) and for each ±1 neighbour after its rebuild (neighbour priority), so opening a
  part draws all three panes from cache rather than computing the diff on view.
- **Background analysis yields to navigation.** The pool is only `min(3, cores-1)` workers (one on a
  2-core machine) and priority reorders the *queue* but cannot preempt an *in-flight* task, so a warm
  viewer request could still wait behind a multi-second background rebuild. `StepWorkerPool` gained
  `pauseBackground`/`resumeBackground` (`stepPool.ts`): while a part is open, queued background
  (analysis + warm) tasks are **held** — kept pending, not failed — so the workers serve the viewer
  and its neighbour prefetch; they resume a settle interval after the part's manufactured model
  lands. In-flight tasks still finish (unstoppable), but the pile-up ahead of the viewer is cleared.


## 16. STEP → IR cut-line projection — m71 post-mortem

Status: **adopted**. Read before changing `src/lib/step/cutProjection.ts`,
`src/lib/wisecam/surface.ts`, or `src/lib/part/fromStep.ts`.

Symptom: the 3-D STEP cut lines looked correct, but the STEP **IR** did not match the NC IR
(missing slot arcs, duplicated hole rims, minor lines inside holes). NC was correct for m71
(NW30 Bottom, PFC100*50 with a bevel), so m71 is now a strict cut-line regression.

### What went wrong

1. **Two projection implementations existed.** The 3-D viewer used
   `projectCutEdgesToFaces` (the cut-plane trace on the nominal face, reaching the theoretical
   sharp corner). The IR used a second `preserveRim` path that kept the real B-rep rim X instead.
   They diverged; the IR could be wrong while 3-D looked right.
2. **The "round-trip" test hid the divergence.** It projected the IR back with the *same* IR
   variant, so it passed while the IR disagreed with the viewer/NC. A round-trip must compare
   against the *original* projection, not a second copy of the same transform.
3. **Cylinders were classified by `face.normal`.** For a cylinder that is one representative
   radial normal. A hole/slot wall is a cylinder **crosswise** to the member (a cut); a rounded
   stock corner is a cylinder **parallel** to the member (stock). Using the radial normal
   misclassified walls and silently dropped their rim arcs.
4. **Through holes/slots have two B-rep rims.** NC authors one machined line (the entry side).
   Emitting both looked duplicated: m71 had 8 holes and 8 slots instead of 4 + 4.
5. **Closed rims were emitted as `cut`.** Holes/slots need their own IR kinds, and the extra
   straight/interior fragments left over from the rim were drawn as minor lines inside the hole.
6. **Tests only compared end cuts.** They did not assert hole/slot kinds, counts, or that no cut
   fragment lay inside a hole/slot.

### Rules (do not re-litigate)

- **One projection only.** 3-D and IR both use `projectCutEdgesToFaces`. Do not add an IR-only
  rim variant. The cut-plane trace is intentional (sharp-corner NC convention).
- **Stock/cut classification uses `isStockFace`** (surface on the section outline), not a
  normal-angle threshold: a shallow bevel (m137/m176) otherwise reads as stock and its end line
  disappears. For open sections (`includeInner`), every lengthwise face is stock; the transverse
  test (`|dot(cutFace.normal, member)| > 0.05`) still rejects long inner-face stock edges.
- **Cylinder stock test uses the axis:** `|dot(cylinder.axis, memberAxis)| > 0.9` = lengthwise
  (rounded stock corner); otherwise it is a hole/slot wall (cut). Planar stock still uses
  `|dot(face.normal, memberAxis)| <= 0.3`.
- **Outer skin is an edge test:** classify a stock face by its normal/axis, then test each edge
  **midpoint** against the section outline. Do not require the face's samples to fit the outline;
  real PFC/web faces miss it.
- **Through-rim collapse is geometric.** Keep the rim on the stock face where
  `dot(face outward normal, cutCylinder.center − sectionCentroid) > 0` — the nearest outer face.
  This reproduces m71 (`u` for Ø14 holes, `o` for Ø10 slots) without reading NC.
- **Classify closed rims as holes/slots**, then drop any cut run wholly inside one. Do not leave
  rim/wall duplicates as cuts. Better: take holes/slots from the BREP **cylinder metadata**
  (`cylinderFeatures`): a closed-rim cylinder is a hole, two open half-cylinders one diameter apart
  are a slot. Intersect the cylinder **axis with the entry face plane** for the centre; do not use
  the mid-wall centre. Unpaired open cylinders are rounded cuts, not holes. This is what stopped
  PFC holes from disappearing when rim chaining failed.
- **Stock-face fit:** before mapping, fit a scale-1 rigid transform from the large planar stock
  faces onto the spec section planes (signed normals + offsets, translation along the member
  unconstrained/regularised). This removes the ~0.97° seating tilt without using hole centres.
  Re-run until the residual is negligible; if it cannot converge, the STEP is not a straight
  prismatic member.
- **The seat itself comes from the stock faces, not the vertex cloud** (`seat.ts`
  `stockFrameOf` / `seatFromStockFaces`). A stock face's normal *is* a section axis, and two  perpendicular normals span the cross, so `u × v` is the member direction. PCA over the meshed
  vertices mixes in cut faces and uneven tessellation: on the real `UB250*31` (`test/fixtures/ub`)
  it tilted the member 0.14°, which read as **12.8 mm of false depth** over 5.3 m and hid a real
  hole-position match (`raw-step-holes` m137 canary). The stock-face seat reproduces the raw
  `5309 × 252 × 146` bbox exactly. Apply it only as a **de-tilt**: a frame more than 10° from the
  heuristic seat means a cut face was mistaken for stock, so the heuristic seat is kept.
  Technique batches, scores and the traps that cost a debugging round each:
  **`docs/seat-alignment.md`**.
- **One transform per face:** `faceStation(face, point, …)` is the inverse of `placeNcFace` and is
  the only station formula. Holes, slots and cut segments all call it; never duplicate the
  half-span/across-sign maths in a second path.
- **Face-region mapping:** identify the target face once per segment and map every point through
  that face. Do **not** clamp or clip the authored coordinate or station; let the cut continue with
  the mapping. **Closed tubes (`M`) may split/wrap at the seam. Open sections (`U`/PFC) must not
  wrap** — the cut continues and may overrun the nominal chart edge. The SVG renderer draws IR
  coordinates exactly; it does not offset faces.
- **Touching segments:** adjacent projected samples of the same cut are chained only when their
  endpoints are within 0.05 mm. No bridging/connectors; this removes the tiny unenclosed fragments
  without inventing lines.
- **Length preservation:** the sum of IR cut lengths for an open section must equal the sum of the
  projected cut lengths (excluding hole/slot rims); `cut-lengths.test.ts` enforces this.
- **End cuts must be continuous.** Per-face chaining leaves breaks at face boundaries. Merge cut
  runs whose endpoints meet (up to 5 mm) before emitting IR features. For open sections (`U`),
  include the channel-side faces in the projection (`includeInner`); the outer-outline-only test
  drops half the PFC end cut.
- **Cut-face outer wires:** after the stock-face walk, walk non-stock planar face outer wires.
  Deduplicate by the **source B-rep edge key** first (the same edge projected on another face),
  then include only uncovered short beam-collinear closure edges. This catches the closure edge
  without a second overlapping line.
- **Open-section STEP IR uses the same `brepCutSegments` targets as the 3-D viewer**
  (`CUT_FACES`/`faceNormalSigns`), never `targetNormals = null`. Null targets include additional
  stock faces and produce IR cut lines the projection does not draw.
- **Open-section STEP IR is generated from `brepCutSegments`** — the same projected 3-D
  segments the viewer draws — not from a second `developStepCutEdges` detection. Carry each
  segment's projected stock-face **normal and centre**, identify that manufacturing face once
  (normal + exact plane offset), then map every point through that one DSTV face. Do not re-classify
  or re-project per point.
- **Direct BREP wire development was tried and rejected** for tubes: mapping raw wire points to
  the nearest DSTV plane mis-stations rounded corners. Keep the cut-plane projection plus run
  merging; do not reintroduce a second wire-to-face mapping without a tube-corner regression.
- **Pipelines stay independent.** STEP never reads NC. Only the explicit NC → STEP path shares
  code. Do not use NC face letters to choose a STEP rim.
- NC outer contours include stock edges; STEP IR only has cut rims. Compare **end cuts** and
  hole/slot geometry, not raw cut-feature counts.

### App wiring (pipeline independence)

`PreflightPage` builds STEP IR only from STEP/drawing data:

- `sectionGuesses` (STEP section detector) → catalogue section,
- `stepLengths` (STEP bounding-box length),
- the detector/drawing profile and dims.

It must **not** read `part.nc`, `viewing.nc`, `viewingNcSection`, `viewingDims`, or the NC-derived
stock fallback. Because section detection used to run only for STEP-only parts, it now runs for
every STEP part (`detectSection: true`); otherwise an NC-bearing part would have no independent
section and the STEP IR would silently fall back to NC. The cost is a STEP section read per part;
that is the price of a genuinely independent STEP pipeline.

The STEP 3-D pane follows the same rule: `stepViewerStock`, `stepFaceFrame`, `stepCutEdgeOptions`,
`stepSeat` and the STEP IR all come from the STEP detector/catalogue section. The STEP pane does
not receive NC marks or an NC-reconstructed alignment reference. The manufactured and diff panes
still use NC geometry by definition.

If the background detector map has not populated yet, the STEP IR effect reads the section
directly from the STEP bytes (`detectStepSection`). It does **not** wait for NC or fall back to an
NC section; that fallback is what made the STEP surface disappear ("No NC or STEP surface").

The STEP detector returns `dims: []` for PFC/RHS/SHS because the code alone carries the size.
`unrolledLayout` still needs dimension fields, so `layoutDimensions(code, dims, section)` fills them
from the catalogue/measured section before building the IR. Do not pass `guess.dims` straight to
`unrolledLayout`.

### Transform spec (target, adopted)

The STEP → IR conversion has exactly **two** surface transforms. Do not add a third or duplicate
them per feature.

1. **Flat → flat (isometry).** A planar stock face maps to its flat IR interval with **scale 1**:
   distances are preserved. With a unit face-span direction and signed local coordinate
   `u = dot(point - faceOrigin, spanDir)`,
   `station = faceStart + (reversed ? width - u : u)`.
   Do not normalise by face width, and do not apply a per-face tolerance or clamp.
2. **Cylinder → flat (arc unroll).** A cylindrical stock face maps by **arc length**:
   `station = faceStart + radius * (theta - theta0)`, signed by the face orientation. The angle is
   measured around the stock cylinder's axis from the face's start tangent. Never use the chord
   or a flat projection as a substitute.

These intervals concatenate into **one global UV station** (millimetres of developed perimeter),
which is the IR chart. Every feature is just coordinates on that surface:

- Holes/slots: cylinder-axis ∩ entry plane gives the centre; radius is exact; the face transform
  maps the centre and ends.
- End cuts/notches: use the projected cut segments from the viewer extraction. Identify the
  **manufacturing face once** per segment (normal + exact plane offset), then apply that face's
  transform to every point. If a segment crosses a face boundary, split it at the boundary; never
  re-guess a face per point and never clamp an out-of-range station.
- Holes, slots, cuts and future marks all call the **same** `faceStation`/face-transform function.

### Face junctions (corners)

A cut line that crosses from one face to the next must meet at the **exact shared junction**:

- The junction station is the cumulative section arc length where the two section edges meet.
- A segment crossing a junction is split there; both adjacent face segments use that same station.
- A corner must sit exactly on the IR line between the two face intervals; no tolerance snap, gap
  or overlap.
- **Obtuse corners:** never compute a junction by interpolating UV endpoints. A small station
  error becomes a large along-direction gap when the cut is very obtuse. Intersect the cut face
  plane with the section junction line (or the 3-D cut segment with the face-boundary plane) to get
  the exact along, then apply the face transform.
- Holes/slots and cuts use the same section-derived junction, so they cannot disagree.

Invariants:

- **One transform per face.** No second station formula may exist.
- **Face intervals tile the seam** without gaps or overlap. Stations must lie in
  `[-seam/2, +seam/2]`; a run crossing the seam is split, not clamped.
- **Parallel faces are distinct.** Identify them by normal **and** exact plane offset; a shared
  normal alone is ambiguous (outer vs inner flange/web).
- **STEP is independent of NC.** Runtime inputs are STEP geometry + STEP-detected profile/dims/
  section + STEP-read length. NC may appear only in tests as an oracle. STEP IR must remain able
  to feed NCEP with no NC present.

Current status: the flat transform is implemented. The cylinder/arc transform is the target and
still needs to be wired for rounded stock faces.

### Guarding tests

| test | what it locks |
|---|---|
| `toNc.test.ts` | NC → IR → NC exact (`1e-9`) |
| `fromStep.test.ts` m71 end cuts | STEP end cuts match NC `startCut`/`endCut` (mean <1 mm, max <4 mm) |
| `fromStep.test.ts` m71 cut-line round trip | STEP → IR → face projection returns the same lines |
| `fromStep.test.ts` m71 holes/slots | 4 holes + 4 slots, same centres/radii as NC; no cut point on/inside a hole/slot |
| `face-distance.test.ts` | Every face's mapped span equals its spec developed length (flat width, rounded arc length) |
| `detected-section.test.ts` | STEP-detected flange/web extents and arc-inclusive area match the theoretical section spec |
| `raw-step-holes.test.ts` | Canary: raw STEP cylinder centres vs NC hole along/cross positions (known failures on non-prismatic m137) |
| `cutProjection.test.ts` / `ncStepAgreement.test.ts` | NC vs STEP face projection stays aligned |

Run: `pnpm vitest run src/lib/part/fromStep.test.ts src/lib/step/cutProjection.test.ts`.

### STEP IR closure attempts — rejected (do not repeat)

| attempt | outcome | reason |
|---|---|---|
| Clamp station to `±seam/2` | rejected | hides mapping errors; clipping |
| UV clipping to face interval | rejected | same; architecture forbids clipping |
| Seam-wrap/split for PFC | rejected | PFC is open; wrapping is clipping (valid only for closed tubes) |
| Merge all projected runs (5 mm) | rejected | invented horizontal connectors absent from projection |
| All cut-face outer-wire edges | rejected | duplicated lines + quadratic lag |
| Short beam-collinear cut-face edge | exposed the closure edge but added duplicates | filter incomplete |
| Cut-face edge + 0.75 mm coverage dedupe | rejected | still left duplicate/closure issue |
| Beam-collinear edge + inset >2 mm from outline | rejected | excluded the target edge (it is within 2 mm of the outline) |
| Simple straight-line endpoint connector | rejected | fills rather than detects |
| Global ICP point fit | rejected | 2.74 mm residual; non-rigid correspondence |
| Stock-face plane rigid fit | **adopted** | fixed the 0.97° seating tilt; flange back to 50 mm |
| Cut-face edge dedupe by raw edge key | insufficient | duplicate/closure persisted |
| Measured face-width labels from wire bbox | removed | 53.8 mm was the slanted-edge artifact, not flange width |
| Separate per-pane SVG viewBox | rejected | rescaled panes differently; use one union viewBox |

### Layer debugging (work top-down, do not skip)

Debug STEP cuts as explicit layers, and record which layer a known edge reaches:

| layer | question | m137 closure edge status |
|---|---|---|
| 0 raw BREP | is the edge in `seated.faces[].wires[].edges`? | **yes** — 8.52 mm, along 33.9 / 40.9, outline distance 0 |
| 1 stock/cut candidate | does a stock face border a non-stock face? | **yes** — stock face, neighbour non-stock |
| 2 transverse/beam filter | is it transverse, or an admitted beam-collinear closure? | fails transverse; passes short beam rule (8.52 mm) |
| 3 target face set | is the owning face in `targetIndices`? | **fails for `v`** — the nearest edge is on the PFC `v` face, which `CUT_FACES.channel` excludes |
| 4 projection | does the edge map to a valid station/along? | not yet traced |
| 5 emission | is the edge key present before merge/final IR? | not yet traced |

A layer is “passed” only when the edge key is still present; visual presence alone is not proof.

Layer 3 result (m137): including `v` raises cut count 2→6 but does **not** close the gap. The missing
NC points remain ~3 mm from a short **diagonal** edge on `v`.

Layer 4 result: the nearest BREP edge is a **7.94 mm diagonal** on `v`, mapping
`[35.3, 30.9] → [27.5, 32.4]`. The NC points `[32.3, 30.3] → [32.3, 28.1]` are a **2.2 mm vertical
jog** with no corresponding BREP edge. The STEP edge bridges diagonally. This is an NC-vs-STEP
contour difference, not a detection filter.

Open issue: the remaining PFC end-closure edge lives on/near the stock outline (within 2 mm) and is
not classified by stock face, transverse neighbour, outline distance, or cut-face wire rules.

Edge-register result (m137): the short beam edges are **8.52 mm**, on stock/cut faces at along
**33.9 / 40.9**, distance 0 from the stock outline. The NC end-contour points are at along
**28.1 / 30.3**. They are not the same edge — a 3–5 mm offset.

Bevel check: those short closure segments report **bevel 0** (square) and thickness 6.7 mm, so this
is **not** the NC root-line/bevel shift. NC `startCut` is a complex multi-station start contour
(`along` up to ~42), not a single root line.

Next candidate (not yet tried): project the short edge through its **cut face plane trace** onto
the target face, as `projectToNearest` does for non-planar stock faces, instead of using the raw
rim points. If the start cut is a shallow planar bevel, that trace reaches the NC outer line.

## 17. Stock alignment (seating) — what was measured

Companion file: **`docs/seat-alignment.md`** (full batch history, score tables, traps). This section
is the summary and the decision record.

### The problem and the rig

Operator complaints on J12095: item1 "floating in the middle of nowhere", item11 "quite bad",
item12 "still lopsided", item10 "decent". The old seat scored *containment* of the vertex cloud in
the catalogue polygon — which cannot see placement or roll at all.

The rig (`seatFit.ts`) scores a pose on **stock planes**: the catalogue section is read as flats
(maximal collinear runs, outward normals), the seated model as planar faces in the section frame
(`u = −world Z`, `v = +world Y`), each catalogue flat matches the nearest model face with the same
normal, and the score is **length-weighted offset error (mm)** plus **normal error (tilt, °)**.
Offset is placement; tilt is rotation. `item13` scored offset 0.00 with a 9.23° roll — the old rig
would have called it perfect.

### Batches (all measured, see the companion for tables)

1. **Screen.** PCA / boundary-weighted faces / area-weighted faces / quarter-turn search / corner
   matching. Edge-and-corner matching (the operator's hunch) lost badly on real parts (19.9 mm on a
   PFC): cuts and chamfers interrupt the corner lines, so a 4-point fit over-constrains. Boundary
   weighting flipped an open section. Quarter-turn search cannot fix a continuous roll.
2. **Iterate.** Stock-face frame + damped section-plane ICP: item12 20 mm → 0.80 mm, item13
   9.23° → 1.38°.
3. **Refine.** Robust refit on the residual majority: tilt → 0.02°. The residual 1.2 mm offset was
   then proved to be **geometry** (a planed flange, 4.2–6.4 mm removed), not pose.
4. **Globalise.** Exhaustive **plane-pair RANSAC**: a plane gives one equation, so two planes with
   independent normals fix roll and both translations. Enumerated, not sampled (8 flats, a few
   hundred hypotheses). From a 25° broken start it recovers every part where ICP is trapped at
   20 mm; start-pose invariant to < 1e-3 mm.

**Decision: the seat is RANSAC only.** A stock-face **axis** stage stays because a RANSAC
hypothesis only rolls/translates *within* the section plane — the member direction still comes from
`u × v` of two perpendicular stock normals (a real UB's PCA axis was 0.14° off = 12.8 mm over
5.3 m). Both are proposals; the better score wins; below three agreeing planes the seat declines and
the caller keeps its pose. ICP remains in `seatFit.ts` for later exploration but is **not** run.

Measured justification: across all 36 J12095 parts, RANSAC alone gives mean offset **0.184 mm**,
mean tilt **0.000°**; adding a tight-gate ICP leaves the offset identical and the tilt at 0.003° —
it improved **0 of 36** parts. A plane pair is already the exact solution.

### CAD-grade refinement suggestions — benchmarked

A "best refinement pipeline for STEP files" suggestion proposed (a) sampling points with analytical
normals, (b) robust (Tukey/Cauchy) point-to-plane ICP at a 0.01–0.1 mm radius, (c) zero-sampling
B-Rep feature/datum matching. Measured on 8 real parts:

| claim | result |
|---|---|
| sampling with analytical normals beats mesh/vertex data | **moot here:** a plane fitted to the CAD boundary points reproduces the analytic plane to **0.000° / 0.000 mm**. Ours are analytic already (and the real bug was Tekla reporting flats as B-splines — fixed by geometric planarity in `mesh.ts`) |
| reject outliers (their tight radius) | **confirmed:** with no rejection, a 2° rough pose "converges" to **2.53° / 2.09°** of tilt on items 11/13 |
| an M-estimator beats a hard gate | **not on this data:** Tukey (c = 0.05) is bit-identical to a 0.05 mm hard gate; Tukey (c = 0.5) wins item1 (0.03° vs 0.51°) but loses M_12 (0.14° vs 0.00°). Neither dominates — "try both, keep the better" (the proposal stack) is the only rule that does |
| refinement reaches machine precision | **no:** from a 2° rough pose the best refinement still leaves item1 at 0.03° and M_12 at 0.00°, i.e. it can only repair a pose that a global stage already found. RANSAC's own score is 0.000° because it *solves* the planes instead of minimising residuals |
| zero-sampling B-Rep matching | **that is what we do** — the plane-pair solve is analytic; there is no cloud involved |

### What is still open

- **Cylindrical stock (CHS) has no plane path.** Measured: `CHS508*9.5` → model flats **0**,
  catalogue "flats" **48** (chords of the sampled circle), `seatFromStockFaces` **declines**. Round
  tube needs cylinder features (axis + radius from the existing `face.cylinder`), matched to the
  catalogue OD/ID — two coaxial cylinders plus one end plane fix a full 3-D pose analytically.
  The chord-as-flat artifact is the same one that once scored item1's root fillets as stock planes;
  any surface read as flats needs a curvature test, not just a length threshold.
- **A full 3-D three-plane hypothesis** would replace the pair + axis split and drop the 10° axis
  guard. Today the axis is a separate candidate because a plane pair is 2-D.
- **The score is catalogue → model**, so a plane the part genuinely lacks (the planed flange) is
  charged as a 20 mm miss. The alignment-honest direction is **model → catalogue**; the reverse is
  an audit ("stock removed"), not a seat score.
- **Confidence is not surfaced.** Inlier fraction (8/8 vs 5/8) is the honest quality metric and
  should be shown, since the residual offset no longer can be (it is geometry).

### Invariants (do not re-learn these)

- Section frame is `u = −world Z`, `v = +world Y`. `sectionRotationMatrix(δ)` rotates section
  coordinates by **+δ**; `makeRotationX(−δ)` reads as the opposite rotation. Verify any new
  transform with a world-space round trip (getting this wrong scored **zero inliers on every
  part**).
- Never sort a cut/hypothesis by station to build a polygon — a notch's step becomes a crossing.
- Re-centring keeps the existing translation: new translation = `position − centre`, not `−centre`.
- A flat is a *run*, an arc is not: sampled fillet/circle chords must not be read as stock planes.
- ICP's residual is translation-invariant along matched planes — never let a local stage decide a
  pose on its own.

## 18. Nesting cut progress — the plan is not the log

Status: **adopted**. Read before changing the `cut / planned` control in the Nesting coverage card
(`NestingFileTree.tsx`, `nestSummary.ts`, `nestCuts`).

**Question.** The per-file `14/14` is a typed `cut / planned` pair. Can it become a read-only
progress readout (1 of 2 bars cut → `1/2`)?

**Answer: no — no file the app reads records how many bars were cut.** Evidence from 129 real
`.ncexa`/`.ncex` packages on disk (Nov 2026):

- `<Result params>` carries `Utilization / Count / PartInfo / HeadLength / TailLength /
  ResultName`, and — only in the newer **straight** kernel (`identifier 2.0.0.0`,
  `cnc_laserzua 6.956.20.0`) — `Processed=0`. 21 results across 8 packages carry it; **every value
  is `0`**. The **bevel** kernel (`2.0.0.1`, `6.953.9.3`) omits the key entirely.
- `NW30 TOP.ncexa` (project export, *not* used for CAM): 11 results / 15 bars, `Processed=0` on
  all. Its per-beam CAM exports (`排样1–11`) carry **no** `Processed`; the `Nesting/` per-beam set
  carries `Processed=0`.
- Other candidates are all dead ends: `Result count="2"` is constant (not a quantity),
  `BaseZone count="0"`, `Part.TotalCount`/`NestedCount` are required/nested (plan, not cut), the
  CNC side (`PlateN.xml`) only has `from`/`count` (toolpath segments) and `IsCutPoint`,
  `PlateN-1.zua` is pure toolpath, and `CustomizeData.xml` is empty.

**Where the truth lives: NcStudio counts on the controller, not in the exchange file**
(`docs/manuals/weihong-fa30a-zh-r20260430.md`):

| mechanism | manual | record |
|---|---|---|
| 灵活加工 加工次数 | §3.6.1 | how many times to run one toolpath |
| 批量加工 queue | §3.6.2 | per-drawing 次数 + state; saved as `TaskListInfo.tld` in `<install>\Tocs\MultiTask`; **重置** clears to 等待加工; **另存为** exports it |
| 循环加工 完成次数 | §3.6.3 | completed cycles |
| 运行报告 | §3.7.2 | per item 循环加工次数, exportable as PDF |
| 日志 | §3.8 | `NcStudio_xxxx.log` run history |

So `j12095` can be cut more times than it is nested: the operator re-runs a per-beam drawing
(加工次数 / 循环加工), and only the controller sees it. The `.ncexa` stays the plan.

**Consequences (do not re-litigate):**

- **Keep the manual cut amount.** The typed `cut / planned` is the only record the app can hold;
  it is a log of reality, not a derived readout. Removing it or freezing it read-only loses the
  only signal.
- **Do not read `Processed` as progress.** `0` is indistinguishable from "never marked", and no
  real export has ever shown `1`.
- **Future source:** import `TaskListInfo.tld` (needs one sample to reverse-engineer) or a run
  report PDF. Note the `.tld` is a single, overwritten file for the *current* queue, so history
  beyond the current batch has to come from the reports/logs.
- See `docs/ncexa-nest-check.md` for the quantity model (`PartInfo × Count`, deduped results).

## 19. Nesting coverage — sections, one-result nestings, persisted state

Status: **adopted**. Files: `NestingAnalysis.tsx`, `NestingFileTree.tsx`, `nestProfile.ts`,
`nestSummary.ts`, `lib/projects/store.ts`.

**Vocabulary: section, not profile.** The UI says **Section** for a steel cross-section
designation (`200UB29.8`, `RHS150*100*9.0`); "profile" is ambiguous (drawn shape vs manufacturing
profile) and the code already says `section` (`sections/`, `sectionLabel`). The old Profiles card,
parts column and settings now read Section(s). Chinese stays 型材.

**One `<Result>` = one machine nesting.** A per-beam CAM nesting is structurally one stock-bar
layout: exactly one `Result`. The WiseCAM project snapshot aggregates every layout (`NW30
TOP.ncexa` has 11 Results, each also exported per beam), so packages whose `results.length !== 1`
are not nestings and are excluded. Zero-result CAD/library exports are excluded too.

**Quantity comes from the package, never the filename.** `plannedByFile = Σ Result.copies`;
`summarizeNests` uses `PartInfo × Count`; duplicated results are counted once by `idref`. Real
filenames can be stale (`…11x12.ncexa` with `Count=9`) and are ignored. The only filename quantity
in the app is the STEP-only part fallback in the audit.

**Section label is resolved from what the nesting places,** because the folder label is not
reliable (`PFC 150` holds PFC100*50; root/`新建文件夹` packages are Unknown). Match the placed part
names to project marks, take the dominant section key, and label it with the parts-table section
code first, a known folder label second, and a family + nominal-number fallback last. The section's
parts are then all parts of those section keys, so missing marks stay visible.

**Persisted per project** (small meta writes, preserved by `putProjectFiles`):
`nestSelection` (absent = all ticked; selecting everything stores `null` so later nestings stay
ticked), `nestCuts`, `nestNameRule`, `nestOnlyProblems`, `collapsedCards` (Job/Sections/Parts/
Nesting coverage). Stale selected paths are filtered against the current files.

**UI rules.** One card: title + selected count, a **Name rule** button opening the matcher dialog,
then the section table ordered like the Sections card (total length, then pieces). A row opens a
fullscreen **dialog**, paged by `‹ ›` / arrow keys (fields keep their own arrows), not an inline
expansion. Inside: statistics on the Nestings side, stock bars per adobe length, problem marks
boosted to the top and always sorted first, green mark↔file hover linking, unmatched names in their
own table, and `±` piece differences against required (amber short, red over). Issues =
`Σ|cut − required|` plus unmatched nested pieces. The divider runs the full dialog height.
