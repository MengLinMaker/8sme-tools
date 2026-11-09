# Cut-regime data spec — definitions & collection

Companion to `docs/cut-regime-models.md` (equations and trust tiers). This file defines
**what we record and what each label means**, so that every run is comparable and the maps
can be built from it. Data lives in `data/cut-regime/runs.csv`.

Status: **v0.4** (2026-11-09). Thresholds marked `TBD` are set from a calibration set,
not guessed. Change a definition only by editing this file and noting the change in §12.

---

## 1. Scope and fixed series

One **series** = one fixed combination of:

- optics (lens focal length, `optics_id`), nozzle (`nozzle_id`, diameter `d_n`), gas grade and purity,
- material grade and nominal thickness `t_nom`,
- feature type (`web` / `flange` / `wall`), and face (see §5),
- focus offset convention (§3.3).

Changing any of these starts a new series. Do not pool series in the same map.

Data rows are **one sample per line** (one straight cut sample, §4.1). Corners and curves are
separate feature classes (§7, §8) and are never averaged into straight-line data.

---

## 2. Units and conventions

| Quantity | Unit | Note |
|---|---|---|
| Power `P_W` | W | Measured/calibrated watts at the workpiece. Log `P_set_pct` as well. |
| Speed `v_m_min` | m/min | Shop unit. Convert to mm/s only in formulas. |
| Thickness `t` | mm | **Measured** with calliper at the cut, not catalogue. `t_nom` is the catalogue value. |
| Gas pressure `gas_p_bar` | bar | At the head. **State gauge (barg) or absolute (bar abs)** in the series header. Shop values are unstated; see models §5. |
| Focus `focus_f_mm` | mm | Physical: **negative = below the top surface** (shop practice: inside or past the material), positive = above. The controller/CAM value is recorded separately in `cam_focus_mm`. |
| Standoff `standoff_h_mm` | mm | Nozzle tip to surface. |
| Energy $S_{\mathrm{beam}}$ | J/mm² | $S_{\mathrm{beam}} = 0.06\,\dfrac{P_W}{v_{\mathrm{m/min}}\,t_{\mathrm{mm}}}$. **Beam-only** — default $S$. |
| Energy $S_{\mathrm{eff}}$ | J/mm² | Only if oxidation energy is estimated (models §2: $P_{\mathrm{eff}} = \eta_{\mathrm{abs}}P + P_{\mathrm{ox}}$). Leave blank otherwise. |

**Rule:** every table, plot and comparison states whether S is `S_beam` or `S_eff`.
Default is `S_beam`.

**Sign and direction:** travel direction is always the direction of the beam path on the
machine (see §7). Record it, do not infer it later.

---

## 3. Settings that must be recorded

### 3.1 Per run (in `runs.csv`)
`P_set_pct`, `P_W`, `v_m_min`, `focus_f_mm`, `gas_p_bar`, `standoff_h_mm`, `gas_purity_pct`.

### 3.2 Per series (in the series header, §10)
`optics_id`, `nozzle_id`, `nozzle_dn_mm`, `gas_grade`, `material_grade`, `t_nom_mm`,
`section`, `feature`, machine id, date, operator.

### 3.3 Focus convention
Focus is measured from the **top surface** of the workpiece at the cut location.
Physical sign: **negative = focus below the top surface** (shop practice: inside or past the material),
positive = above. The controller/CAM value is logged separately in `cam_focus_mm`. If the height sensor reads from the web or
a recessed channel, note it: it changes the effective focus (see `cut-regime-models.md` §8).

---

## 4. Samples and windows

### 4.1 Straight-cut sample
- A straight segment of at least **40 mm** long, steady-state.
- **Sample window:** the middle **20 mm**, excluding the first and last **10 mm**
  (run-in and run-out). Record `cut_length_mm` and `sample_window_mm`.
- The window must be on a single face and feature. No corner, no fillet, no hole in the window.

### 4.2 One face at a time
A UB/T/PFC web and flanges are separate samples. Each face (`kept` / `scrap`, §7) is
graded separately.

### 4.3 Don't judge in the window alone
Record the whole cut (dross, bridging, separation) but grade the edge in the window.

