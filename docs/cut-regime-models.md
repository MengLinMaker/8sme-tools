# Cut-regime models — O₂ carbon steel

The equations behind the cut-settings suggestions, with each symbol explicit. These are
**starting models, not guarantees**. Most published experiments are flat plate and CO₂; a beam
section adds access effects (recessed web, far wall, 5-axis head) that act as a separate multiplier.

Companion files:

- `docs/cut-regime-data-spec.md` — definitions, outcome codes, and the data row schema.
- `docs/cut-regime-data-sheets.md` — printable collection sheets.
- `data/cut-regime/runs.csv` — the run log (one row per sample).
- §12 — proposed map views.
- §15 — verification log (what was checked against which source, and what changed).

Status: **v0.4** (2026-11-09). Changes from v0.3 are in §13.

## Trust tiers

- **T1 — exact / verified:** unit conversions, energy accounting, optics, machine facts.
- **T2 — supported / semi-empirical:** checked against a source, but the source is CO₂, flat plate,
  a different machine, or a different definition. Calibrate the numbers.
- **T3 — hypothesis / fit template / shop extrapolation:** useful, not laws.

## Regimes

The practical picture is a few regimes in `(speed, pressure, focus, power)` space:

- **N0 no penetration** — not enough energy to sever.
- **N1 through, bridged** — full kerf, still joined by melt or slag.
- **N2 forced separation** — separates only with force, tap, or hammer.
- **N3 free separation** — releases with no tool. This is the usable outcome.
- **Edge quality** (for N2/N3 only): striation (S0–S3, per zone), mirror, dross (D0–D3).

Outcome codes and the handling test are in `docs/cut-regime-data-spec.md` §5.

## Read this first

```
S = 0.06 · P / (v · t)          [J/mm²]
```

`P` = beam power in W · `v` = speed in m/min · `t` = thickness in mm · `S` = beam energy per unit
**cut-face area** (wall or flange area, `t` times length) in J/mm².

The 0.06 is exact: 1 m/min = 1000/60 mm/s, so `P / (v·1000/60 · t)` = `0.06·P/(v·t)`. (T1)

Worked example — 30% of 12 kW, 3.2 m/min, 5 mm web (assumes linear % → kW, unverified):

```
P = 0.30 × 12000 = 3600 W
S = 0.06 × 3600 / (3.2 × 5) = 13.5 J/mm²
```

**What `S` is and is not.** It is the beam energy per cut-face area. It is *not* the total energy
the process needs. Oxidation adds energy (§2), so the total is larger than `S`. The name
"severance energy" is ours; we have not confirmed it as a literature term.

### Which energy?

- **`S_beam`** — the default. Uses beam power `P`. This is what we measure.
- **`S_eff`** — uses an absorbed-plus-oxidation energy (§2). Only when the oxidation term is estimated.

Every table, plot and comparison states which one is used. Do not compare literature values
(often `S_eff`, flat plate, or CO₂) against shop `S_beam` without saying so.

## Symbols

