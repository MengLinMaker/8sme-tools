# Cut-regime data collection sheets

Printable sheets for the cut-regime test programme. Definitions and code meanings are in
`docs/cut-regime-data-spec.md`. This file is only the forms.

Use one **Sheet 0** per series, one **Sheet 1** line per sample, and one **Sheet 2** grading card
per sample. **Sheet 3** is the calibration set, once per series.

Transcribe to `data/cut-regime/runs.csv` at the end of each shift. Keep the paper originals.

---

## Sheet 0 — Series header (one per series)

```
SERIES ID  ____________________     DATE ____________   OPERATOR ____________
MACHINE    KL-90010-T              SHIFT / AMBIENT TEMP ____________

OPTICS (lens focal length)  ____________   optics_id  ____________
NOZZLE  ID ____________   dn ______ mm   standoff reference: tip to surface
FOCUS SIGN CHECK  physical: NEGATIVE = below top surface (shop practice), POSITIVE = above
                  controller value entered ______   controller sign setting ______ (repo assumes -1)
                  test: cut a focus pair (e.g. -2 and +2 on one series) and record which gives the cut we expect
GAS     supplier Supagas   pack type [ ] 12-pack  [ ] other ________
        grade [ ] Industrial >99.5%  [ ] HP >99.8%  [ ] other ________   purity (cert) ______ %
        pack ID ____________   pack pressure at start ______ bar   at end ______ bar
        head pressure reading  [ ] gauge (barg)  [ ] absolute (bar abs)   value ______ bar

MATERIAL  grade ____________   t_nom ______ mm (catalogue)
SECTION   ____________ (e.g. 150UB14)
FEATURE   [ ] web   [ ] flange   [ ] wall (tube/SHS)   [ ] other ________
FACE      [ ] kept side graded   [ ] scrap side graded

FOCUS REFERENCE: top surface at cut location.   Height sensor source ____________
% -> kW CALIBRATION: date ________  method ____________  verified [ ] Y  [ ] N
```

---

## Sheet 1 — Run log (one line per sample)

Fill in the run order as executed, not as planned. Put "—" where a field is not applicable. Do
not leave blanks silently.

| Run | Time | P% | P_W | v m/min | f mm | p bar | h mm | t meas mm | Face | Dir | Class | Cut len mm | Through N0–N3 | Force | Hits | Bridge | Tear Y/N |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | | | | | | | | | |
| | | | | | | | | | | | | | | | | | |
| | | | | | | | | | | | | | | | | | |
| | | | | | | | | | | | | | | | | | |
| | | | | | | | | | | | | | | | | | |
| | | | | | | | | | | | | | | | | | |
| | | | | | | | | | | | | | | | | | |
| | | | | | | | | | | | | | | | | | |

Codes:

- **Face:** W (web), F (flange), L (wall/tube side). Add K (kept) or S (scrap).
- **Dir:** +x / −x / +y / −y (or CW / CCW for curves).
- **Class:** ST straight · CV curve · CN corner · HO hole · EN end.
- **Force:** none / hand / tap / hammer / tear.
- **Bridge:** none / melt / slag / mixed.

**Handling test (N3):** lift the piece off the bench, or let it drop from the clamp after release,
within **5 s**, with no tool. Anything else is N2.

---

## Sheet 2 — Grading card (one per sample, kept face unless stated)

```
RUN ________   SERIES ________   FACE  [ ] kept  [ ] scrap      CLASS ________

WINDOW: middle 20 mm of straight cut (excluding first and last 10 mm)
        [ ] corner / curve sample: distance from vertex ______ mm

PENETRATION & SEPARATION
  Through code:   N0   N1   N2   N3        Force:  none / hand / tap / hammer / tear
  Hits: ______     Bridge: none / melt / slag / mixed     Tear spike:  Y / N

STRIATION (raking light, 10x)      top        mid        bot
  Grade S0 / S1 / S2 / S3          ____       ____       ____
  Pitch (mm, S2/S3 only)           ____       ____       ____
  Depth Rz (um)                    ____       ____       ____

MIRROR
  All zones S0 and Rz < TBD?       [ ] Y   [ ] N  (TBD = ______ um, from calibration)

DROSS (bottom edge, worst in window)
  D0 none   D1 loose   D2 adherent   D3 hard        Height (mm, optional) ______

OXIDE (kept face)     [ ] bright   [ ] straw   [ ] blue-brown   [ ] black

TAPER ______ deg     BURR  [ ] none   [ ] present (position ________)
PERP ______ deg (optional)     KERF W ______ mm (optional)

PHOTO REF ______________     GRADED BY ______________   BLIND TO SETTINGS  [ ] Y  [ ] N
NOTES ________________________________________________________________________
```

