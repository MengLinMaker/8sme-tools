# Machine range of motion — KL-90010-T

The one machine every job in these tools runs on: the **KL-90010-T** heavy-duty CNC tube /
profile laser at **8 Star Metal Engineering**, 6 Damian Ct Dandenong VIC. It is a **5-axis
CNC laser tube cutter** with a **Weihong (FSCUT) / TubePro-class controller** — the controller
takes the DSTV `.nc1` + STEP and posts the toolpath the head executes. (See
`docs/nc1-dstv-format.md` for the input formats.)

This document records the **work envelope** ("range of motion" in the practical sense: what can
physically go in and what the head can reach). It is the normative limit for nesting and
manufacturability checks. Treat the numbers here as the single source of truth; if a job needs
to exceed one, stop and confirm with the operator.

## Confirmed specifications

The four headline figures, confirmed by the machine's own label (photo on the 8 Star machine
page) and the vendor spec page:

- **Maximum tube diameter** — up to **900 mm** (round CHS; rotary bore 1,000 mm).
- **Maximum single-pass length** — **13.5 m** (12 m standard stock + 1.5 m).
- **H-beam processing capacity** — up to **800 × 300 mm**.
- **Bevel cutting capability** — **±45° in a single pass** (oscillating head, weld-prep).

## Work envelope

| Axis / quantity | Value | Notes |
|---|---|---|
| Type | **5-axis** CNC tube/profile laser | X/Y/Z linear + rotary (tube) + bevel head tilt |
| Max tube length (single pass) | **13.5 m** | 12 m standard stock + 1.5 m |
| Max round tube (CHS) | **Ø 900 mm** OD | rotary axis bore is **1,000 mm** through-feed |
| Max square (SHS) | **400 × 400 mm** | min ≈ 25 × 25 mm |
| Max rectangular (RHS) | **≤ 400 × 300 mm** | — |
| H-beam / I-beam | **100 × 100 → 800 × 300 mm** | automatic cross-section detection — no re-fixture between profile types |
| Channels (PFC), angles (EA/UEA) | cut | parallel-flange channels; equal & unequal angles |
| Max material thickness | **25 mm** carbon steel | across all profile types |
| Bevel / weld-prep range | **−45° … +45°** | single pass, oscillating head |
| Cut geometries | straight, miter, bevel, holes & slots | all in the same setup/pass |

## What "5-axis" means here

- **X / Y / Z** — head positioning over/around the section.
- **A / B (rotary)** — the clamped tube indexes about its axis; the head also tilts for bevel
  and miter (the `±45°` capability).
- Feed is a through-feed chuck arrangement; the exact per-axis linear travels (mm) and chuck
  RPM are **not published** by the vendor — the envelope above is what is documented. The
  *effective* limits for us are the length and cross-section caps, not the raw servo travel.

## Provenance — what the `KL-90010-T` code is

It is **not a public factory model number**. It is the label painted on the machine's own
enclosure (blue/white cabin, confirmed in the workshop photo on the 8 Star machine page) and
appears only in 8 Star's own material. In other words it is a **private-label / OEM heavy
5-axis tube-profile laser**, controlled by a **Weihong (NcStudio) or FSCUT/TubePro-class**
controller — the same class of Chinese structural-steel tube/profile machine sold under many
house brands.

- The number almost certainly encodes **900** (max round tube, mm) and a length/class figure;
  the input format the machine consumes is DSTV `.nc1` + STEP, not the label.
- No factory datasheet is published under this code, so per-axis servo travels and chuck RPM
  are **unknown**; only the envelope above is documented.

### Comparable OEM machines (sanity check on the figures)

Our envelope sits between the "heavy tube" and "structural profile" classes. Reference points
from named Chinese manufacturers in the same class (their published envelopes):

| Machine | Round | Square | Length | Bevel |
|---|---|---|---|---|
| **KL-90010-T** (ours) | Ø 900 mm | ≤ 400 × 400 | **13.5 m** | ±45° |
| Longxin `LX-H100` (profile) | Ø 150–1000 mm | 150–850 | ≤ 12 m | yes |
| Acme `LH` series (profile) | — | 200×100–1200×600 | 12–12.5 m | ±45° |
| Machitech `Fiber Tube XL` 26″ | 80–630 mm | — | 12 m (40′) | yes |
| Han's `TX12050T` (heavy tube) | Ø 50–500 mm | 50–500 | 12 m | ±45° opt. |

So **900 mm @ 13.5 m single-pass** is a genuinely large, upper-tier envelope — the 13.5 m
single-pass is the unusual part (most peers cap at 12 m), consistent with "12 m + 1.5 m".

## Notes & caveats

- **Source is the vendor's own spec pages** (8 Star, 2026) plus the machine label photo. The
  machine carries no public factory datasheet under this model code.
