# 8SME Tools — domain rules (READ FIRST)

Tools for **8 Star Metal Engineering** (Dandenong VIC), used by a **CNC steel tube laser**
technician. Jobs are nested/imported in **Weihong WiseCAM**; drawings/models come from
**Tekla**. The machine is the **KL-90010-T** — its range of motion / work envelope is in
`docs/machine-kl90010t.md`, which also carries the planned **machine-profile + checks lib**
(the scattered `BOTTOM_CUT_MAX_GRAMS` / `UNMANUFACTURABLE_DEPTH` / stock-length literals should
eventually read from one `MachineProfile`).

If a change touches nesting or flat-file output, follow these rules. They were each learned
the hard way — do not re-litigate them.

## Ground truth & sources

- **The PDF drawing is ground truth.** It is a Tekla export with a machine-readable title
  block (`MARK SECTION GRADE Qty LENGTH AREA WEIGHT`). The `.xlsx` part list matches it.
- **NC (`.nc1`) is DSTV NC** (DSTV87, German steel NC standard; Tekla export, ASCII blocks).
  Blocks: `ST` header → `AK` outer contour / `IK` inner contour / `BO` holes / `SI` marking →
  `EN`. Faces are `v` front/web, `o` top, `u` bottom, `h` rear. Full reference + sources:
  **`docs/nc1-dstv-format.md`**.
  The `ST` header is `{order, drawing, phase, mark, grade, quantity, profileTypeCode,
  profile, length, dims…}`. The cross-section dims for a **T** (`T` profile type) are
  `[flange width b, half depth d/2, tf, tw, root r]` of the parent UB.
- **STEP** parts are OpenCASCADE **AP214**. They contain the real part geometry (holes,
  curves, mitres). They carry **no quantity** (that's why WiseCAM drops quantity on import).

## T beams

- **All `BT…` sections are T beams.** A T is **half a UB** (a UB split lengthwise).
- Identify the parent UB by **dimensional fingerprint** (`inferParentUb`) against the AU UB
  catalogue (`AS/NZS 3679.1`). E.g. `BT100*15` = `[134, 103, 9.6, 6.3, 8.9]` → **200UB29.8**.
- The parent UB has **multiple mass variants per nominal depth** — match the exact one.

## Canonical orientation (stock & pieces)

Full spec: **`docs/canonical-orientation.md`**. Every stock beam is cut in one canonical stance;
the profile builders in `src/lib/sections/stock.ts` draw it, and `src/lib/sections/canonical.ts`
maps DSTV faces to machine roles + enforces the cut-side rules.

- **Stances:** UB/UC/TFB = **`H`** (web vertical, flanges horizontal). PFC/TFC = **`n`** (web on
  top, both flanges pointing down). RHS/SHS = **longer cross-section side horizontal**. Angle =
  **`L`** (longer leg horizontal, opening up-right). T = **flange down, web up**. These may be a
  rotation of Tekla's DSTV export stance — seat real parts into ours, don't match Tekla's.
- **DSTV faces are profile-relative**, not machine-relative: `v` front/web, `o` top, `u` bottom,
  `h` behind. In our stance the machine role is the face's outward normal (`+y` top, `−y` bottom,
  `±x` side). E.g. UB → `o`=top, `u`=bottom, `v`/`h`=sides; PFC (`n`) → `o`/`u`=sides (the
  flanges), `h`=top (web), `v`=bottom.
- **Cut-side priority: side first (most controllable), then top, bottom last.**
- **Bottom cuts** eject a slug that can hit the head: only cut the bottom when the removed piece
  is **< 10 g** (`BOTTOM_CUT_MAX_GRAMS`). `holeRemovedMassGrams(d, t)` / `bottomCutAllowed(g)`
  implement it.

## The two halves are INDEPENDENT

- A stock UB yields **two T bars**, and the **two sides are nested and cut independently**.
  There is **no pairing** of left/right pieces and **no spares** — do not pair identical
  lengths just to share a cut.
- Material: one UB of length L yields two T bars of length L, so total material ≈
  (total T length) / 2. At 12 m this nests the NW31 Top job's 31 T's into **3 UBs, ~94%**.

## Process (safety-critical)

- **Do NOT split the UB lengthwise first.** Once the halves are loose the clutch/chuck can't
  hold a single section and tolerance degrades.
- Keep the beam whole and clamped; **cut the lengthwise split locally, only as needed, so one
  piece comes out at a time** (easy to remove).
- **Cut order: shortest first (front → back).**
- **Never cut the same line twice.** Keep a **cut-collision / min-separation guard** that flags
  any left/right (or adjacent) cuts landing on the same or a near line.

## Output per stock beam

- **One NC and one STEP file per stock beam** (try both — one will behave in WiseCAM).
  **CSV is useless** — the job runs through WiseCAM regardless.
- STEP must be **assembled from the REAL part STEP files** so **holes/curves survive** —
  never substitute a clean/simplified prism.
- **Etch the part mark** on each piece — it identifies which piece is which (must be in the
  NC/STEP, not only the viewer).
- The 3D viewer must show the **real parts**, not simplified geometry.

## Toolchain

- pnpm + Vite + React + TanStack Router + PWA; Tailwind + shadcn-style UI; Biome; Vitest.
- CAD via `replicad` / `replicad-opencascadejs` (lazy-loaded ~23 MB WASM). Engraving font:
  **Liberation Sans** (SIL OFL) at `public/fonts/`.
- UI flow: **drop the job `.zip` first, then** detect T sections and set the stock inventory.