Grading rules:

- Grade the **window** only, but record dross and bridging for the whole cut.
- Use **raking light at 10×** for striation. Check all three zones.
- A grader who knows the settings must say so. Blind grading is preferred for calibration.
- If two graders differ on the striation grade by more than one step, re-check before logging.

---

## Sheet 2a — Curve and corner add-on

Fill in only when the sample is `CV` or `CN`. Attach to the Sheet 2 card.

```
CLASS:   CV curve   [ ] inside   [ ] outside (relative to kept piece)   radius ______ mm
         CN corner  [ ] convex   [ ] concave   angle ______ deg   radius ______ mm

APPROACH SPEED ______ m/min    DWELL / RAMP ______ ms (0 if none)
DIRECTION  [ ] CW   [ ] CCW   [ ] other ________

GRADE within +-5 mm of vertex:   top ____  mid ____  bot ____
COMPARE with straight baseline cut on the same series:  [ ] better  [ ] same  [ ] worse
```

---

## Sheet 3 — Calibration set (once per series, before the map)

Purpose: set the mirror Rz threshold (spec §11). Use five samples that span striated to mirror
on one series.

```
CAL SERIES ______________    DATE ____________    GRADER A ______   GRADER B ______

SAMPLE   Set (P_W, v)   Grader A striation (top/mid/bot)   Grader B striation   Rz top/mid/bot (um)
C1   ____________        ______ / ______ / ______       ______ / ______ / ______     ____/____/____
C2   ____________        ______ / ______ / ______       ______ / ______ / ______     ____/____/____
C3   ____________        ______ / ______ / ______       ______ / ______ / ______     ____/____/____
C4   ____________        ______ / ______ / ______       ______ / ______ / ______     ____/____/____
C5   ____________        ______ / ______ / ______       ______ / ______ / ______     ____/____/____

Agreement: grades within one step?    [ ] Y   [ ] N  (N = retrain before collecting)
Rz instrument ____________   calibrated date ____________
Chosen mirror Rz threshold: ______ um      Rationale (S0 vs S1/S2 separation) ____________
Date of decision ____________   Signed ____________
```

---

## Sheet 4 — Pilot checklist (S01_150UB14_web)

Run in random order. Tick when done.

```
[ ] Sheet 0 complete; TBD fields filled (optics, nozzle, gas, focus, standoff, gas p)
[ ] $\%$ $\rightarrow$ kW confirmed (measure, do not assume 25% = 3000 W)
[ ] t_meas measured on the part, not catalogue
[ ] Sample length $\ge 40$ mm, window clear of corners, holes and fillets
[ ] Run order randomised: ____________________________________
[ ] R01  [ ] R02  [ ] R03  [ ] R04  [ ] R05  [ ] R06 (centre)  [ ] R07  [ ] R08 (centre)  [ ] R09 (centre)
[ ] Each cut graded blind on Sheet 2 by two graders for at least the centre points
[ ] Photos taken before handling (photo ref recorded)
[ ] Transcribed to runs.csv
```

---

## Quick code reference

| Field | Codes |
|---|---|
| `through_code` | N0 no penetration · N1 through, bridged · N2 forced separation · N3 free separation |
| `force_method` | none · hand · tap · hammer · tear |
| `bridge_type` | none · melt · slag · mixed |
| `striation` | S0 none · S1 raking light only · S2 normal light · S3 deep, coarse |
| `dross_grade` | D0 none · D1 loose · D2 adherent · D3 hard |
| `oxide_colour` | bright · straw · blue-brown · black |
| `feature_class` | straight · curve · corner · hole · end |
| `face` | web · flange · wall |
| `kept_scrap` | kept · scrap |