---

## 5. Cut outcome — `through_code` (one per sample, mutually exclusive)

| Code | Name | Criterion (apply in order, take the first that matches) |
|---|---|---|
| **N0** | No penetration | No light passes through the kerf over the window. |
| **N1** | Through, bridged | Full-thickness kerf (light passes) but the piece is still joined by melt, slag or a bridge. |
| **N2** | Forced separation | Separates only with hand force, a tap, or a hammer. |
| **N3** | Free separation | Releases by gravity or minimal handling; **no tool, no hammer, no tearing**. |

Decision rules:

- **"Cut"** in the PDF sense (penetration boundary, `S_min`) = **N1 or better**, continuous
  through-kerf.
- **"Separated"** (usable part) = **N3**.
- **Hammering** = N2, always. Record `hit_count`.
- **Tearing a melted bridge** = N2 (`force_method = tear`). Record whether it leaves a spike
  or torn edge in `tear_flag`.
- **"Easily"** means N3 with a defined handling test: lift the piece off the bench, or let it
  drop from the clamp after release, within **5 s**. Anything needing more is N2.
- If the piece stays on the clamp or on the kerf after unclamping, it is **not** N3.

Fields: `through_code`, `force_method` (`none` / `hand` / `tap` / `hammer` / `tear`),
`hit_count`, `bridge_type` (`none` / `melt` / `slag` / `mixed`), `tear_flag` (0/1).

---

## 6. Edge quality (apply to N2 and N3 only)

Edge quality is **several separate measurements**, not one score. ISO 9013 quality grades
(thermal-cut surfaces, roughness Rz5 and perpendicularity) are the reference for comparing with
industry. Verify the grade table against the standard before quoting it.

### 6.1 Zones
Grade every quality parameter in three zones down the thickness:

- **top** — entry, upper third
- **mid** — middle third
- **bot** — run-out, lower third

Striation commonly starts fine at the top and coarsens toward the bottom. A single average
hides that.

### 6.2 Striation
Visual, under **10×** magnification with raking light.

| Grade | Description |
|---|---|
| `S0` | None visible, even in raking light. |
| `S1` | Fine lines visible only in raking light. |
| `S2` | Lines visible in normal light. |
| `S3` | Deep, coarse striation, clearly visible. |

Also record, for `S2`/`S3` only, **striation pitch** (mm, perpendicular to beam, mean of $\ge 5$
lines) and **depth** (`rz_<zone>_um`, measured on the edge profile or by comparator
gauge where a profilometer is not available).

### 6.3 Mirror
**Mirror** = $S0$ in **all three zones** **and** $rz \le \text{TBD}$ in all zones.
`TBD` is set from the calibration set (§11) — do not fill it in from a published number.

`mirror_flag` = 1 only if both conditions hold. `mirror_flag` = 0 otherwise.

### 6.4 Dross
Dross is attached material on the **bottom (exit) edge**.

| Grade | Meaning |
|---|---|
| `D0` | None. |
| `D1` | Loose — brushes or drops off with a fingernail. |
| `D2` | Adherent — needs a tool (scraper). |
| `D3` | Hard — cannot be removed without damage. |

Record `dross_grade` (worst in the window) and `dross_height_mm` (optional, measured).

### 6.5 Oxide colour (heat tint)
`bright` / `straw` / `blue-brown` / `black`. Record once per sample on the **kept** face.

### 6.6 Taper and burr
- `taper_deg` — kerf angle from the perpendicular, measured on the kept face (°).
- `burr` — 0 none, 1 present (note position in `notes`).

### 6.7 Perpendicularity and dimensional check (optional, when measured)
- `perp_deg` — angularity of the cut face to the surface.
- `kerf_w_mm` — kerf width, if measurable.

---

## 7. Face, side and direction

- **`face`** — which profile face of the beam is cut: `web` (`v`/`h` in DSTV terms), `flange`
  (`o`/`u`), or `wall` (tube/SHS side). Follow `docs/canonical-orientation.md` §3 for the map to
  DSTV letters.
