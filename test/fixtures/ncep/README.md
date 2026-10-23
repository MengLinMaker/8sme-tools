# WiseCAM NCEP references — DO NOT DELETE OR EDIT

These `.ncep` files are **import ground truth**. Git already keeps history, but this directory
also has a hash manifest and a guard test (`src/lib/wisecam/referenceFixtures.test.ts`) so that
deleting, renaming or silently rewriting a reference fails the suite instead of just losing a
sample.

## Layout

| Path | What it is |
| --- | --- |
| `M-*.ncep` | **17 real exports** from WiseCAM for the 2 Hidden Grove job (PFC, UB, SHS/RHS, T). Every one imports on the machine; the ZIP dialect is WiseCAM/Qt's own. |
| `M-*.nc1` | DSTV NC for five of the real exports, used to reproduce their geometry. |
| `working/` | Generated packages **confirmed to import** on the machine: `30` (real byte copy), `30b` (real rezipped), `31`/`32` (technology-ID variants) and `77` (our writer with Qt metadata). |
| `manifest.json` | SHA-256, byte size and path for every `.ncep` above. |

The real exports are the authority for ZIP order, flags/attributes, `CadRoot.xml`, `ncex.opf`,
Adobe/part SVG structure and `technologyID`. Keep them even when a newer generated package
supersedes them: they are the control group every probe result is compared against.

## Adding a reference

Only add a file after it has **imported successfully in WiseCAM**. Then regenerate the manifest:

```sh
node -e '
const fs=require("fs"),c=require("crypto"),p=require("path");
const root="test/fixtures/ncep";
const files=[];
(function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=p.join(d,e.name);
if(e.isDirectory())walk(f);else if(e.name.endsWith(".ncep")){const b=fs.readFileSync(f);
files.push({path:p.relative(root,f),sha256:c.createHash("sha256").update(b).digest("hex"),bytes:b.length});}}})
(root); files.sort((a,b)=>a.path.localeCompare(b.path));
fs.writeFileSync(p.join(root,"manifest.json"),JSON.stringify({note:"Do not delete or rewrite these files. Zipped with the real WiseCAM dialect; used as import ground truth. The guard test fails if a file disappears or changes.",files},null,2)+"\n");
'
```

Record why it is known-good in this README and in `docs/ncep-probe-log.md`; an unverified probe
is not a reference.
