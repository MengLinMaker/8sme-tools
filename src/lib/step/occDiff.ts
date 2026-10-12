import { BufferGeometry, Float32BufferAttribute, type Matrix4 } from 'three'
import type { BooleanDiff, DiffSoup } from './booleanDiff'
import { meshStepFile } from './mesh'
import { ensureOc } from './occInit'

/**
 * Boolean difference of the two overlay models in the OCC B-rep kernel, with a **fuzzy tolerance**.
 *
 * Both models are imported as live OCC solids, seated into the viewer frame, and cut both ways.
 * `BRepAlgoAPI_Cut`'s fuzzy value merges faces within that distance before intersecting, so the
 * near-coincident reconstruction offset is absorbed by the kernel instead of becoming a thin skin —
 * what survives is the real gap. This is "diff with an extra margin" as a solid.
 *
 * - `over` (red): overcut — STEP − manufactured.
 * - `under` (blue): undercut — manufactured − STEP.
 */

/**
 * Requested coincident-face tolerance (mm). Kept large for the cleanest result; {@link occFuzzyDiff}
 * halves it automatically until the kernel returns a plausible solid (too large a value makes it
 * merge the whole near-coincident pair and return ≈ the entire operand — the instability).
 */
export const OCC_FUZZY_MM = 1
/** Smallest fuzzy tried before giving up (the caller then falls back to surface flagging). */
const MIN_FUZZY_MM = 0.03
/**
 * Candidate fuzzy values, largest first. The kernel's result is **non-monotonic** in the fuzzy value
 * (e.g. on m122, 0.3 and 0.1 mm are sane but 0.25/0.125/0.0625 return ≈ the whole operand), so a
 * plain halving miss the workable values — scan a spread and take the largest that validates.
 */
const OCC_FUZZY_STEPS = [1, 0.5, 0.3, 0.2, 0.1, 0.05, MIN_FUZZY_MM]

interface OcShape {
  wrapped: unknown
}

/** A shape's triangles in world coordinates (concatenated bodies). */
async function shapeToSoup(shape: unknown): Promise<DiffSoup> {
  const { cast } = await import('replicad')
  const wrapped = cast(shape as never) as unknown as { blobSTEP: () => Blob }
  const blob = wrapped.blobSTEP()
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const meshed = await meshStepFile('occ', bytes)
  const vertices: number[] = []
  const triangles: number[] = []
  for (const body of meshed.bodies) {
    const base = vertices.length / 3
    for (const v of body.mesh.faces.vertices) vertices.push(v)
    for (const t of body.mesh.faces.triangles) triangles.push(t + base)
  }
  return { vertices, triangles }
}