- **`kept` / `scrap`** — the face is on the piece we keep, or on the piece we throw away. The two
  faces of one kerf differ, so log which one is graded.
- **`direction`** — travel direction on the machine: `+x`, `-x`, `+y`, `-y` (or `CW` / `CCW`
  for curves). Always log, never infer.

---

## 8. Curves and corners

### 8.1 Curves
- `curve_side` — `inside` or `outside` of the curve, relative to the **kept** piece.
- `curve_radius_mm` — radius of the curve at the sample window.
- Curves are a **separate class** (`feature_class = curve`). Grade them with the same
  rubric, compared with a straight baseline cut in the same series.

### 8.2 Corners
Corners are their own class (`feature_class = corner`). Never average them into straight data.

- `corner_type` — `convex` (outside corner of the kept piece) or `concave` (inside corner).
- `corner_angle_deg` — 90 for most sections; record actual.
- `corner_radius_mm` — 0 if sharp.
- `approach_v_m_min` — speed before the corner.
- `dwell_ms` — any programmed dwell or power ramp at the corner (0 if none).
- Grade within **±5 mm** of the corner vertex and compare with the straight baseline cut in the
  same series.

---

## 9. Feature class (required on every row)

`feature_class` ∈ `straight` · `curve` · `corner` · `hole` · `end` (end-cut or run-out only).
Only `straight` rows feed the first map set. Others feed later maps (§12).

---

## 10. Series header

Series fields are **repeated on every row** of `runs.csv` (flat CSV, no header blocks), so each
row is self-describing. Fields: `series_id`, `machine`, `optics_id`, `nozzle_id`, `nozzle_dn_mm`,
`gas_grade`, `gas_purity_pct`, `material_grade`, `section`, `t_nom_mm`, `feature`, `date`, `operator`.
Fill `TBD` where a value is not yet known; do not guess.

Column order is fixed; the full header is the first line of `data/cut-regime/runs.csv`.
Blank = not measured or not applicable. Never put commas inside a field (use `;`).

## 10a. Pilot series `S01_150UB14_web` (planned, not yet run)

Nine planned rows in `runs.csv` (R01–R09): five speeds at 3000 W (S sweep, R01/R03/R05/R06/R07),
two power checks at v = 2.8 m/min (R02 at 2400 W, R04 at 3600 W), and three runs at the centre
point (R06, R08, R09: 25%, 3000 W, 2.8 m/min). R06 is the baseline; R08 and R09 are repeats for
run-to-run and grader repeatability. Planned S_beam values are in each row's `notes`. Run in a random order
(not R01 to R09) and record actual execution order in `date`/`notes`.

Before running: confirm the % → W mapping (the pilot assumes 25% = 3000 W) and fill the
TBD fields.

---

## 11. Calibration set (to set `TBD` thresholds)

Before the first map:

1. Cut 5 samples spanning from clearly striated to clearly mirror, on one series.
2. Grade them blind (another person scores `S` grades and `through_code`).
3. Measure `rz` on each zone with the same instrument.
4. Set the mirror `rz` threshold at the value that best separates `S0` from `S1`/`S2`.
   Record the chosen value and the date in §12.

If two graders disagree on `S` grade by more than one step, retrain on the reference set
before collecting.

---

## 12. Change log

| Date | Version | Change |
|---|---|---|
| 2026-11-09 | v0.1 | First draft. Outcome codes N0–N3, striation S0–S3, dross D0–D3, zones, curve/corner classes. Mirror `rz` threshold TBD. |
| 2026-11-09 | v0.2 | Pilot centre-point count corrected (three runs). Paper sheet moved to `cut-regime-data-sheets.md`. |
| 2026-11-09 | v0.4 | Focus sign set to physical (negative = below top surface, shop practice). `cam_focus_mm` column added to `runs.csv`. |
| 2026-11-09 | v0.3 | Gas pressure gauge/absolute stated. Sheet 0 gains gas grade, pack ID and pack pressure, and a focus-sign check. |

---

## Appendix A — Paper sheets

Moved to `docs/cut-regime-data-sheets.md` (Sheets 0–4). That file is the only printable form,
so the spec and the sheets cannot drift apart.
