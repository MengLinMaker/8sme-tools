# SAT / ACIS prisms → a standard-section STEP with true arcs

Companion to `docs/nc-to-step.md` (the same recognition problem, from the other direction: a part
that arrives as a **prism exported from a modeller** instead of an NC).

## Goal

Read the cross-section out of an ACIS `.sat`, confirm it is a catalogued section, and re-emit the
same prism as a STEP whose corners are true circular arcs — **one cylindrical face per corner**,
which is what WiseCAM's standard-section matcher needs (`docs/nc-to-step.md`, "Stock sections are
generated as real arcs"). The length and any planar end cut (bevel/rake) are preserved.

WiseCAM imports STEP, not SAT, so the output is always `.step`.

## Tool

```sh
pnpm sat-section -i "<file.sat>" [-o "<out.step>"] [--schema AP203|AP214IS|AP242DIS] [--json]
```

Implementation: `tools/sat-section.mjs`. It

1. parses the SAT (`point` / `vertex` / `edge` / `face` / curve / surface records),
2. takes the edges that lie in the **square end** plane and links them into one loop,
3. measures `d, b, tf, tw, r` — the fillet centres name the section: a root fillet sits
   `tw/2 + r` off the web axis and `d/2 − tf − r` off the depth axis, so the pair also says which
   bbox axis is the depth,
4. identifies the catalogue section with `inferSectionFromCross` (dims + shape IoU) and takes the
   clean outline from `stockOutlineForCode`,
5. seats that outline in the SAT's own frame (same depth axis, same bbox corner, so the end cuts
   written in world coordinates still land where they were), extrudes to the SAT's length, and
   cuts each slanted end plane as a half-space,
6. writes STEP and **verifies** the result: outline deviation, `measureStep` bbox/volume against
   `area × (z_end(centroid) − zMin)`, and `detectStepSection` re-reading it.

Refuses rather than guesses: a section that matches nothing, more than one loop, a compound-mitre
end cut, or a rebuilt outline that deviates from the SAT.

## Output metadata

Same convention as the known-good Tekla STEPs (`docs/nc-to-step.md`): **AP203**
(`CONFIG_CONTROL_DESIGN`, default) with the section designation in **`FILE_NAME` and `PRODUCT`**.
`--schema AP214IS` gives the old OCC default for comparison.

## Findings on `150uc_3164.6mm long_2 off.SAT` (SolidWorks 2024 → ACIS 33)

- The section is **`150UC23.4`**: `d 152 × b 152, tf 6.8, tw 6.1, r 8.9` — exact, parallel flange.
- **The corners are not polylines.** All 8 fillet edges at the square end are `ellipse-curve`
  records (full circles, ratio 1, radius 8.9) on `cone-surface` faces with zero half-angle (i.e.
  cylinders), and the far end's arcs are `intcurve` (NURBS) trims of the same circles.
- The real defect is **8 cylindrical faces instead of 4**: every 90° root fillet is split at 45°
  (`(11.95,145.2)→(5.657,142.593)→(3.05,136.3)`), so each fillet is two faces — a matcher that
  expects one face per corner sees a profile it does not know.
- 22 faces total = 12 side planes + 8 fillet halves + 2 caps. Nothing else is faceted; the web,
  flange faces and tips are all exact.
- The part is 3164.6 mm at its longest with **one square end (z = 0) and one rake**: the end plane
  is `z = 2914.96 + 1.6424·y` (31.3° off square, through the 152 mm depth), so the short corner is
  2914.96 and the long one 3164.6.

Rebuilt: 18 faces = 12 side planes + **4** cylindrical faces (r 8.9) + 2 caps; 40 lines, 4 circles,
4 ellipses, **no 3D NURBS**; volume `9 056 825 mm³` (the SAT's own contour gives the same
`9 056 825 mm³`); `detectStepSection` reads it back as `150UC23.4`, score 1.

## Results for testing

Run on `~/Downloads/150uc_3164.6mm long_2 off.SAT` (the file as supplied), output alongside it as
`150uc_3164.6mm long_2 off.step`:

```
$ pnpm sat-section -i "150uc_3164.6mm long_2 off.SAT"
input      150uc_3164.6mm long_2 off.SAT
section    150UC23.4  (d 152 × b 152, tf 6.8, tw 6.1, r 8.9)
corners    8 arc faces in the SAT → 4 exact arcs rebuilt
length     3164.6 mm, 1 end cut(s)
deviation  2.8e-6 mm from the SAT outline
output     .../150uc_3164.6mm long_2 off.step  (AP203)
verified   152 × 152 × 3164.6 mm, 9056825 mm³, read back as 150UC23.4 (score 1)
```

What the written STEP contains (read back out of the file, not from the build):

| check | result |
|---|---|
| schema / header | `CONFIG_CONTROL_DESIGN`, `FILE_NAME('150UC23.4')`, `PRODUCT('150UC23.4','150UC23.4',…)` |
| section faces | `CYLINDRICAL_SURFACE` ×4, all radius `8.9` (one per root fillet) |
| face count | 18 (`ADVANCED_FACE`), single `MANIFOLD_SOLID_BREP` |
| 3D edge curves | 40 `LINE`, 4 `CIRCLE` (square end), 4 `ELLIPSE` (rake end), **no 3D B-spline** |
| bbox / volume | `152 × 152 × 3164.6 mm`, `9 056 825 mm³` (expected `9 056 830`) |
| rake preserved | plane normal `(0, −0.85413, 0.52006)` through `z(−50) = 2832.84`, i.e. the same `z = 2914.96 + 1.6424·y` |

### Measured both ways

Both files measured independently (the SAT from its ACIS records, the STEP from its own
`PLANE`/`CYLINDRICAL_SURFACE`/`EDGE_CURVE` records), not from the catalogue entry:

| quantity | SAT | STEP | Δ |
|---|---|---|---|
| flange width b (x extents) | −76 … +76 | −76 … +76 | 0 |
| depth d (y extents) | 0 … 152 | 0 … 152 | 0 |
| flange thickness tf (y planes 6.8, 145.2) | 6.800000 | 6.800000 | 0 |
| web thickness tw (x planes ±3.05) | 6.100000 | 6.100000 | 0 |
| flange tips (x planes ±76) | 76.000000 | 76.000000 | 0 |
| root radius r | 8.899993351 | 8.900000000 | 6.6e-6 |
| fillet centre, top right | (11.9499934, 136.3000066) | (11.9500000, 136.3000000) | 6.6e-6 |
| tangent points | on x = 3.05 / y = 6.8, 145.2 | same planes | 0 |
| max contour deviation (exact, arcs projected) | — | — | 2.8e-6 |
| section area | 2979.4343 mm² | 2979.4344 mm² | ~1e-4 |
| length | 3164.600000 | 3164.600000 | 0 |
| rake dz/dy, z(0), z(152) | 1.642368421, 2914.960000, 3164.600000 | same | 0 |
| volume | 9 056 825 mm³ | 9 056 825 mm³ | 0 |

So the only real differences are structural: **8 arcs at 45° became 4 at 90°**, and the radius is the
catalogue's exact `8.9` where SolidWorks modelled `8.8999934` (6.6 nm short — the fillet is defined
from `r`, so its centre moves by the same 6.6 nm; the tangent planes do not move). The tool used to
print `0.0007 mm` for the deviation because it measured against a 64-step sampled outline; it now
projects onto the true arcs (`2.8e-6 mm`).

B-spline records exist only as **pcurves** (`PCURVE` inside `SURFACE_CURVE`), which is normal OCC
output; every geometric curve is analytic.

Repo checks after the change: `tsc --noEmit` clean; `seatExport.test.ts`, `sectionBrep.test.ts`
and `tabs.test.ts` pass (they exercise the default `writeStep` path, which is unchanged).

Still untested: the step that actually matters — **WiseCAM importing the file and registering the
section**. Nothing in this repo can stand in for that.

## Open items

- Whether WiseCAM itself accepts the rebuilt STEP as `150UC23.4` — our detector scoring 1 has not
  been sufficient before (`docs/nc-to-step.md` "UB section recognition"). If it does not, the next
  variable is the schema/metadata pair above, and after that the product/assembly structure.
- A merge of the split faces **in place** (ACIS surgery) is not implemented; the tool rebuilds from
  the catalogue dimensions instead, which is safe because the rebuilt outline is checked against
  the source.
