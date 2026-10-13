import { BufferGeometry, Float32BufferAttribute, Matrix4, Quaternion, Vector3 } from 'three'
import type { BooleanDiff, DiffSoup } from './booleanDiff'
import { meshStepFile } from './mesh'
import { ensureOc } from './occInit'

/** One diff solid serialised for the worker boundary: plain typed arrays, no `BufferGeometry`. */
export interface DiffSolidPayload {
  /** Non-indexed triangle positions (3 floats per vertex). */
  position: Float32Array
  /** Per-vertex normals for `position`, when the source carried them. */
  normal: Float32Array | null
}

/** Over/under solids plus the volumes the legend needs — the cloneable form of {@link BooleanDiff}. */
export interface DiffPayload {
  over: DiffSolidPayload | null
  under: DiffSolidPayload | null
  overVolume: number
  underVolume: number
  primaryVolume: number
}

function serializeGeometry(geometry: BufferGeometry | null): DiffSolidPayload | null {
  if (!geometry) return null
  const position = geometry.getAttribute('position')
  if (!position) return null
  const normal = geometry.getAttribute('normal')
  return {
    position:
      position.array instanceof Float32Array ? position.array : new Float32Array(position.array),
    normal: normal
      ? normal.array instanceof Float32Array
        ? normal.array
        : new Float32Array(normal.array)
      : null,
  }
}

/**
 * Flattens an {@link occFuzzyDiff} result into a structured-cloneable payload, so the boolean can run
 * in the OCC worker and its geometry cross the thread boundary (three objects cannot be posted).
 */
export function serializeDiff(diff: BooleanDiff | null): DiffPayload | null {
  if (!diff) return null
  return {
    over: serializeGeometry(diff.over),
    under: serializeGeometry(diff.under),
    overVolume: diff.overVolume,
    underVolume: diff.underVolume,
    primaryVolume: diff.primaryVolume,
  }
}

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
 * Floor on a diff solid's implied wall thickness (`2·V/A`, see {@link impliedThickness}). A cut whose
 * "solid" is thinner than this is the near-coincident membrane ("skin") the fuzzy scan must skip, not
 * a real over/under. Below the machine/kerf tolerance, so no genuine cut is that thin anyway.
 */
export const MIN_SOLID_THICKNESS_MM = 0.5
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
  const normals: number[] = []
  const triangles: number[] = []
  for (const body of meshed.bodies) {
    const base = vertices.length / 3
    for (const v of body.mesh.faces.vertices) vertices.push(v)
    const faceNormals = body.mesh.faces.normals
    if (faceNormals) for (const n of faceNormals) normals.push(n)
    for (const t of body.mesh.faces.triangles) triangles.push(t + base)
  }
  // OCC shades each surface from its own normals (smooth across curves, sharp at edges); keep them so
  // the diff reads as a shaded solid like the base body. Only usable when every body supplied them.
  const usableNormals = normals.length === vertices.length ? normals : undefined
  return { vertices, triangles, normals: usableNormals }
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
  const soupNormals = soup.normals
  if (soupNormals && soupNormals.length === soup.vertices.length) {
    const normals = new Float32Array(positions.length)
    for (let i = 0; i < soup.triangles.length; i++) {
      const source = (soup.triangles[i] ?? 0) * 3
      normals[i * 3] = soupNormals[source] as number
      normals[i * 3 + 1] = soupNormals[source + 1] as number
      normals[i * 3 + 2] = soupNormals[source + 2] as number
    }
    geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3))
  } else {
    geometry.computeVertexNormals()
  }
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

