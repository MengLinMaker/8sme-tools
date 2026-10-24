# NCEP reference variations — DO NOT EDIT

Operator-supplied reference exports (2026-10-24), copied from
`~/Downloads/ncep-export-variations/`. They are the golden set for the canonical-orientation,
marking, UB hole-correction and bevel findings documented in `docs/ncep-format.md` §3.

| File | What it is |
| --- | --- |
| `PFC*.ncep` | PFC base, no-marking, corrected-marking, canonical and 90° variants |
| `UB*.ncep` | UB base, corrected-hole, corrected-marking, no-marking, canonical and 90° variants |
| `RHS*.ncep` | RHS base, canonical and 90° variants |
| `Beveled PFC*.ncep` | bevelled end and the same part with the bevel removed |
| `necp-export-variations.ncexa` | combined WiseCAM export with all 20 parts, including the canonical + corrected hole + corrected mark UB part |

These are evidence, not generated probes. Do not rewrite, rename or “tidy” them; `manifest.json`
and `src/lib/wisecam/referenceFixtures.test.ts` guard their hashes and ZIP CRCs.
