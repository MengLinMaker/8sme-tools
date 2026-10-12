# Test fixtures

Real job parts used by the geometry/parser suites, committed to git so the tests are portable —
a plain clone runs them, no external `~/Downloads` checkout. Each file is the ground truth named in
`AGENTS.md`: the part's DSTV `.nc1` and its Tekla `.stp` (the PDF drawing is the origin).

This is a **curated** set: only the marks the tests name (the known failure cases), not whole jobs.
Kept to ~8 MB. Paths resolve through `test/fixtures.ts` (`nw30Bottom`, `nw31Bottom`, `nw31Top`,
`OUTPUT_DIR`); set `SME_FIXTURES_DIR` to point at a full out-of-band job instead.

```
test/fixtures/
  nw30-bottom/                 # 11601-02-01 NW30 BOTTOM FRAMES - SHAFTS
  nw31-bottom/                 # 11602-02-01 NW31 BOTTOM & MIDDLE FRAMES - Shafts
  nw31-top/                    # 11602-03-01 (NW31 Top frames) Shaft part drawings
    NC files/
    STP files/
```

Marks included per job:

- **nw30-bottom:** m105 m106 m107 m108 m71 m87 a2
- **nw31-bottom:** m12 m15 m16 m106 m116 m122 m128 m147 m148 m166
- **nw31-top:** the 31 `BT100*15` Top-frame tees (m118…m232, see `cutBeam.nw31.test.ts`), plus
  a1 m31 m41 m117 m124 m150

To extend: drop `<mark>.nc1` and/or `<mark>.stp` into the matching folder, then add the mark to the
suite that should use it. Whole-folder "scratch" scans (`scratch-skin-scan`, `scratch-bench-sabre`)
just operate over whatever marks are present.
