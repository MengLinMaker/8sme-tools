# Root-fillet examples (clean)

NC-only test parts derived from the 3UC shaft job, with the **flange ends squared** at the tab
start so there is no angled cross-face step. Drop the `.nc1` files into a preflight job (or a
folder/zip) and open the part.

| File | Profile | CUT_ROOT_FILLET | CUT_DEPTH (sabre), before → after the fix |
| --- | --- | --- | --- |
| `UC250-clean.nc1` | `UC250*73` | 2 × 195 mm | 0 → 0 |
| `UC310-clean.nc1` | `UC310*118` | 2 × 123 mm | **24 → 0** |

## Why these exist

The real `3uc-1` / `3uc-110` parts have a **slightly angled flange end** (about 2.4°). The
manufactured NC cuts each face separately, which leaves a ~0.4 mm cross-face step at the web root
through the flange/web depth. The sabre flags that step as a CUT_DEPTH, independently of the
root-fillet cut. These examples square the flange end at the tab start (`x = 2812.73` on
`UC250-clean`, `x = 2185.80` on `UC310-clean`), so no step exists.

## Expected behaviour

- Both parts show `CUT_ROOT_FILLET` errors: “`<span>`mm root fillet cut may not drain slag which
  damages nozzle”.
- **Move fillet cut** with the suggested offset clears both fillet issues.
- On `UC310-clean`, applying the fix immediately re-probes the new manufactured solid: the nearby
  CUT_DEPTH rows clear (24 → 0), their markers hide, and the row shows Undo.
  **Both fillet rows must be applied**: the tab has two long edges on the fillets, and the
  CUT_DEPTH is the shared web-root over-cut. One edge alone leaves 12 samples; both give 0.
- `UC250-clean` has no CUT_DEPTH to begin with; it is the minimal detector/fix case.

These are NC-only, so the preflight builds the manufactured model from the NC itself. After both
fillet moves the NC→STEP rebuild also cuts the root-fillet band through at the tab start, so the
generated STEP has the flat-web tab edge instead of a leftover curved fillet wing
(`docs/nc-to-step.md`).