/** A triangle soup's total surface area (mm²). */
function surfaceArea({ vertices, triangles }: DiffSoup): number {
  let area = 0
  for (let t = 0; t < Math.floor(triangles.length / 3); t++) {
    const a = (triangles[t * 3] ?? 0) * 3
    const b = (triangles[t * 3 + 1] ?? 0) * 3
    const c = (triangles[t * 3 + 2] ?? 0) * 3
    const ux = (vertices[b] as number) - (vertices[a] as number)
    const uy = (vertices[b + 1] as number) - (vertices[a + 1] as number)
    const uz = (vertices[b + 2] as number) - (vertices[a + 2] as number)
    const vx = (vertices[c] as number) - (vertices[a] as number)
    const vy = (vertices[c + 1] as number) - (vertices[a + 1] as number)
    const vz = (vertices[c + 2] as number) - (vertices[a + 2] as number)
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2
  }
  return area
}

/**
 * Implied wall thickness of a diff solid: `2·V/A` is a thin shell's thickness (and a chunky solid's
 * ≈ side/3). A value under {@link MIN_SOLID_THICKNESS_MM} means the cut is a near-coincident membrane
 * — the "skin" artifact — not real material, however small its volume happens to be.
 */
function impliedThickness(volume: number, soup: DiffSoup): number {
  const area = surfaceArea(soup)
  return area > 0 ? (2 * volume) / area : Number.POSITIVE_INFINITY
}

/**
 * Runs the fuzzy boolean between the manufactured (`primaryBytes`) and STEP (`compareBytes`) models.
 * Each is seated by its viewer matrix; both default to identity. The NC and STEP are independent
 * pipelines built in their own frames, so the worker passes the STEP's alignment (from
 * {@link alignToReference}) as `compareMatrix` — the two are not in a shared frame otherwise. Returns
 * the same shape as {@link BooleanDiff}, or null when the kernel fails (the caller falls back to
 * surface flagging).
 */
