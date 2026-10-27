# Generated NCEP reference baselines

These are **generated/probe outputs**, not WiseCAM ground truth. They preserve the key
successful and negative forms behind the section/arc theory, so future parser/generator work can
compare against fixed bytes.

Real controls and reference variations live in the parent directories:
`test/fixtures/ncep/M-*.ncep` and `test/fixtures/ncep/reference-variations/`.

Do not edit these files. `manifest.json` hash-guards them; regenerate with the matching probe pack
if the format changes. The `technologyID` is random per build but fixed in these bytes.

| File | Internal mark | Profile | WiseCAM result | Why it matters |
| --- | --- | --- | --- | --- |
| `M-1-1301-our-part-real-section.ncep` | `M-1-1301` | U | loads/saves | Our M-1 part + real arc section; looks pretty much identical. |
| `M-1-1402-sampled-section.ncep` | `M-1-1402` | U | invalid cut | Our sampled section; cut lines go off the face and cannot save. |
| `M-1-1403-sharp-cavity.ncep` | `M-1-1403` | U | loads/saves | Real section arcs replaced by sharp chords; exact corner vertices work. |
| `M-1-1404-real-outer-sampled-inner.ncep` | `M-1-1404` | U | loads/saves | Real outer + sampled inner; the inner section path is irrelevant. |
| `M-3-1407-real-section.ncep` | `M-3-1407` | I | invalid cut | Our UB part + real section; still has a front cut/beam edge issue. |
| `M-35-1305-our-part-real-section.ncep` | `M-35-1305` | M | loads/saves | Our M-35 part + real arc section; looks pretty much identical. |
| `M-35-1413-real-outer-sampled-inner.ncep` | `M-35-1413` | M | loads/saves | Real outer + sampled inner tube section; inner path irrelevant. |
| `M-42-1416-real-section-no-mark.ncep` | `M-42-1416` | M | wrong geometry | Our M-42 part + real section, no mark; 45° sharp edges point at the mitre/end cut. |

## Takeaways

1. The **outer section path must use exact corner vertices**. Dense sampled polylines fail even
   when they approximate the same arcs.
2. True arcs are **not** required: sharp chords between exact vertices work (`1403`).
3. The **inner section path is irrelevant** to the wrap (`1404`, `1413`).
4. UB has a separate **front trim/hole/mark** issue not fixed by the section (`1407`).
5. M-42 has a separate **mitre/end-cut** issue (`1416`).
