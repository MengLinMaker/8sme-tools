# NCEP open questions — living research log

Purpose: keep the **unresolved NCEP theories** in one place so agents can pick up work without
re-reading every probe result. This file is append-oriented; add evidence, probe IDs and links,
do not delete earlier entries.

Related docs:

- `docs/ncep-format.md` — format + parser/generator contract
- `docs/ncep-probe-log.md` — probe packs, WiseCAM results, reproductions
- `test/fixtures/ncep/` — real controls and reference variations
- `test/fixtures/ncep/generated-baselines/` — hash-guarded generated good/negative baselines

Status legend: **SOLID** (proven on WiseCAM), **LIKELY** (strong evidence), **SUSPECT**,
**UNTESTED**.

---

## Current confidence map

| Area | Status | Notes |
| --- | --- | --- |
| Canonical orientation / stance | **SOLID** | H / n / long-side-horizontal / L stances documented and implemented. Residual: mirrored `o`/`u` handedness is not encoded in the header. |
| Holes | **SOLID** | Our hole sets match real M-1/M-3/M-35/M-42; real holes load (`1502`). |
| Enclosed cuts | **SOLID** | Inner/enclosed contours are handled; no import blocker seen. |
| Markings | **LIKELY** | Text marks load; UB real text + bars improved the result (`1316`); M-42 has no mark. Correction (layer 4 bars) and short-part auto-mark rules remain open. |
| Exact outer section | **SOLID** | PFC/tube outer path must use exact corner vertices; dense sampled polylines fail (`1402`, `1405`, `1414`). The inner section path is irrelevant (`1404`, `1413`). |
| PFC section style | **SOLID** | Sharp chords between exact vertices work (`1403`, `1531`); true arcs are not required for PFC because its arcs are in the hidden cavity. |
| UB section arcs | **LIKELY** | True arcs required at the root fillets; sharp root fails even with real trims/holes/marks (`1504`). |
| Tube section arcs | **LIKELY** | True arcs required at the corner radii; sharp outer is blocky/offset (`1530`). |
| UB front trims/holes/marks | **LIKELY** | Real section + real trims → holes → marks loads (`1501–1503`). Our front features still glitch. |
| M-42 mitre/end cut | **LIKELY** | Real section + real mitred trims loads (`1511`/`1513`); our section with real trims offsets the end (`1512`). |
| Full-package container | **SOLID** | `container.xml` must have no trailing newline. `1604`/`1605` (real container) load; `1601–1603` (our container) reject. Writer fixed + regression test added. |
| Adobe `USERPATH` | **LIKELY** | Synthesized group parses; `902`/`906` show `USERPATH` is not required for import. Exact applied cut/lead geometry untested. |
| Hole correction / grey strips | **UNTESTED** | `UB corrected hole` is a desired form (47 → 36 holes); the general rule is unknown. |
| Bevels / notches / counterbore / slots | **UNTESTED** | Bevel is a nested `PosMap` child cluster; generator not implemented. No notch/counterbore/slot samples. |
| T / angle / round profiles | **UNTESTED** | No real NCEP references; `partFromNc` returns null. |
| Quantity / nesting / multiple parts | **UNTESTED** | Real per-part NCEPs use `TotalCount=1`; nesting semantics unknown. |
| Cache / `technologyID` | **LIKELY** | Unique names/fresh GUIDs avoid most cache effects; full-package failures may still involve a content-derived key. |

---

## Q1 — Arc span and the manufacturable surface (highest-value new clue)

**Status: SUSPECT → needs observation.**

WiseCAM has a view showing how the laser/head would contact the **manufacturable surface**. The
user observed that the arc is sometimes limited to a **shorter section**, not the whole section.
This is a strong clue for:

- where the developed surface starts and ends (the station origin/seam),
- which section edges are actually manufacturable,
- whether the section group should expose **partial arcs** rather than full cross-section arcs,
- why UB/tube arc probes are close but not identical, and why some cut lines are offset.

**Hypothesis:** WiseCAM derives the wrap/station mapping from the manufacturable/front arc span,
not from the whole nominal section. A full-section arc is not automatically correct; the arc
start/end vertices and the exposed span must match the head-contact surface.

**Investigation plan**

1. Open real references in WiseCAM: M-1 PFC, M-3 UB, M-35 SHS, M-42 RHS, plus canonical/90°
   reference variations.
2. Use the head-contact view and record:
   - which faces/edges are manufacturable,
   - where the usable surface starts and ends (seam, flange toe, root fillet, corner arc),
   - whether each arc is full 90° or a trimmed/partial span,
   - how the contact points relate to the section group's first/second path and the unrolled
     `x` stations.
3. Compare with the real part/adobe section groups and with our generated section groups.
4. Probe designs:
   - section group with **partial** arcs over only the manufacturable span vs full arcs;
   - vary arc start/end vertices while keeping the same radius;
   - UB/tube with arcs only on the front/manufacturable face, sharp elsewhere;
   - use `USERPATH` lead/contact points as a cross-check.

**Question to answer:** does the arc endpoint/span, rather than arc vs chord, explain the
remaining UB/tube offsets?

---

## Q2 — Bevels, mitres and notches

**Status: UNTESTED / partially decoded.**

- `Beveled PFC` encodes the bevel as **child paths nested inside the end-trim `<path>`**, carrying
  `PosMap={Src:4,Dst:…}` / `needSetAdobe=true`; the outer `TrucateType=1` trim remains.
- `Beveled PFC remove bevel` strips only the child paths.
- The **M-42 mitre** is still wrong in our generated part; real trims fix it (`1511`/`1513`), so
  the AK contour → truncate path/`InnerCad` development is the gap.