| Symbol | Meaning | Unit |
|---|---|---|
| `P` | beam power (set/measured at the workpiece) | W |
| `v` | cutting speed | m/min (shop) or mm/s (SI) |
| `t` | material thickness (wall, flange or web) | mm |
| `S` | beam energy per unit cut-face area | J/mm² |
| `p` | assist-gas (O₂) pressure at the cutting head | bar (gauge or absolute: **to confirm**) |
| `f` | focus offset from the surface (positive = above) | mm |
| `d_f` | focused spot diameter (1/e² or D4σ — state which) | mm |
| `r_g` | focused spot radius, `d_f / 2` | mm |
| `z` | distance from the beam waist along the axis | mm |
| `z_R` | Rayleigh range (depth of focus) | mm |
| `λ` | laser wavelength (fibre ≈ 1.07 µm) | µm |
| `M²` | beam-quality factor (1 = perfect) | – |
| `I` | mean intensity over the spot (`4P/πd²`) | W/mm² |
| `η_abs` | absorptance: fraction of beam power absorbed by the cut front | – |
| `f_ox` | fraction of the removed iron that is oxidised to FeO | – |
| `ΔH_ox` | heat of Fe → FeO oxidation, ≈ 250 kJ/mol | J/mol |
| `P_ox` | power released by iron oxidation = `f_ox · ṁ_Fe/M_Fe · ΔH_ox` | W |
| `X_O2` | oxygen purity (0–1) | – |
| `w_k` | kerf width | mm |
| `α` | cut-front / taper angle | ° |
| `ρ_g` | assist-gas density | kg/m³ |
| `v_g` | assist-gas velocity at the kerf | m/s |
| `δ` | melt-film thickness | mm (not measured) |
| `γ` | molten-steel surface tension | N/m |
| `κ` | thermal diffusivity of steel (≈ 5.9 mm²/s, T2 — from a published iron value) | mm²/s |
| `h` | nozzle standoff | mm |
| `d_n` | nozzle diameter | mm |
| `Pe` | Péclet number, moving Gaussian source: `v·r_g/(2κ)` | – |
| `We` | Weber number (gas drag ÷ surface tension) | – |

**Symbol clash fixed in v0.3:** v0.2 used `η` as "coupling efficiency" and in the oxidation sum.
The literature uses `η` for different things (in one cutting model it is the *oxidised fraction*).
v0.3 splits them into `η_abs` and `f_ox`.

## Shapes at a glance

| Plot | Shape | What it tells you |
|---|---|---|
| `v` vs `t` at fixed `P` | hyperbola | thicker → slower |
| `v` vs `P` at fixed `t` | straight line through 0 | power buys speed proportionally |
| `log v` vs `log t` | straight line, slope −1 | the same-energy line |
| `S` vs `p` | island / lens | mirror window, bounded by striation and dross (T3) |
| focus vs quality | parabola | best focus near minimum roughness/dross (T3) |

## Worked examples from the shop

| Cut | Power | Speed | `t` | `S_beam` | Outcome |
|---|---|---|---|---|---|
| 150UB14 web, conservative | 25% = 3000 W | 2.0 m/min | 5 mm | **18.0** | good (shop label) |
| 150UB14 web, mirror (slightly unstable) | 30% = 3600 W | 3.2 m/min | 5 mm | **13.5** | mirror, unstable (shop label) |
| 6 mm SHS, primed | 25% = 3000 W | 2.0 m/min | 6 mm | **15.0** | good (shop label) |
| 10% test cut | 10% = 1200 W | 1.2 m/min | 6 mm | **10.0** | to be graded |

These are **shop labels, not graded outcomes.** They become data only once re-cut and graded with
the spec. The 13.5 cut shows that `S` alone does not separate mirror from unstable.

## 1. Energy and the penetration boundary

```
S = 0.06 · P / (v · t)          [J/mm²]          (T1)
v = 0.06 · P / (S · t)          [m/min]
P = S · v · t / 0.06            [W]
```

**No-cut boundary:** the cut needs `S ≥ S_min(t)`:

```
v ≤ 0.06 · P / (S_min(t) · t)
```

**Shape:** a hyperbola in `(v, t)`; a straight line through the origin in `(v, P)` at fixed `t`;
a straight line of slope −1 in `log v` vs `log t`. These follow from the algebra (T1).

**Fitting:** `S_min(t)` is empirical. Fit linear or power law (see §9).

## 2. Oxidation energy (oxygen reaction)

The iron–oxygen reaction adds heat. Powell et al. (2009) give the Fe → FeO enthalpy as
**≈ 250 kJ/mol** between the melting and boiling points of iron, and about 600 kJ/mol above the
boiling point (T1 for the number; T2 for applying it to a cut).

Rate of iron removed from the kerf, and the power from oxidising a fraction `f_ox` of it:

```
ṁ_Fe  = ρ_Fe · v · t · w_k          [kg/s]     ρ_Fe = 7874 kg/m³
P_ox  = f_ox · (ṁ_Fe / M_Fe) · ΔH_ox           M_Fe = 0.05584 kg/mol
P_eff = η_abs · P + P_ox
S_eff = 0.06 · P_eff / (v · t)
```

**What the sources say, and what they do not:**

- Powell (2009, CO₂): in a typical sample, *about half the iron in the cut zone* was oxidised to
  FeO. This is a fraction of **iron**, not of **energy**. The melt that leaves is an Fe/FeO mixture.
- A secondary source (KEM 442.81, 2010, citing other authors' models) puts the combustion
  contribution at **40–70%**, and one of those models used η = 50% **as the oxidised fraction**. So the
  "40–60%" figure in v0.2 mixed two quantities. Restated: the reported share of energy is
  roughly 40–70%, depending on source, speed and kerf (T2).
- Our estimate (5 mm, 25% = 3000 W, `f_ox` = 0.5, `ρ_Fe` and `ΔH` from Powell, assumed kerf):

| v (m/min) | kerf (mm) | P_ox (W) | P_ox ÷ P | `S_beam` | `S_eff` (η_abs = 1) |
|---|---|---|---|---|---|
| 2.0 | 0.2 | 588 | 0.20 | 18.0 | 21.5 |
| 2.0 | 0.3 | 881 | 0.29 | 18.0 | 23.3 |
| 2.8 | 0.3 | 1234 | 0.41 | 12.9 | 18.1 |
| 3.6 | 0.3 | 1586 | 0.53 | 10.0 | 15.3 |

Read this as: oxidation is a **significant, speed-dependent** term, and its share moves with kerf
width and `f_ox`, both of which we do not measure. A fixed "40–60%" is not a constant. The
kerf and `f_ox` values here are assumptions, so the table is an illustration, not a result (T2).

**Shape:** the apparent `S_min` falls as the oxidation share grows with thickness and oxygen supply.

## 3. Power density and focus

```
I = 4 · P / (π · d_f²)                          [W/mm²]
d(z) = d_f · √(1 + ((z − z₀) / z_R)²)
z_R  = π · w₀² / (M² · λ)                       // w₀ = d_f / 2, same length unit as λ
     = π · d_f² / (4 · M² · λ)
```

- **Verified (T1):** the Rayleigh range with M² and the waist radius is the standard Gaussian
  result (RP Photonics; Kogelnik & Li 1966; ISO 11146 for M²). The `π·d_f²/(4·M²·λ)` form is
  exact when `d_f` is the **waist diameter** and λ is in the same unit.
- **Correction (v0.3):** `I = 4P/(πd²)` is the **mean** intensity over the 1/e² diameter. The
  **peak** is `I₀ = 8P/(πd²)`, twice as large. Label every plot with which one is used.
- Diameter definition matters: 1/e² and D4σ agree for an ideal Gaussian and disagree for real
  beams. State which we use.

Use the **normalised focus** `f / d_f` rather than raw millimetres when comparing optics.

**Shape:** `I` peaks at the waist and falls as a hyperbola either side. Quality against focus is a
parabola with a minimum near the optimum (T3).

## 4. Striation-free / mirror boundary (semi-empirical, T3)

No universal closed form. The usual fitted form is a power law:

```
v_crit = C · (P / t)^a · p^b · (f / d_f)^c
log v_crit = log C + a·log(P / t) + b·log p + c·log(f / d_f)
```

- Context (T2): a review of thin-sheet mild steel O₂ cutting reports striation appearing at low
  speed and disappearing ("steady cutting") above a critical speed, quoted as about 2 m/min for
  thin sections. Our thick-section speeds (2–4 m/min) sit near or above that, so the trend is
  consistent. It is not a calibration for our 5–25 mm sections.
- The **mirror window** is `v_crit ≤ v ≤ v_dross`. Below `v_crit`, striation. Above `v_dross`,
  dross. On an `(S, p)` plot this is a **closed island** if both bounds are real.
- **Source check:** the primary paper, Sobih, Crouse & Li (2007), was **not accessible** (bot
  check). Its critical-speed model is unverified. Its scope is EN43, **1–2 mm**, **1 kW fibre**.
  It is not a source for 5–25 mm sections at 12 kW.

## 5. Dross / ejection boundary (semi-empirical, T2/T3)

```
We = ρ_g · v_g² · δ / γ
```

`δ` is not measured, so `We` cannot be computed from our logs. Use `p` and `v` as observable proxies
and treat `We` as a hypothesis.

Dross-free cutting needs enough gas momentum and pressure. Too much oxygen over-drives the
oxidation and causes striation and side burning. The boundary is commonly fitted as:

```
v_dross = C · (P / t)^a · p^b          (T3 fit template)
p_min(v, t) … p_max(v, t)
```

**Pressure reference (T2, checked):**

| Source | Process | Oxygen pressure |
|---|---|---|
| Powell et al. (2009) | CO₂, head supply | ≈ 1.0 barg for > 3 mm; up to ≈ 5.0 barg for thinner |
| Genna et al. (2020) | CO₂, O₂ assist | ≈ 0.2–0.6 bar, depending on thickness |
| Laser Focus World (2010) | fibre, 15 mm mild steel | 1.0 bar O₂, 1.5 mm nozzle, focus 7 mm below surface |
| **Shop** (`cutParams.ts`) | 12 kW fibre, 3–25 mm | 0.6–0.7 bar |

Our 0.6–0.7 bar is inside the wide literature range, but it is **below Powell's ≈ 1 barg for thick
sections**. The shop value is also ambiguous: gauge or absolute is not stated. Confirm which, and
measure it at the head (see §11).

**Shape:** a lens or ellipse in `(v, p)`: dross at low speed or low pressure, and again at excessive
speed.

## 6. Oxygen purity

```
v ∝ X_O2^n      (form is a T3 fit template; the steepness is what matters)
```

**What the source says:** Powell et al. (2009), citing Ivarson et al. (1993) and Powell et al.
(1992), report that **cut speed falls by 50% or more when O₂ purity drops by 3%**. Their data are
CO₂. (The v0.2 claim of "1.25% impurity halved speed" was **not supported** by this source and is
removed.) I have not found a fibre-laser purity curve, so the fibre sensitivity is unknown.

**Our gas (Supagas, verified from the Supagas oxygen technical sheet, 2018 version):**

| Grade | Typical purity | Notes |
|---|---|---|
| Industrial | > 99.5% | Diving-grade listed at the same level |
| HP | > 99.8% | < 10 ppm moisture |
| UHP | > 99.999% | not needed for cutting |

- **12-pack:** 124.0 m³ at 101.325 kPa, 15 °C; 600 L water capacity per pack (Supagas sheet).
  Pack pressure is not on the sheet we read. From 124 m³ and 600 L, the fill pressure is roughly
  200 bar absolute (T2 estimate, not from the sheet).
- **Run-time per pack:** `124 m³ ÷ Q`, where `Q` is the flow at the head. `Q` depends on pressure and
  nozzle, and we have not measured it. Measure `Q` (or the pack-pressure drop per shift) before
  quoting run-time.
- **Grade purchased: Industrial, >99.5% (decided, shop policy: cheapest grade).** Nominal
  `X_O2` = 0.995 for every row unless the batch certificate says otherwise.
- **Purity is not a test variable for us.** We cannot buy HP, so we do not need an HP-vs-industrial
  series. Record the certified purity per pack anyway (`gas_purity_pct`), because a bad batch
  changes speed.
- **Limit of our knowledge:** the −3% → −50% speed figure is at about 97% purity. We have no data at
  99.5%, so the size of the purity effect in our range is unmeasured.

## 7. Kerf

```
w_k ≈ d_f + 2 · t · tan(α)
```

`α` is the taper angle. It changes with speed, focus and pressure, and can change sign as the
focus passes through the thickness. The formula is a geometric approximation (T2).

## 8. Dimensionless groups

**Péclet number (corrected in v0.3).** For a moving Gaussian source, the standard form uses the
beam radius (Manca et al. 2007 COMSOL proceedings; arXiv 2202.06501):

```
Pe = v · r_g / (2κ)          r_g = d_f / 2
```

v0.2 used `v·d_f/κ` (wrong factor and sometimes the wrong length). v0.2's `v·t/κ` is **not** the
standard definition. Thickness belongs in a separate ratio, the aspect ratio `t / w_k`, if we use one.

Worked check (T2): with κ ≈ 5.9 mm²/s and a 0.2 mm spot (`r_g` = 0.1 mm):

| v (m/min) | Pe |
|---|---|
| 2.0 | 0.28 |
| 4.5 | 0.64 |

So in our speed range, Pe is below about 1 for a 0.2 mm spot. Whether Pe is the right collapse
variable for cutting is a hypothesis (T3). Test it, do not assume it.

```
Φ( S, Pe, We, f/d_f, h/d_n, X_O2 ) = 0       (T3 hypothesis)
We = ρ_g · v_g² · δ / γ                       (δ unmeasured)
```

If the groups match, the shape of the map should repeat across sections and machines (T3). The
coefficients still move with optics, nozzle and material.

## 9. Fitting recipe

1. Fix optics, nozzle, gas and material. Record them on every row.
2. Log each sample as per `docs/cut-regime-data-spec.md`: section, feature, face, `t`, `P`, `v`,
   `f`, `p` (with gauge/absolute), `h`, `d_n`, gas grade and purity, `S_beam`, outcome codes.
3. Outcome codes: `through_code` N0–N3, plus edge grades (`striation` per zone, `mirror_flag`,
   `dross_grade`). Do not use one "mirror / striated / dross" label.
4. Penetration: fit `S_min(t)` from N0 vs N1 (linear or power law).
5. Separation: N2 vs N3 gives the separation boundary, separate from penetration.
6. Mirror: logistic regression on `log S`, `log p`, `f/d_f` for the mirror flag. The 0.5 contour is
   the boundary. Needs about 30+ points per class, not 10–15.
7. Dross: fit upper and lower branches in `(v, p)`.
8. Do not extrapolate outside the tested window.

## 10. Trust tiers and fact-check

| Item | Tier | Status / note |
|---|---|---|
| `S = 0.06·P/(v·t)` unit conversion | T1 | Exact: 1 m/min = 1000/60 mm/s. |
| Rayleigh `z_R = πw₀²/(M²λ)`; `d(z)` | T1 | Standard Gaussian result; RP Photonics, Kogelnik & Li 1966. |
| `I = 4P/(πd²)` | T1 | Mean over 1/e² diameter; **peak is 2×**. Label which. |
| Penetration / no-cut boundary | T1 | Energy balance; only `S_min(t)` is empirical. |
| Fe → FeO enthalpy ≈ 250 kJ/mol | T1 | Powell et al. (2009), Guideline 5. |
| Oxidation share of energy 40–70% | T2 | Secondary citation (KEM 442.81). Not one number; kerf and `f_ox` dependent. |
| "Half the iron oxidised" | T2 | Powell (2009), CO₂ typical sample. Fraction of iron, not energy. |
| Purity: −3% → speed −50% | T2 | Powell (2009), citing 1992/1993 work. CO₂. |
| Pe = `v·r_g/(2κ)` | T2 | Moving Gaussian-source definition (Manca 2007; arXiv 2202.06501). Not cutting-specific. |
| Pe with thickness (v0.2 `v·t/κ`) | **removed** | Not a standard definition. |
| `We` (dross) | T2 | Standard Weber number; `δ` unmeasured. |
| Striation-free law and `v_crit` | T3 | Sobih et al. (2007) not accessible; scope 1–2 mm, 1 kW. |
| `v_dross` power law | T3 | Generic fit; calibrate on the machine. |
| Dimensionless collapse `Φ = 0` | T3 | Hypothesis. |
| `S` = 4–13 J/mm² for MS + O₂ | T2 | Published range, not verified against a primary source. |
| Shop good cuts 13–18 J/mm² | T3 | Small local dataset, not graded. |
| Focus sign: `cutParams.ts` table is `+` (above surface); shop practice is **below** surface | **open, likely table error** | Practice and one fibre source (`−7` below, 15 mm) agree. See §11. |
| O₂ pressure 0.6–0.7 bar | T2 | In literature range; gauge/absolute unknown; below Powell's thick-section value. |
| Purity sensitivity | T2 | See above. |
| Nozzle / surface rules | T1 (shop) | Shop practice, not literature. |
| `r/min = v/(2πR)` | T2 | Formula exact; `R` depends on the calibrated B-axis and eccentric. |
| "Flat plate" caveat | T1 | Confirmed scope of the published maps. |
| Calibrate `% → kW` | T1 | Must be measured; non-linearity shifts every `S`. |
| Mirror Rz threshold | TBD | Set from the calibration set (spec §11), not from literature. |

## 11. Beam-section caveats and machine facts

- The published maps are **flat plate and mostly CO₂**. A beam web is a recessed channel with
  different gas escape and height-sensor behaviour. Fibre and CO₂ may differ in absorption and in
  the oxidation share; we have not verified the size of that difference.
- Treat **external wall** and **recessed web** as separate series (an access factor on `S` or on
  `We`), not one curve.
- **Focus sign (shop practice confirmed by the user, v0.4).** The operator runs focus **below the
  top surface**, inside the material or past it. The data spec uses physical sign: **negative =
  below the top surface**, positive = above. Under that convention the practice is negative focus.
  The table in `src/lib/machine/cutParams.ts` stores **positive** focus (+4 to +12, "above the
  surface"), and `profile.ts` sets `focus.sign = -1` so the CAM receives negative values. Both
  conflict with the practice above, and with the fibre source that puts 15 mm mild steel at −7 mm.
  Likely cause: the table's sign is wrong, not the practice. **Do not change the code until a
  focus-sign test confirms it on the machine** (see sheet 0, focus sign check).
- **Machine documentation (corrected in v0.4).** The repo doc `docs/machine-kl90010t.md` is
  detailed on the **envelope** (length, diameter, thickness, bevel, nesting limits), and I verified
  those against the 8 Star page. It does **not** list laser source power, gas pressure range,
  nozzle list, or focus convention. Those figures are in `profile.ts` and `cutParams.ts` as code
  comments and table values, with no document behind them. The linked TubePro control manual
  (FSCUT, 66 pp, read) defines "Cut focus" (focus location in cutting) and "Cut PWR" (peak power)
  but gives no sign convention and no pressure units. Its gas page reads "actual pressure" from a
  DA output, so pressure needs a DA-to-bar calibration. The repo's controller name is Weihong
  WiseCAM/NcStudio, and the manual is FSCUT TubePro. **Confirm which controller is on the machine.**
  **Action:** photograph the laser source nameplate and the controller model plate.
- Calibrate the controller's `% → kW`. If it is non-linear, every `S` value shifts.
- The rotary axis is the calibrated B-axis centre, not necessarily the section centroid. The
  eccentric offset changes the radius used for `r/min`.
- **Corners and curves are separate feature classes** (spec §8).
- **Pressure unit (v0.4).** The shop states pressure in **bar**. Gauge or absolute is still not
  stated, and the TubePro gas page reads actual pressure from a DA output, so calibrate DA → bar at
  the head before using any value in a map.

## 12. Map views (proposed)

All maps are **planned, not built.** They need data first. Each map is for one series and states
its `S` basis and its pressure basis (gauge or absolute).

### 12.1 Operating map — `v` vs `P` at fixed `t` (primary)

The map an operator uses. Lines of constant `S` are straight lines through the origin.

```
P (W)
  4000 |                                       ..'
       |                                 ..-'''
  3000 |                           ..-'''   N3 free separation
       |                     ..-'''          (usable)
  2000 |               ..-'''   <- S_min boundary: N1 / N0
       |         ..-'''        -- lines of constant S --
  1000 |  ..-'''                S = 8, 10, 13, 18, 25 ...
       |-'  N0 no penetration
     0 +----------------------------------------------> v (m/min)
       0      1      2      3      4      5      6
```

- Hard boundary: the N0/N1 line through the origin (T1 energy balance, with `S_min` fitted).
- Second boundary: the N3/N2 line, same shape, higher `S`.
- Overlay quality classes as markers (S0–S3, dross, mirror).
- Operator view: pick a constant-`S` line and move along it.

### 12.2 Quality map — `v` vs `p` at fixed `P` and `t` (T3 shape)

Shows the mirror island and its limits. Needs the most data.

```
p (bar)
    hi |  over-oxidised   |  striation, side burn  |  dross (high v)  |
       |  (S0 lost)       |                        |                  |
       |------------------+------------------------+------------------|
    mid|  striated S2/S3  |  MIRROR island         |  dross (high v)  |
       |                  |  (S0 all zones, D0)    |                  |
       |------------------+------------------------+------------------|
    lo |  dross D2/D3     |  dross D1/D2           |  N2 / N1 (no sep)|
       +-------------------------------------------------------------->
                         v_crit             v_dross             v (m/min)
```

- Every cell label is a hypothesis (T3) until graded data sits in it.
- The mirror cell is only defined when `S0` holds in all three zones and `Rz` is under the
  calibrated threshold.

### 12.3 Contour map — quality as contour bands in `(S, p)`

Collapses `P`, `v`, `t` into `S`. Tests the "one number" claim.

```
p (bar)
  hi |  . . . . . . . . . . . . . . . . . .
     |  .  over-oxidised / brown (S > S_hi)  .
  mid|  ~~~~~~~~~ mirror island ~~~~~~~~~~~~~
     |  .  striated (S_lo < S < S_mid)      .
  lo |  dross bands (low gas momentum)
     +--------------------------------------------> S (J/mm²)
        S_min   10   13   18   25
```

- Test whether the mirror island collapses onto one `S` band across thicknesses. If not,
  oxidation share, `Pe` or `t` matter separately.
- Only valid if `S` is `S_beam` for the whole plot.

### 12.4 Zone map — quality by depth

One panel per series, edge quality from top to bottom of the wall.

```
depth        S0  S1  S2  S3    Rz (um)   dross
top   ▓▓▓▓▓░░░░░   ...
mid   ▓▓▓░░░░░░░   ...
bot   ▓░░░░░░░░░   ...
```

- Shows where striation starts and how it develops. A cut that is mirror only at the top is not a
  mirror cut.
- Small multiples: one panel per `(v, P)` setting, so the operator sees how zones change along a
  speed line.

### 12.5 Focus and pressure — small multiples (T3)

Focus against quality, one panel per pressure. The parabola's minimum should move with `t`. Needs
focus varied in the series, which the pilot does not do.

### 12.6 Feature and access split

Separate maps for each feature class (`straight`, `curve`, `corner`) and face (`web`, `flange`,
`wall`, `kept`/`scrap`). Do not overlay corner or curve points on straight-line maps.

### 12.7 Build order

1. **12.1 operating map** — needs only N0/N1/N3 and `S`.
2. **12.4 zone map** — needs three-zone striation grades (the spec records these).
3. **12.2 quality map** — needs about 30+ points per class and a calibrated mirror threshold.
4. **12.3 contour test** — only after 12.1 and 12.2 exist.

## 13. Change log

| Version | Change |
|---|---|
| v0.1 | Initial draft. Mirror/striated/dross labels; Pe with `d_f`; `S` defined per kerf area. |
| v0.2 | Outcome codes N0–N3 and edge grades. `S` as per cut-face area. Pe changed to `v·t/κ`. `S_beam` vs `S_eff` rule. Map views added. |
| v0.4 | Gas grade fixed to Industrial (>99.5%, shop policy). Purity removed as a test variable. Focus practice recorded as below surface (negative); `cutParams.ts` sign flagged as likely wrong. Pressure stated in bar, gauge/absolute open. Machine documentation status corrected (envelope documented; power, gas and focus not). TubePro manual checked. |
| v0.3 | **Source check.** Pe restored to the moving-source form `v·r_g/(2κ)`; v0.2 `v·t/κ` removed. Purity claim changed from "1.25% halved speed" to Powell's "−3% → −50%" (CO₂). Oxidation section rewritten: "half the iron" ≠ "40–60% of energy"; ΔH ≈ 250 kJ/mol added; `η` split into `η_abs` and `f_ox`; estimate table added. `I` labelled as mean; peak = 2×. Pressure compared with literature; gauge/absolute flagged. Focus-sign conflict flagged. Supagas 12-pack data added. Machine-documentation gap recorded. |

## 14. Sources and verification status

| Source | Used for | Status |
|---|---|---|
| Powell, Petring, Kumar, Al-Mashikhi, Kaplan, Voisey, *J. Phys. D* 42 (2009) 015504. <https://doi.org/10.1088/0022-3727/42/1/015504> | ΔH ≈ 250 kJ/mol; "half the iron oxidised"; purity −3% → −50% speed; pressure ranges; iron density | **Verified** (full PDF read). CO₂ data. |
| Supagas, *Oxygen* technical sheet (2018 version) | 12-pack volume, water capacity, grade purities | **Verified** (PDF read). Pack pressure not stated. |
| Supagas, *Specialty gases brochure* (2025) | Grade list, 12-pack listed | Verified (excerpt). |
| Sobih, Crouse & Li, *J. Phys. D* 40 (2007) 6908. DOI 10.1088/0022-3727/40/22/009 | Striation-free critical speed | **Not verified.** Publisher page blocked by bot check. Scope EN43, 1–2 mm, 1 kW. |
| Genna, Menna, Rubino, Tagliaferri, *Appl. Sci.* 10 (2020) 4956. DOI 10.3390/app10144956 | O₂ pressure 0.2–0.6 bar (CO₂) | Verified (abstract/excerpt). Full text not read. |
| KEM 442.81 (2010), *Role of Combustion Energy in Laser Cutting of Austenitic Stainless Steel* | 40–70% combustion share; η = 50% as oxidised fraction | Excerpt only; secondary for the 40–70% range. |
| Laser Focus World (2010), *Cutting thick section steel with fiber lasers* | Fibre thick mild steel: 1.0 bar O₂, focus −7 mm | Excerpt only. Different machine. |
| Manca et al., COMSOL Users Conference (2007); arXiv 2202.06501 | Pe = `v·a/(2κ)` for moving Gaussian source | Excerpt only. |
| RP Photonics, *Rayleigh length*; Kogelnik & Li (1966); ISO 11146 | `z_R = πw₀²/(M²λ)`; M² definition | Verified (excerpt). |
| Columbia NSF workshop, *Thermal aspects in laser materials processing* | Striation vs cutting speed ("steady cutting" above ~2 m/min, thin CO₂) | Excerpt only. |
| Chen & Yao (2000), *High Temp. Material Processes* 4, 227 | Reaction energy ≈ half at low speed | Excerpt only. |
| Ivarson et al. (1993); Powell et al. (1992) | Purity effect | Cited inside Powell (2009); not read directly. |
| 8 Star Metal Engineering, KL-90010-T page | Machine envelope | Verified (page read). No laser power or gas spec. |
| FSCUT TubePro Laser Cutting Control System User Manual (66 pp), <https://d.fscut.com/wordpress-fscut/2020/10/TubePro-User-Manual.pdf> | Controller parameters: Cut focus, Cut PWR, gas DA and pressure | Verified (PDF read). No focus sign convention; pressure from DA output. May not be the same controller as the machine. |
| `docs/machine-kl90010t.md` (repo) | Envelope and nesting limits | Verified against the 8 Star page. Contains no laser power, gas or focus spec. |
