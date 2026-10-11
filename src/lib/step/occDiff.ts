import { BufferGeometry, Float32BufferAttribute, type Matrix4 } from 'three'
import { type BooleanDiff, type DiffSoup } from './booleanDiff'
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
 * Faces closer than this (mm) are treated as coincident by the boolean.
 *
 * Keep small: sweeping m122, the cut is sane at 0.1–0.3 mm but produces garbage above ~0.4 mm
 * (under/over ≈ the whole ideal) because the fuzzy value exceeds what the near-coincident topology
 * can absorb. So this is a robustness floor, not a "margin" — it does not erase the ~1 mm
 * reconstruction wobble.
 */
export const OCC_FUZZY_MM = 0.3

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

  const toBlob = (bytes: Uint8Array) =>
    new Blob([new Uint8Array(bytes)], { type: 'model/step' })
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

    const cut = (a: unknown, b: unknown): unknown => {
      const op = new oc.BRepAlgoAPI_Cut(a, b)
      op.SetFuzzyValue(fuzzy)
      op.Build()
      if (!op.IsDone()) throw new Error('occ cut failed')
      return op.Shape()
    }

    const overSoup = await shapeToSoup(cut(ideal, made))
    const underSoup = await shapeToSoup(cut(made, ideal))
    const primarySoup = await shapeToSoup(made)

    return {
      over: geometryFromSoup(overSoup),
      under: geometryFromSoup(underSoup),
      overDistance: new Array<number>(Math.floor(overSoup.triangles.length / 3)).fill(fuzzy),
      underDistance: new Array<number>(Math.floor(underSoup.triangles.length / 3)).fill(fuzzy),
      overVolume: signedVolume(overSoup),
      underVolume: signedVolume(underSoup),
      primaryVolume: signedVolume(primarySoup),
    }
  } catch {
    return null
  }
}
