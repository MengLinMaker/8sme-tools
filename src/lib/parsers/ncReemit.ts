import { parseDstv, splitDstvBlocks } from './dstv'

/**
 * Re-emits a DSTV `.nc1` as a fresh file from our own parser/writer rather than passing the raw
 * Tekla bytes straight through.
 *
 * Every block — the `ST` header, the `AK`/`IK` contours, the `BO` holes, the marking blocks — is
 * parsed (so a malformed file throws instead of being shipped) and re-serialised in its original
 * order. The data lines are written back verbatim, so the extra DSTV columns (vertex radii, welding
 * bevels, slot vectors, reference-edge suffixes) survive unchanged.
 */
export function reemitPartNc(text: string): string {
  if (!/^\s*ST\s*$/m.test(text)) {
    throw new Error('not a DSTV NC file: no ST header')
  }
  const blocks = splitDstvBlocks(text)
  parseDstv(text)
  const out: string[] = []
  for (const block of blocks) {
    out.push(block.code)
    for (const line of block.lines) out.push(`  ${line}`)
  }
  return out.join('\r\n')
}