export async function occFuzzyDiff(
  primaryBytes: Uint8Array,
  compareBytes: Uint8Array,
  primaryMatrix: Matrix4 = new Matrix4(),
  compareMatrix: Matrix4 = new Matrix4(),
  fuzzy = OCC_FUZZY_MM,
): Promise<BooleanDiff | null> {
  await ensureOc()
  const { cast, getOC, importSTEP, measureVolume } = await import('replicad')
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

    // Model volumes (B-rep when available, else the mesh estimate).
    let madeVolume = signedVolume(primarySoup)
    let idealVolume = signedVolume(idealSoup)
    try {
      madeVolume = measureVolume(cast(made as never) as never)
      idealVolume = measureVolume(cast(ideal as never) as never)
    } catch {
      // keep the mesh volumes
    }
    // A correct cut matches the common-derived volumes to tessellation precision; a merged cut does
    // not (it returns ≈ the whole operand). 5 % of the larger model absorbs tessellation drift yet
    // sits far below any kernel merge.
    const agreeTolerance = Math.max(madeVolume, idealVolume) * 0.05

    const boolean = (kind: string, a: unknown, b: unknown, f: number): unknown => {
      const op = new oc[kind](a, b)
      // Crucial: without this the boolean mutates its arguments in place, so reusing `made`/`ideal`
      // across the common + two cuts (and the fuzzy retries) corrupts them and the results go
      // non-deterministic.
      op.SetNonDestructive(true)
      op.SetFuzzyValue(f)
      op.Build()
      if (!op.IsDone()) throw new Error('occ boolean failed')
      return op.Shape()
    }

    // The true over/under follow from the common volume: for solids, |A−B| = A − (A∩B) exactly. The
    // common is taken at the **same fuzzy as the cuts**, so the sub-mm reconstruction offset counts
    // as coincident (a matching part's expected over/under is ≈ 0, not a thin shell over its whole
    // surface — that shell is the "long stretches of skin"). A kernel merge, by contrast, returns
    // ≈ the whole operand and cannot agree with the common, so it is rejected.
    const commonVolumeAt = async (f: number): Promise<number> =>
      signedVolume(await shapeToSoup(boolean('BRepAlgoAPI_Common', made, ideal, f)))

    // Auto-tune: scan candidate fuzzy values largest-first until both cuts agree with the common.
    // The first workable value wins, so the largest margin that does not merge.
    for (const f of OCC_FUZZY_STEPS) {
      if (f > fuzzy) continue
      try {
        const commonVolume = await commonVolumeAt(f)
        const expectedOver = Math.max(0, idealVolume - commonVolume)
        const expectedUnder = Math.max(0, madeVolume - commonVolume)
        const agrees = (value: number, expected: number): boolean =>
          Math.abs(value - expected) <= agreeTolerance
        const overSoup = await shapeToSoup(boolean('BRepAlgoAPI_Cut', ideal, made, f))
        const underSoup = await shapeToSoup(boolean('BRepAlgoAPI_Cut', made, ideal, f))
        const overVolume = signedVolume(overSoup)
        const underVolume = signedVolume(underSoup)
        const sane =
          Number.isFinite(overVolume) &&
          Number.isFinite(underVolume) &&
          // A failed cut returns ≈ the whole operand ("over" ≈ ideal, "under" ≈ manufactured);
          // a real difference is strictly smaller than the model it is taken from.
          overVolume < idealVolume * 0.99 &&
          underVolume < madeVolume * 0.99 &&
          // ...it must not be a paper-thin membrane over the whole part (the "skin" artifact) — a
          // near-coincident pair can cut to a huge-area, near-zero-volume shell that the volume
          // checks below sail through. Reject by implied thickness so the scan falls through to the
          // fuzzy that leaves real material (m180: f=1 → 0.035 mm shell; f=0.2 → 3.4 mm real diff).
          impliedThickness(overVolume, overSoup) >= MIN_SOLID_THICKNESS_MM &&
          impliedThickness(underVolume, underSoup) >= MIN_SOLID_THICKNESS_MM &&
          // ...and it must agree with the common-derived truth (rejects a ~95 % merge).
          agrees(overVolume, expectedOver) &&
          agrees(underVolume, expectedUnder)
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

/** A solid's bounding-box centre/size, and the index of its longest axis (the member). */
function bboxInfo(shape: unknown): { centre: number[]; size: number[]; long: number } {
  const bounds = (shape as { boundingBox: { bounds: [number[], number[]] } }).boundingBox.bounds
  const [min, max] = bounds
  const centre = min.map((v, k) => ((v as number) + (max[k] as number)) / 2)
  const size = min.map((v, k) => (max[k] as number) - (v as number))
  return { centre, size, long: size.indexOf(Math.max(...size)) }
}

/**
 * Seats `subjectBytes` onto `referenceBytes` up to the eight D2 alignments about the member axis
 * (four 90° rotations × mirror), choosing the one with the largest volume overlap.
 *
 * The overlay diff is the only place the **independently-built** NC model (`reference`, canonical)
 * and STEP model (`subject`, its own arbitrary frame) meet — neither pipeline knows the other's
 * frame — so the alignment lives here. The member axes are brought together first (longest box axis
 * → longest box axis, centres aligned), then the remaining rotation/mirror about the member is
 * searched. Returns the transform to apply to the subject; the reference stays put.
 */
export async function alignToReference(
  subjectBytes: Uint8Array,
  referenceBytes: Uint8Array,
): Promise<Matrix4> {
  await ensureOc()
  const { cast, getOC, importSTEP, measureVolume } = await import('replicad')
  const oc = getOC() as any
  const toBlob = (bytes: Uint8Array) => new Blob([new Uint8Array(bytes)], { type: 'model/step' })
  const ref = (await importSTEP(toBlob(referenceBytes))) as unknown as OcShape
  const sub = (await importSTEP(toBlob(subjectBytes))) as unknown as OcShape

  const move = (shape: unknown, m: Matrix4): unknown => {
    const e = m.elements
    const trsf = new oc.gp_Trsf()
    trsf.SetValues(e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14])
    return new oc.BRepBuilderAPI_Transform(
      (shape as { wrapped: unknown }).wrapped,
      trsf,
      true,
    ).Shape()
  }
  const commonVolume = (a: unknown, b: unknown, f: number): number => {
    try {
      const op = new oc.BRepAlgoAPI_Common(a, b)
      op.SetNonDestructive(true)
      op.SetFuzzyValue(f)
      op.Build()
      if (!op.IsDone()) return 0
      return Math.abs(measureVolume(cast(op.Shape()) as never))
    } catch {
      return 0
    }
  }

  const { centre: rc, size: rs } = bboxInfo(ref)
  const refLong = rs.indexOf(Math.max(...rs))
  const { centre: sc, long: subLong } = bboxInfo(sub)
  // Our NC build is canonical (member along X); if a reference is not, keep the caller's frame.
  if (refLong !== 0) return new Matrix4()

  // Bring the subject to the origin with its member along X (`pre`), then search the section
  // rotation/mirror about X **before** shifting onto the reference centre, so the pose stays on it.
  const unit = (axis: number): Vector3 => new Vector3().setComponent(axis, 1)
  const toMember = new Matrix4().makeRotationFromQuaternion(
    new Quaternion().setFromUnitVectors(unit(subLong), unit(0)),
  )
  const recentre = new Matrix4().makeTranslation(-sc[0], -sc[1], -sc[2])
  const pre = new Matrix4().multiplyMatrices(toMember, recentre)
  const toRef = new Matrix4().makeTranslation(rc[0], rc[1], rc[2])

  let best: Matrix4 | null = null
  let bestVolume = -1
  for (const mirrored of [false, true]) {
    for (const angle of [0, 90, 180, 270]) {
      const section = new Matrix4()
      if (angle) section.makeRotationX((angle * Math.PI) / 180)
      if (mirrored) section.multiply(new Matrix4().makeScale(1, -1, 1))
      const candidate = new Matrix4().multiplyMatrices(
        toRef,
        new Matrix4().multiplyMatrices(section, pre),
      )
      const volume = commonVolume((ref as { wrapped: unknown }).wrapped, move(sub, candidate), 0.1)
      if (volume > bestVolume) {
        bestVolume = volume
        best = candidate
      }
    }
  }
  return best ?? new Matrix4()
}

/**
 * Fraction of the reference solid's volume that an aligned subject covers — the "is this the same
 * part" check, independent of either model's native frame. Aligns with {@link alignToReference},
 * then measures the intersection against the reference.
 */
export async function alignedOverlap(
  subjectBytes: Uint8Array,
  referenceBytes: Uint8Array,
): Promise<number> {
  const matrix = await alignToReference(subjectBytes, referenceBytes)
  await ensureOc()
  const { cast, getOC, importSTEP, measureVolume } = await import('replicad')
  const oc = getOC() as any
  const toBlob = (bytes: Uint8Array) => new Blob([new Uint8Array(bytes)], { type: 'model/step' })
  const ref = (await importSTEP(toBlob(referenceBytes))) as unknown as OcShape
  const sub = (await importSTEP(toBlob(subjectBytes))) as unknown as OcShape
  const move = (shape: unknown, m: Matrix4): unknown => {
    const e = m.elements
    const trsf = new oc.gp_Trsf()
    trsf.SetValues(e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14])
    return new oc.BRepBuilderAPI_Transform(
      (shape as { wrapped: unknown }).wrapped,
      trsf,
      true,
    ).Shape()
  }
  const refShape = (ref as { wrapped: unknown }).wrapped
  const refVolume = measureVolume(cast(refShape as never) as never)
  if (!(refVolume > 0)) return 0
  try {
    const op = new oc.BRepAlgoAPI_Common(refShape, move(sub, matrix))
    op.SetNonDestructive(true)
    // Same margin as the alignment search: the reconstruction offset (~a kerf) is sub-mm, so the
    // near-coincident pair would otherwise intersect to nothing.
    op.SetFuzzyValue(0.1)
    op.Build()
    if (!op.IsDone()) return 0
    return measureVolume(cast(op.Shape()) as never) / refVolume
  } catch {
    return 0
  }
}
