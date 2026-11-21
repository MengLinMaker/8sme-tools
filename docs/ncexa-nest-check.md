# Nesting counts (`.ncexa`)

Two tools read WiseCAM nest packages (`.ncexa` / `.ncex` with `Results`):

- **Nesting counts** tab — drop nestings and count the pieces under each `Part.Name` **as
  written**. It deliberately does **not** try to match those names to a project: WiseCAM and
  Tekla spell the same mark inconsistently (`M_29` / `M-29`, `ITEM 35` /
  `12095, ITEM 35, …`), so matching is unreliable.
- **`pnpm nest-check`** — the CLI checks one package (or a folder against a reference package)
  for internal consistency and reports the quantified findings.

## The quantity model

Confirmed against all 43 beam-nesting exports in `~/Downloads/j12095` (UB/PFC/SHS/angle,
1–36 parts per package):

| Field | Meaning |
|---|---|
| `Part.TotalCount` | quantity at the time the batch was imported (scoped — not a job total) |
| `Part.NestedCount` | WiseCAM's own nested total for the project |
| `Result.params.PartInfo` | `(partId,count)…` — pieces of each part on **one stock bar** |
| `Result.params.Count` | how many stock bars of that layout |
| `<resultId>_0.svg` | the nest drawing; one `cadpart` instance per placed piece |

The identities that hold in every real export:

```
nested(part) = Σ_result  PartInfo[part].count × Result.params.Count
nested(part) = Part.NestedCount
drawn(part)  = PartInfo[part].count          (per bar — never × Count)
```

`<Result count="2">` (the XML attribute) is **not** a quantity multiplier. The multiplier is
the `Count=` entry inside `params`, next to `PartInfo`. `PartInfo` may list the same part more
than once on a bar (e.g. `(1522490,1)(1522490,1)`); those entries add up.

## The Nesting counts tab

- Reads every `Part.Name` exactly as WiseCAM wrote it (trimmed), including names that have no
  result — those show `0`.
- Counts `Result.PartInfo × Count` per name. A name can appear in several nestings; the pieces
  add up. The same result exported twice is counted once (`duplicate-result`).
- Counts use only the **selected** files. A file tree with folder/file checkboxes lets you cherry-pick;
  new drops append to the list (a re-dropped path replaces that package). Folders show a
  tick / mixed-line / empty box and can be collapsed from the chevron or folder name; the
  checkbox alone selects. `All` / `None` / `Clear` are one click away.
- The **Files** tree and **Parts** table sit side by side on wide screens and fill the available
  height (each scrolls internally). Hovering a nesting temporarily boosts its parts to the top
  and highlights the folders/files it touches; hovering a part boosts and highlights the
  nesting file(s) that name it.
- Lists every part name with **as written**, nested pieces, and how many selected packages contain
  it. Columns sort by name, nested pieces, or package count.
- Reports unnamed parts separately; it never invents a mark.
- Warns when a package has no `<Result>` at all (a CAD-only part export).
- Shows duplicate/conflicting result findings and parser problems.

Preflight stores `.ncexa` files in the project JOB list now, so the **Nesting coverage** card can
read them after reopening. Re-dropping a file/folder with matching paths replaces those entries.
A future pass can store a stripped-down summary instead of the raw package.

### Name matching

The **Nesting coverage** card under preflight Parts uses a rule with two regexes:

- **Clean** — global regex; removes `Modified`, `QIE`/`WELD`, or job-specific noise.
- **Extract** — first non-empty capture group is the key (`ITEM 35` → `item35`, `M_29` → `m-29`).

Keys are lower-cased and `_`/`-` are unified. Matching is exact after that; anything else is
listed as unmatched, and ambiguous names (two spellings collapsing to one key) are flagged. No
fuzzy matching is applied. A live preview (filterable by raw name/key/mark) shows exactly how
each name resolves; the rule is saved with the project.

The standalone Nesting counts tab keeps the same matcher as a paste-marks lab, below the counts.

## CLI (optional matching)

The CLI can still compare a package with its own declared `TotalCount`, or a folder against a
reference job package:

```bash
# Check every nesting under a job folder
pnpm nest-check -i ~/Downloads/j12095

# Only list failing packages (default), plus passing ones
pnpm nest-check -i path/to/nests --all

# Check a set of nests against a job package's required quantities
pnpm nest-check -i path/to/nests --job path/to/job.ncexa

# Machine-readable report, and fail CI on warnings too
pnpm nest-check -i path/to/nests --job path/to/job.ncexa --json --strict
```

Per package it checks:

- `nested` vs `required` (`Part.TotalCount`) — `part-short` / `part-excess` / `part-not-nested`.
- `declared` (`Part.NestedCount`) vs `nested` — `nested-count-mismatch`.
- Each result drawing vs its `PartInfo` — `result-drawing-part` (or `result-drawing`).
- Unknown parts/adobes and malformed `PartInfo` — parse findings.

With `--job`, marks are matched after stripping WiseCAM/Tekla annotations
(`normalizeNestMark`): `T9-7 QIE？`, `B11-22 WELD QIE` and a leading `Modified ` reduce to the
base mark. This is a best-effort check, not the app's workflow. Exit code is `0` when every
package matches, `1` otherwise (`--strict` also fails on warnings).

## Real result (J12095)

The per-beam exports are consistent; two package findings are real:

- `PFC 150x75/Weld/T1-5.ncexa` — `T1-5`: nested **6**, required **18** (missing 12).
- `j12095.ncexa` — the project snapshot has 36 parts but only 4 nested (24 pieces).

In the counts tab, the whole-job package lists all 16 names it contains (e.g. `M_29 QIE`,
`M_30`, `M_37 QIE`), with `0` for names that have no result; the per-beam `M37.ncexa` adds its
own `M_37` row. The two spellings stay separate, exactly as written.

## Code

- `src/lib/wisecam/ncexParse.ts` — read-only nest package parser (adobes, parts, results,
  result-drawing instance count).
- `src/lib/wisecam/nestCheck.ts` — per-package and set checks, duplicate result handling.
- `src/lib/wisecam/nestSummary.ts` — raw-name extraction and per-name/per-package counts.
- `src/features/nest/NestPage.tsx` — the **Nesting counts** tab (`/nest`).
- `src/lib/audit/nestFiles.ts` — keeps `.ncexa` out of preflight projects.
- `src/lib/wisecam/nestCheck.test.ts` / `src/lib/wisecam/nestSummary.test.ts` — synthetic
  packages covering scoped `TotalCount`s, duplicate results, unnamed parts and CAD-only exports.
- `tools/nest-check.mjs` — CLI (loads the TypeScript through Vite, like the other tools).

Cross-refs: `docs/ncexa-format.md` (container/format), `docs/ncep-format.md` (single-part
package), `docs/wisecam-formats.md` §2 (quantity support per format).
