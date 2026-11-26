# Convert tab — SAT / IGES → STEP

`/convert` is the app's format bridge for parts that WiseCAM cannot import. It runs entirely in the
browser: the file is read, converted and downloaded locally; nothing is uploaded.

## SAT (ACIS text)

SAT is the format the converter was built for. WiseCAM imports STEP, not SAT, and a modeller's SAT
often carries a cross-section that looks right but is **split** — a 90° root fillet exported as two
45° cylindrical faces (or, worse, chorded lines). WiseCAM then reads the part as a custom profile
instead of the standard section.

The tab uses the same logic as `pnpm sat-section` (`tools/sat-section.mjs`, `docs/sat-section.md`):

1. parse the SAT records (`point` / `vertex` / `edge` / `face` / curves / surfaces) — `src/lib/convert/sat.ts`;
2. take the edges at the square end and link them into one loop;
3. measure `d, b, tf, tw, r` from the fillet centres, which also identify the depth axis; when the
   corners are **chorded** (no circular edges), fall back to the loop bounds — the catalogue match
   supplies the arcs;
4. match a stock catalogue section (`inferSectionFromCross`);
5. seat the catalogue's **true-arc** contour in the SAT's own frame and verify the rebuilt outline
   against the source (`≤ 0.05 mm` for an arc section, `≤ 1 mm` for a chorded one, where the chords
   are the defect); a lookalike is refused;
6. extrude it, cut the preserved end planes (rakes about X or Y; a compound mitre is refused), write
   STEP (AP203, the schema WiseCAM's known-good Tekla exports use) and verify the output by
   measuring it and reading its section back.

The **Files** table keeps the operator-facing summary — section profile, length and a status
column — and lists the detected issues as pills. Selecting a file shows the same issues in full,
each with a fix, the same shape as a preflight part's findings:

- split fillets (`8 arc faces` for 4 corners) → **Rebuild with true arcs**;
- chorded corners (`0` circular edges) → **Rebuild with true arcs** (the catalogue arcs replace the
  chords);
- a section that matches nothing, an open/multiple loop, a compound mitre → an error with the
  reason and no automatic fix;
- a raked end is informational: it is preserved, so it is not treated as a defect.

After conversion the result table verifies the output: size, volume against the expected prism
volume, the number of arc faces (one per corner), the section detector's read-back and the
deviation from the SAT. A file that cannot be converted still shows its issues and the reason,
which is the point of the tab.

**Limitations** (refused rather than guessed):

- one solid extruded along Z (the SAT's own member axis);
- an I-section whose closed section loop has circular corners; other families and multiple loops are
  not measured yet;
- end cuts that rake about X or Y, not a compound mitre;
- SAB (binary ACIS) is not read — save as ACIS text (`.sat`).

## IGES

OCCT's IGES translator is open source, but the published `replicad-opencascadejs` build does not
compile it. Build an IGES-enabled kernel once:

```sh
pnpm build-iges-kernel
```

This links the same OCCT with `IGESControl_Reader` / `IGESControl_Writer` (config and wrappers in
`tools/occt-iges/`) and copies the resulting JS/WASM over the installed package. It needs Docker;
the image is amd64, so Docker Desktop must be running on Apple Silicon. The generated wasm is not
committed, so run it after a fresh install or a kernel upgrade. Restart the dev server (or run
`pnpm build`) afterwards.

The import is a real B-rep translation (`src/lib/convert/iges.ts`), not a mesh: lines, arcs,
B-splines and trimmed surfaces survive, and the output is written as STEP AP203. The tab reports the
number of IGES roots translated.

## STEP

A STEP input needs no conversion. The tab offers the existing **Clean STEP** operation (strip stray
bodies, punch through capped holes) and downloads the result; the pass-through download is always
available.

## True arcs

The true arcs come from the catalogue rebuild: the SAT's measured section selects the stock section,
and `sectionSketch` extrudes the catalogue primitives (one arc per corner), so the output has real
cylindrical faces rather than chords. The preflight viewer and ghost are unchanged.

## Files

- `src/features/convert/ConvertPage.tsx` — the tab.
- `src/lib/convert/sat.ts` — pure SAT parsing, measurement and rebuild planning.
- `src/lib/convert/satRebuild.ts` — the OCC prism rebuild + verification.
- `src/lib/convert/iges.ts` — raw `IGESControl_Reader` → `STEPControl_Writer`.
- `src/lib/step/stepWorker.ts` — `sat` / `iges` worker tasks (the OCC work never blocks the UI).
- `tools/build-iges-kernel.mjs` + `tools/occt-iges/` — the one-time custom kernel build.
- `test/fixtures/sat/150uc_3164.sat` — the documented UC sample, used by `sat.test.ts`.
