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
  hex-module-frames/           # J12095 HEX Module Frames (STEP-only, flat item<##>.stp)
  chs/                         # J7347 18 m Leg Nest (circular hollow, 508.0 OD × 9.5)
  ub/                          # rolled I-section seat reference — M_12 (UB250*31, 5.3 m)
  assembly-demo/               # 6 nw31-top NCs + assembly part list + 2 assembly sheets (TR-1/TR-2)
  assembly-demo.zip            # the same folder zipped for dropping on the Preflight tab
```

`assembly-demo.zip` is not a test input: it is the hand-check job for the **Assemblies** card.
Drop it on `/preflight` — two assemblies, one member each the part list names but no NC ships
(`m999`, `m1000`) so the "no files" flag is visible, and one sheet is two pages so the drawing
dialog's page handling is exercised.

Marks included per job:

- **nw30-bottom:** m105 m106 m107 m108 m71 m87 a2
- **nw31-bottom:** m12 m15 m16 m106 m116 m122 m128 m147 m148 m166
- **nw31-top:** the 31 `BT100*15` Top-frame tees (m118…m232, see `cutBeam.nw31.test.ts`), plus
  a1 m24 m31 m41 m117 m124 m150 m154 m172 m173 m211
- **hex-module-frames:** item10 (200UB25.4 mass-variant) item35 (rotated-member SHS75*75*6.0)
- **chs:** `7347-18m-Leg-Nest-11980` — a 508.0 OD × 9.5 CHS leg (circular profile detection)
- **ub:** `M_12` — the only I-section with a real STEP; pins the stock-face seat (`seat-ub.test.ts`)

To extend: drop `<mark>.nc1` and/or `<mark>.stp` into the matching folder, then add the mark to the
suite that should use it. Whole-folder "scratch" scans (`scratch-skin-scan`, `scratch-bench-sabre`)
just operate over whatever marks are present.
