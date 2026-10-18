# Architecture — viewer alignment (stock ↔ manufactured ↔ STEP)

Status: **adopted**. Decision log for how the three preflight panes are put in one frame. Read with
`AGENTS.md`, `docs/architecture.md`, `docs/canonical-orientation.md`.

## The bug

Each pane seated its model independently, by a heuristic:

- **Manufactured (NC):** built by `reconstructFromNc` in its own raw frame, then re-seated by
  `seatQuaternion` (PCA principal angle + profile fit). The stock ghost and the projected NC cuts
  were drawn on axes derived from that guess.
- **STEP:** seated by `seatLikePrimary` — it **inherited the primary's rotation**, which is only
  correct when the STEP and the NC share a native frame.

Both are guesses, and the inputs are **not** in the same frame: a Tekla STEP is exported in its own
stance and origin (per family). Measured raw frames:

| part | NC build (raw) | STEP (raw) | relation |
|---|---|---|---|
| `m89` PFC | Y±50 / Z±25 | Y±50 / Z±25 | same |
| `m150` RHS | Y±50 / Z±75 | Y±50 / Z±75 | same |
| `m118` T | Y±67 / Z±52 | Y±52 / Z±67 | **90° roll** |

So the manufactured drifted from the stock, and the STEP either inherited a wrong roll (tubes) or
was a quarter-turn off (tees). Symptoms: stock↔manufactured offset/tilt, STEP "upside down" in the
diff, PFC flipped.

## The fix — one canonical frame, no heuristics for NC

**1. NC-built primary is placed analytically.** Its build frame is *known*: `reconstructFromNc`
extrudes the section on the `Y,Z` plane. `canonicalSeat` (`seat.ts`) applies a fixed
`CANONICAL_ROLL` (−90° about the member) and bbox-centres, giving the canonical display frame:

- member = **+X**, section **+x → −Z** (`CANONICAL_X_AXIS`), section **+y → +Y** (`CANONICAL_Y_AXIS`,
  machine up).

The stock ghost and the projected cuts are drawn on those same fixed axes, so
**stock ↔ manufactured ↔ projection coincide by construction** — nothing to guess or drift.
Verified (seated model vs stock profile, mean distance): angle **0.00**, channel **0.02**,
tee **0.06** mm (was ~2–5 mm).

**2. STEP is registered, not inherited.** `alignToPrimary` scores the **24 cubic orientations** of
the STEP against a reference cloud (coarse 3 mm near-surface grid) and takes the best:

- **Overlay pane:** reference = the seated manufactured mesh (the NC is the fixed frame).
- **STEP pane:** reference = a **synthetic prism** of the stock profile (`seatedStepProfile`), so a
  STEP with no NC still lands in the canonical frame.

Verified (`seat-match`, over/under under the viewer seating): tubes/angle **0.0%**, tee `m143`
**98% → 6.3%**.

**3. One reference per pane.** `PartViewer` uses `profile = ncSection ?? stock.points` — the NC
section when present — so the STEP seat, the ghost and the projected cuts share one outline. The
PDF/STEP-derived stock is only a fallback for a part with no NC.

## Invariant

> NC-derived geometry lives in one fixed canonical frame; the STEP is the only thing aligned to it,
> and by registration, never by a per-model heuristic.

## Code

- `src/lib/step/seat.ts` — `CANONICAL_ROLL`, `CANONICAL_X_AXIS/Y_AXIS`, `canonicalSeat`,
  `alignToPrimary`, `seatedStepProfile`, `seatedPair(..., primaryCanonical)`.
- `src/lib/step/viewerModel.ts` — overlay diff registers the STEP to the manufactured.
- `src/features/preflight/PartViewer.tsx` — `ncPrimary` prop, per-pane seat, NC-section reference.
- `src/features/preflight/PreflightPage.tsx` — `ncPrimary` on the manufactured + overlay panes.

## Tests

`seat.test.ts`, `seat-match.test.ts` (tubes must stay 0.0%), `diffProfile.test.ts`,
`occDiff.skin/overgrown`, `reconstructFromNc`, `reconstructMitre`, `ncStepAgreement`.

## Open

- `m199` tee (~60%) and `m105` SHS (~57%): residual is a **shape** difference between the NC rebuild
  and the STEP, not placement (registration is already correct).
- The T build stance (AGENTS open item): Tekla's T is flange-down while our build's raw frame is a
  quarter-turn from it; the canonical seat hides this in-app, but the exported manufactured NC still
  carries the build stance.