- **Ignore the "25min tube diameter" copy** on some sibling service-area pages — that is a
  rendering artefact of "900 mm". The canonical figure is **900 mm OD** (see
  `laser-tube-cutting-melbourne`, the dedicated machine page).
- Cross-section dimension convention (for nesting math) follows the section frame in
  `docs/canonical-orientation.md`: the longer cross-section side runs horizontally in the
  machine stance. Envelope is checked against the **bounding** dims, so a `400 × 300` RHS sits
  inside the `400 × 400` square limit.
- The **bottom-cut mass guard** (`BOTTOM_CUT_MAX_GRAMS = 10`) is a *head-safety* rule, not an
  envelope rule — see `docs/canonical-orientation.md` §4.

## Relationship to the tools

| Concern | Where |
|---|---|
| Machine profile (limits + pure checks) | `src/lib/machine/profile.ts` (`KL90010T` / `MACHINE`) |
| Max stock length used by the nester | `src/lib/nesting/nest.ts` (tests pass `length: 12000`, the 12 m standard bar) |
| Thickness-change reach (head can't clear large steps) | `src/lib/audit/manufacturability.ts` (`UNMANUFACTURABLE_DEPTH`) |
| Section stance / cross-section dims | `src/lib/sections/stock.ts`, `docs/canonical-orientation.md` |
| Cut-side priority & bottom-cut mass guard | `src/lib/sections/canonical.ts` |

## Machine-profile + checks lib

The machine facts live as **one typed constant** in `src/lib/machine/profile.ts` (`KL90010T`,
re-exported as `MACHINE`). Checks read their limits from it instead of hard-coding literals, so a
second machine later is just another object — **no registry, no plugin interface** while there is
only one machine.

```ts
export interface MachineProfile {
  id: string
  name: string
  doc: string                                   // docs/machine-kl90010t.md
  envelope: {
    maxLengthMm: number                         // 13_500
    maxRoundMm: number                          // 900
    maxSquareMm: number                         // 400
    hBeam: { depthMm: number; flangeMm: number } // 800 × 300
    maxThicknessMm: number                      // 25 (carbon steel)
  }
  bevel: { minDeg: number; maxDeg: number }     // -45 … +45
  bottomCutMaxGrams: number                     // 10
  unmachinableDepthMm: number                    // 30
  defaultStockLengthMm: number                   // 12_000
}
export const KL90010T: MachineProfile = { /* … */ }
export const MACHINE = KL90010T
```

**Pure checks** (also in `profile.ts`, unit-tested in `profile.test.ts`):
- `envelopeFits(size)` — length, round, square, H-beam depth/flange, thickness (omitted fields ignored);
- `bevelAllowed(angleDeg)` — inside `bevel.minDeg…maxDeg`;
- `stockLengthAllowed(lengthMm)` — within the single-pass length.

**Wired to the profile:**
- `src/lib/sections/canonical.ts` — `BOTTOM_CUT_MAX_GRAMS = MACHINE.bottomCutMaxGrams`.
- `src/lib/audit/manufacturability.ts` — `UNMANUFACTURABLE_DEPTH = MACHINE.unmachinableDepthMm`.
- `src/features/nesting/NestingPage.tsx` — default stock row + `COMMON_LENGTHS` use
  `MACHINE.defaultStockLengthMm`.

**Still to wire later** (present as literals, not yet reading the profile):
- `src/lib/audit/cutReach.ts` — `MAX_CUT_THICKNESS_MM = 25`, `MAX_BEVEL_DEG = 45` (WIP file).


## Sources

- 8 Star — machine page (authoritative here): <https://8starmetalengineering.com.au/laser-tube-cutting-melbourne/>
- 8 Star — service-area copy (Berwick / Dandenong / Hallam …) confirming 900 mm × 13.5 m, H-beam 800×300: <https://8starmetalengineering.com.au/services/structural-steel-fabricators-berwick/>
- Weihong — WiseCAM Tube (the toolpath producer): <https://www.weihong.com.cn/en/products/detail/121>
- Weihong — NcStudio / TubePro control manual: <https://d.fscut.com/wordpress-fscut/2020/10/TubePro-User-Manual.pdf>
- FSCUT / BOCHU — tube cutting control systems (heavy-tube / bevel): <https://d.fscut.com/wordpress-fscut/2024/03/FSCUT-Laser-Cutting-Control-System-Product-Brochure.pdf>
- Comparable OEM examples (class reference only): Longxin `LX-H100` <https://longxinlaser.com/product>; Acme `LH` series <https://acmelaser.com/lh-series-feed-type-beam-laser-cutting-machine>; Han's `TX12050T` <https://www.hansme.net/detail/TX_Series>