function geometryFromSoup(soup: DiffSoup): BufferGeometry | null {
  if (soup.triangles.length === 0) return null
  const positions = new Float32Array(soup.triangles.length * 3)
  for (let i = 0; i < soup.triangles.length; i++) {
    const source = (soup.triangles[i] ?? 0) * 3
    positions[i * 3] = soup.vertices[source] as number
    positions[i * 3 + 1] = soup.vertices[source + 1] as number
    positions[i * 3 + 2] = soup.vertices[source + 2] as number
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.computeVertexNormals()
  geometry.computeBoundingBox()
  return geometry
}

function signedVolume({ vertices, triangles }: DiffSoup): number {
  let volume = 0
  for (let t = 0; t < Math.floor(triangles.length / 3); t++) {
    const a = (triangles[t * 3] ?? 0) * 3
    const b = (triangles[t * 3 + 1] ?? 0) * 3
    const c = (triangles[t * 3 + 2] ?? 0) * 3
    volume +=
      ((vertices[a] as number) *
        ((vertices[b + 1] as number) * (vertices[c + 2] as number) -
          (vertices[b + 2] as number) * (vertices[c + 1] as number)) -
        (vertices[a + 1] as number) *
          ((vertices[b] as number) * (vertices[c + 2] as number) -
            (vertices[b + 2] as number) * (vertices[c] as number)) +
        (vertices[a + 2] as number) *
          ((vertices[b] as number) * (vertices[c + 1] as number) -
            (vertices[b + 1] as number) * (vertices[c] as number))) /
      6
  }
  return Math.abs(volume)
}

/**
 * Runs the fuzzy boolean between the manufactured (`primaryBytes`) and STEP (`compareBytes`) models,
 * each seated by its viewer matrix. Returns the same shape as {@link BooleanDiff}, or null when the
 * kernel fails (the caller falls back to surface flagging).
 */
export async function occFuzzyDiff(
  primaryBytes: Uint8Array,
  compareBytes: Uint8Array,
  primaryMatrix: Matrix4,
  compareMatrix: Matrix4,
  fuzzy = OCC_FUZZY_MM,
): Promise<BooleanDiff | null> {
  await ensureOc()
  const { getOC, importSTEP } = await import('replicad')
  // The OCC instance is untyped in the bindings; the boolean classes are used directly.
  const oc = getOC() as any

  const toBlob = (bytes: Uint8Array) => new Blob([new Uint8Array(bytes)], { type: 'model/step' })
  const primary = (await importSTEP(toBlob(primaryBytes))) as unknown as OcShape
  const compare = (await importSTEP(toBlob(compareBytes))) as unknown as OcShape
  try {
    const move = (shape: OcShape, m: Matrix4): unknown => {
      const e = m.elements
      const trsf = new oc.gp_Trsf()
      // gp_Trsf stores the 3×4 (rotation | translation) row-major; Matrix4 is column-major.
      trsf.SetValues(e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14])
      return new oc.BRepBuilderAPI_Transform(shape.wrapped, trsf, true).Shape()
    }
    const made = move(primary, primaryMatrix)
    const ideal = move(compare, compareMatrix)

    const primarySoup = await shapeToSoup(made)
    const idealSoup = await shapeToSoup(ideal)
    const madeVolume = signedVolume(primarySoup)
    const idealVolume = signedVolume(idealSoup)

    const cut = (a: unknown, b: unknown, f: number): unknown => {
      const op = new oc.BRepAlgoAPI_Cut(a, b)
      // Crucial: without this the boolean mutates its arguments in place, so reusing `made`/`ideal`
      // across the two cuts (and the fuzzy retries) corrupts them and the results go non-deterministic.
      op.SetNonDestructive(true)
      op.SetFuzzyValue(f)
      op.Build()
      if (!op.IsDone()) throw new Error('occ cut failed')
      return op.Shape()
    }

    // Auto-tune: scan candidate fuzzy values largest-first until both cuts return plausible volumes.
    // A cut that returns ≈ the whole operand (over ≥ ideal, under ≥ manufactured) is the kernel
    // merging everything — retry. The first plausible value wins, so the largest workable margin.
    for (const f of OCC_FUZZY_STEPS) {
      if (f > fuzzy) continue
      try {
        const overSoup = await shapeToSoup(cut(ideal, made, f))
        const underSoup = await shapeToSoup(cut(made, ideal, f))
        const overVolume = signedVolume(overSoup)
        const underVolume = signedVolume(underSoup)
        const sane =
          Number.isFinite(overVolume) &&
          Number.isFinite(underVolume) &&
          // A failed cut returns ≈ the whole operand ("over" ≈ ideal, "under" ≈ manufactured);
          // a real difference is strictly smaller than the model it is taken from.
          overVolume < idealVolume * 0.99 &&
          underVolume < madeVolume * 0.99
        if (!sane) continue
        return {
          over: geometryFromSoup(overSoup),
          under: geometryFromSoup(underSoup),
          overDistance: new Array<number>(Math.floor(overSoup.triangles.length / 3)).fill(f),
          underDistance: new Array<number>(Math.floor(underSoup.triangles.length / 3)).fill(f),
          overVolume,
          underVolume,
          primaryVolume: madeVolume,
        }
      } catch {
        // Try a smaller fuzzy.
      }
    }
    return null
  } catch {
    return null
  }
}
