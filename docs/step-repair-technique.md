# STEP repair by re-drilling intended holes

Some Tekla assembly exports are **structurally corrupt**: they carry membrane/skin faces,
half-bores and near-coincident surfaces. Boolean cuts on the original then leave slivers, create
steps, or fail outright, so “open the caps” cannot be done reliably in place.

The repair decouples two jobs that the corrupt file has merged:

- **Base** — a clean solid with the broken features removed/filled (for example a re-export from
  Tekla, or a manually cleaned reference).
- **Feature source** — the original STEP, which still knows the *intended* holes.

We harvest the intended holes from the feature source and re-drill only the ones the base is
missing. Existing, already-clean holes are never touched.

## Algorithm

1. **Load the main solid** of both files (largest body; bolts/strays ignored).
2. **Harvest hole specs** from the feature source:
   - take every cylindrical face (`CYLINDRE`),
   - read its radius and axis (line + direction),
   - group coaxial faces by `(radius, axis line)` — this merges two half-bores into one hole,
   - union their axial spans into `lo..hi`.
3. **Collect the base's hole specs** the same way.
4. **Diff:** a feature hole is *missing* from the base when its `(radius, axis line)` key has no
   match. (Caps/skins do not matter; only the hole exists as a cylinder.)
5. **Re-drill** each missing hole into the base:
   - full cylinder of the feature radius,
   - along the feature axis,
   - length = `hi - lo + 2 × overrun` (default overrun 5 mm each end), so it exits the local wall.
6. **Heal:**
   - drop degenerate faces (plane in-plane width < 0.1 mm; cylinder min bbox dim < 0.1 mm),
   - sew the remaining faces,
   - `makeSolid`,
   - accept only when `BRepCheck_Analyzer` says valid.
7. **Export** the healed solid.

## Why it works

- Booleans are only ever run against the **clean base**, never the corrupt faces.
- Re-drilling only the *missing* holes leaves every other hole and face untouched.
- Half-bores become full holes because the feature axis/radius define the complete cylinder,
  regardless of how many half-cylinders the corrupt source used.
- Healing after the cuts removes the tiny sliver faces that otherwise corrupt the STEP.

## CLI

```
pnpm repair-step \
  -b <clean-base.stp> \
  -f <original-features.stp> \
  -o <out.stp> [--overrun 5] [--json]
```

Example (GB8):

```
pnpm repair-step \
  -b "GB8(3).stp" \
  -f "15-Shafts/GB8.stp" \
  -o "15-Shafts/GB8.repaired.stp"
```

reports `14/26` holes re-drilled, `1` solid, `0` caps, `0` slivers, valid, volume `18,461,924`.

## App: Part → Issues → Clean Tekla

`PreflightPage` exposes the repair as a one-click action in the part **Issues** panel, next to
**Clean STEP**:

1. Select the part (its real STEP is the feature source).
2. Click **Clean Tekla**.
3. With an NC present, the clean base is rebuilt from the NC, the STEP's holes are re-drilled into
   it, and the result becomes a **viewable + exportable** STEP override (`kind: 'repaired'`).
   Without an NC it falls back to the in-place **Clean STEP** behaviour.
4. **Undo** restores the original.

Unlike the CLI, the app does not prompt for a base file — it derives the clean base from the NC
when one exists. For an arbitrary base file use `pnpm repair-step`.

The action is offered for the same parts as **Clean STEP**: those whose STEP carries **stray
bodies** (the Tekla assembly symptom). Single-body / seemingly clean STEPs do not show it.

## Limitations

- Requires a clean base file; the tool does not invent the correct geometry.
- Only **cylindrical** holes are harvested. Slots/rectangular cuts and bevels are not re-drilled.
- `--overrun` may pierce a second wall if two walls are closer than the overrun (often desired for
  through-bolts, but check hollow-section parts).
- If the base already contains a hole at the same axis/radius, it is left as-is (not re-cut).