- Notches (`t`/`w`), counterbores and slots have no real NCEP probe coverage.

**Next tests**

- Decode the M-42 AK start/end contours and compare our `startCut`/`endCut` with the real trims.
- Generate the bevel cluster from a known NC bevel column set; probe `Beveled PFC` vs
  `remove bevel`.
- Add a notch probe and a counterbore/slot probe when real examples exist.

---

## Q3 — Full-package rejection / compression and container

**Status: SOLVED (2026-10-27) — the `container.xml` trailing newline.**

Evidence from `ncep-probes-nc2ncep result/`:

- `1600`/`1615`/`1616`/`1617` controls load.
- `1604` (fflate + real `container.xml`) and `1605` (zlib + real `container.xml`) **load**.
- `1601` (fflate), `1602` (zlib) and `1603` (stored) with **our** `container.xml` all reject.
- The only byte difference between our `container.xml` and the real one is a **trailing newline**:
  real is 379 bytes, ours was 380.

So compression is irrelevant (fflate, zlib and stored all work with the real container). The fix is
to emit the real container bytes with **no trailing newline**. This is now done in `ncex.ts`, with a
byte-exact regression test in `fromNc.test.ts`.

`1606–1614` (M-3/M-35/M-42) were tested before the fix and rejected; regenerate with
`~/Downloads/ncep-probes-container-fix.zip` to confirm each family. `1618` is the explicit
old-container negative control.

Residual Q3 items: entry order, `technologyID`, `ncex.opf` flags and content-derived cache keys are
now lower priority — no evidence they are blocking.

---

## Q4 — Mark correction and short-part behaviour

**Status: LIKELY / partly untested.**

- Text marks load; UB real text + bars improved the result (`1316`).
- Corrected marking moves bars to **layer 4** and adds `needSetAdobe=true`; our writer does not
  emit bars.
- M-42 is 106 mm; our unconditional 40 mm default mark is wrong. Real M-42 has **no mark**.
- M-1/M-35 default marks at `x=0` load, but the real exports place the text on a face/station,
  not always the seam.

**Next tests**

- Add real layer-4 bars to a generated part; compare with `PFC/UB corrected marking`.
- Determine the auto-mark length threshold and whether short parts should omit the mark.
- Compare mark placement at `x=0` vs the real face/station for M-1/M-3/M-35.

---

## Q5 — Hole correction / grey strips

**Status: UNTESTED.**

`UB corrected hole` removes whole developed-x columns (47 → 36 holes), not isolated holes. It is
unknown whether this is a general rule or part-specific. Compare the removed columns against the
NC/STEP geometry and test a second UB before generalising.

---

## Q6 — Adobe `USERPATH` / applied cut paths

**Status: LIKELY (not import-critical) / exactness untested.**

Real U/I adobes have a `USERPATH` group with applied separation cut paths. We synthesize a
5-path PFC / 6-path UB group; `902`/`906` show it is not required for import. Exact lead-in/out,
`wh:technical` and path ordering are still unverified. The WiseCAM head-contact view (Q1) may
explain how the leads relate to the manufacturable arc span.

---

## Q7 — T / angle / round profiles

**Status: UNTESTED.**

No real NCEP references. `partFromNc` returns null for `T`, `L`, `RO`. Need real exports to
decode their section, development and station rules.

---

## Q8 — `InnerCad`, `wh:technical` and lead parameters

**Status: UNTESTED / low priority.**

Our `InnerCad` is shorter and lower precision than real; our lead/technical templates are copied
but not proven for all features. `1203`/`1403` suggest the cut/mark content can be tolerated, but
save/machining correctness is unproven. Compare a real `InnerCad`/lead block with ours on a
known-good part.

---

## Q9 — Quantity, nesting and multiple parts

**Status: UNTESTED.**

Real per-part NCEPs use `TotalCount=1`; NC quantity can be >1. Nesting is not represented in a
part package. Test `TotalCount=2`, multiple `<Part>` entries, and whether WiseCAM nests or
duplicates. Keep unique marks.

---

## Q10 — Cache / `technologyID` / duplicate marks

**Status: LIKELY.**

Fresh GUIDs and unique names avoid most cache effects. `30b`/`31`/`32` show GUID format is not
validated; `190–196` show duplicate-mark behaviour. If a package works after renaming but not
before, suspect a content-derived cache key rather than geometry.

---

## Probe index

| Pack | IDs | Purpose |
| --- | --- | --- |
| `probes.inject` | 600–608 | control-first feature stripping |
| `probes.injectFeatures` | 620–627 | holes, end cuts, donor bevels |
| `probes.ownStructure` | 700–712 | generated parts in generated packages |
| `probes.controlFirst` | 800–811 | ZIP/docs/rename/part/Adobe isolation |
| `probes.adobe` | 900–911 | Adobe/USERPATH isolation |
| `probes.theories` | 1200–1215 | section sibling/nested, stretch, combos |
| `probes.arcs` | 1300–1316 | real arc section + marks |
| `probes.arcEdges` | 1400–1417 | per-edge/full-arc isolation |
| `probes.frontFull` | 1500–1531 | UB front features, M-42 mitre, full-package matrix |
| `probes.nc2ncep` | 1600–1618 | improved full packages + fflate/zlib/stored + container fix |

Generated references: `test/fixtures/ncep/generated-baselines/` (hash-guarded).

---

## How to update this log

- Add new entries with a stable `Q<n>` heading, status, evidence (probe IDs), hypothesis and next
  test.
- Do not delete negative results; they define the boundaries.
- Keep probe packs small and control-first; one variable per file where possible.
- Link exact file names and WiseCAM result comments.
- If a theory is proven, move it to the confidence map and record the probe that proved it.
