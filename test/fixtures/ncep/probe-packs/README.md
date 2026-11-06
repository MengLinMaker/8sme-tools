# NCEP probe packs

Generated WiseCAM acceptance packs, kept with the code so each generation is reproducible and
diffable.

- `ncep-probes-round12-20261106.zip` — 56 probes: RHS/SHS end-cut isolation, layer-4/6 etch
  forms, etch position, bar orientation/Segment, text angle/size/layer, quantity, flipFlanges,
  empty holes/marks, M-39 new-size isolation, and real corrected-marking exemplar controls.

Regenerate with:

```sh
WRITE_NCEX_PROBES=/tmp/ncep-probes-round12 \
  pnpm exec vitest run src/lib/wisecam/probes.round12.test.ts
```

The old round-11 probes (`2500`/`2600` series) are included in the round-12 zip; their generator
remains in `probes.round11.test.ts` for reference.
