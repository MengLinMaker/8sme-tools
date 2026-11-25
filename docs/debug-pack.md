# Debug pack — NC + STEP pairs across section families

A curated set of marks that have **both** the DSTV `.nc1` and the Tekla `.stp`, chosen to
cover every stocked section family and the awkward cut features: welding prep of every
magnitude, curved cuts, notches, slots, hole-heavy parts, a mitre, a stub, and T sections.

The files are the repo fixtures (`test/fixtures/…`) — paths below — so the pack needs no
separate checkout. A ready-to-share copy was exported to
`~/Downloads/debug-pack-sections-<date>/` with `NC/`, `STEP/` and `manifest.csv`.

**Identity is the NC's internal mark** — the `ST` header field. That is what the machine, the part
list and WiseCAM see; the filename is only a container (a real mark can contain `/`, which a
filename cannot — `M_12.nc1` carries the internal mark `M/12`). All other parts here agree with
their filename, and the exported `manifest.csv` records both columns plus a `marks_consistent`
flag, so the pack is consistent with that rule.

`dVol`/`dSize` are our NC→STEP rebuild measured against the reference STEP, so the largest
deltas are the most informative parts to diff.

| mark | family | profile | blank len | qty | welds | max° | arcs | holes | slots | notches | dSize | dVol | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `m117` | RHS | RHS150*100*9.0 | 4271 | 6 | 4 | 20 | 0 | 0 | 0 | 0 | 0.0 mm | 0.0% | baseline; 4×20° welds; qty 6 |
| `m119` | RHS | RHS150*100*9.0 | 3966 | 1 | 8 | 79.4 | 0 | 0 | 0 | 8 | 0.0 mm | 1.08% | 8×79.4° steep welds + 8 notches |
| `m159` | RHS | RHS150*100*9.0 | 3990 | 1 | 28 | 79.4 | 0 | 0 | 0 | 0 | 0.0 mm | 1.13% | 28 welds at 79.4° — heaviest welding prep |
| `m105` | SHS | SHS100*100*6.0 | 3966 | 4 | 0 | 0 | 8 | 0 | 0 | 8 | 0.0 mm | 4.64% | 8 curved-cut arcs + 8 notches; largest volume delta |
| `m122` | SHS | SHS100*100*9.0 | 3966 | 3 | 8 | 79.4 | 0 | 0 | 0 | 8 | 0.0 mm | 0.85% | SHS 9 mm wall; 8×79.4° welds; qty 3 |
| `m147` | SHS | SHS100*100*6.0 | 3966 | 2 | 6 | 0.7 | 0 | 0 | 0 | 8 | 0.1 mm | 4.13% | near-flat 0.7° welding prep + 8 notches; qty 2 |
| `m124` | PFC | PFC100*50 | 2056 | 1 | 11 | 63.3 | 0 | 8 | 0 | 0 | 0.0 mm | 0.04% | 11 welds at 63.3°; 8 holes |
| `m116` | PFC | PFC100*50 | 2981 | 1 | 1 | 20 | 0 | 12 | 6 | 0 | 0.0 mm | 0.0% | 20° weld; 12 holes incl. 6 slots |
| `m65` | PFC | PFC100*50 | 2021 | 1 | 0 | 0 | 0 | 8 | 4 | 0 | 0.0 mm | 0.0% | no welds; 8 holes / 4 slots |
| `m128` | PFC | PFC100*50 | 1516 | 24 | 1 | 20 | 0 | 3 | 1 | 0 | 0.1 mm | 0.03% | 20° weld; high quantity (24) |
| `m31` | PFC | PFC100*50 | 4114 | 1 | 12 | 64.2 | 0 | 11 | 0 | 0 | 0.0 mm | 0.03% | 12 welds at 64.2°; 11 holes |
| `a1` | angle | EA75*75*6 | 4166 | 1 | 2 | 20.9 | 0 | 3 | 3 | 0 | 1.1 mm | 0.01% | angle; 2×20.9° welds; mitred end; 3 holes / 3 slots |
| `a2` | angle | EA75*75*6 | 100 | 378 | 0 | 0 | 0 | 1 | 1 | 0 | 0.0 mm | 0.0% | angle, 100 mm stub, qty 378 |
| `m118` | T | BT100*15 | 2921 | 1 | 16 | 45.4 | 0 | 8 | 0 | 0 | 19.2 mm | 0.06% | T: 16×45.4° welds, 8 holes; member end differs 19 mm (known T end treatment) |
| `m135` | T | BT100*15 | 2971 | 1 | 9 | 45.3 | 1 | 8 | 0 | 0 | 19.2 mm | 0.06% | T: curved cut (arc) + 9×45.3° welds; member end differs 19 mm |
| `m200` | T | BT100*15 | 2744 | 1 | 10 | 45.3 | 1 | 8 | 0 | 1 | 4.6 mm | 0.07% | T: notch + 10 welds |
| `M/12` (file `M_12`) | UB/UC | UB250*31 | 5309 | 1 | 0 | 0 | 0 | 62 | 0 | 0 | 0.0 mm | 0.07% | UB250*31; 62 holes incl. overlapping pair |

## Where the pair lives

| project | path |
|---|---|
| nw31-top | `test/fixtures/nw31-top/{NC files,STP files}/<mark>.nc1\|.stp` |
| nw31-bottom | `test/fixtures/nw31-bottom/<mark>.nc1\|.stp` |
| nw30-bottom | `test/fixtures/nw30-bottom/<mark>.nc1\|.stp` |
| part-ir | `test/fixtures/part-ir/<mark>.nc1\|.stp` |
| ub | `test/fixtures/ub/M_12.nc1\|.stp` |

## Coverage

- **Welding prep spans the range**: 20° (m117, m116, m128, a1 20.9°), 45–64° (m118, m135,
  m200, m124 63.3°, m31 64.2°), 79.4° (m119, m159 with 28 preps, m122), near-flat 0.7° (m147).
- **Curved cuts**: m105 (8 arc vertices on a SHS) and m135 (an arc on a T).
- **Notches**: m119, m105, m122, m147, m200. **Slots**: a1, m116, m65.
- **Hole-heavy / boolean edge case**: M_12 — 62 holes including the known overlapping pair.
- **Quantity**: m128 (24), m117 (6), a2 (378). **Short stub**: a2 (100 mm). **Mitre**: a1.
- **Families**: RHS 150×100×9, SHS 100×100×6 and ×9, PFC100*50, EA75*75*6, BT100*15, UB250*31.

## Using it

```sh
# rebuild the NC and diff it against the STEP in any STEP viewer
pnpm nc-to-step -i "test/fixtures/nw31-top/NC files/m124.nc1" -o /tmp/m124-built.stp
```
In the app, open the job and use the **Overlay** pane: manufactured (NC rebuild) vs the STEP
ideal — red = overcut (scrap), blue = undercut.

## Mark naming

The part is named by its NC internal mark. `M_12.nc1` is the only fixture in the pack whose
filename differs from the internal mark (`M/12`), because a slash cannot appear in a filename; the
audit's `markKey` already treats `/`, `_`, `-` and whitespace as the same separator, so the two are
the same part.

## Gaps in the paired data

- **No etch/marking data**: no paired fixture carries `SI` text or `KO`/`PU` scribe marks. The
  only NC files with `KO`/`PU` are `test/fixtures/ncep/`, which has no STEP — so mark
  production cannot be diffed from this pack.
- **One size per family** except the hollows: a single UB (250UB31) and a single PFC size, so
  taper/mass-variant differences are not covered here.
