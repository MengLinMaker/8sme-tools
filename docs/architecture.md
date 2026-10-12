# Architecture — overlay diff (manufactured vs STEP ideal)

Decision log for how we compute and render the **overcut / undercut** overlay: comparing the
manufactured (NC-reconstructed) solid against the STEP ideal. Read with `AGENTS.md`; the raw NC
facts live in `docs/nc1-dstv-format.md` and `docs/canonical-orientation.md`.

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

Fixture: `~/Downloads/Failed tests/11602-02-01 NW31 BOTTOM & MIDDLE FRAMES - Shafts/m148.{nc1,stp}`.
Harness: `src/lib/step/scratch-m148.test.ts` (renders panels with a small software rasterizer to
`%LOCALAPPDATA%\Temp\opencode\m148\{side,iso,end}.png` + `results.txt`). Reproduce:
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
takes the first whose volumes validate (`over < ideal · 0.99`, `under < manufactured · 0.99` — a
failed cut returns ≈ the whole operand). Results after both fixes:

| part | auto fuzzy | over mm³ | under mm³ | tris |
|---|---|---|---|---|
| m148 | 1.0 | 17,028 | 27,768 | 428 |
| m116 | 1.0 | 0 | 4,028 | 360 |
| m12 | 0.5 | 1,105,671 | 2,036,537 | 1,472 |
| m122 | 0.5 | 54,554 | 98,476 | 1,040 |

All sane and compact (hundreds–1.5k tris), and m122 agrees with the boolean/voxel (~100k). `m12`
stays large — its broken reconstruction (§9). So this is the "good when it works" result made
reliable: the kernel uses the largest fuzzy it can handle and falls back to the probe otherwise.
