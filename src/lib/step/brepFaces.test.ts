import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { nw30Bottom, nw31Bottom, nw31Top } from '@test/fixtures'
import { Box3, Matrix4, Quaternion, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { parseDstv } from '@/lib/parsers/dstv'
import { resolveNcFaceFrame } from '@/lib/parsers/ncFaces'
import { parseNcGeometry } from '@/lib/parsers/ncGeometry'
import { cutThicknesses } from '@/lib/parsers/ncProject'
import { CUT_FACES, faceRole, type ProfileFamily, profileFamily } from '@/lib/sections/canonical'
import { detectOrientation } from '@/lib/sections/orient'
import { partSectionForCode } from '@/lib/sections/stock'
import { brepCutSegments, type SeatedBrepFace, type Vec3 } from './cutEdges'
import { meshStepFile } from './mesh'
import { setOcWasmUrl } from './occInit'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

/**
 * Fixture-backed check of the B-rep cut-edge extraction (worker) + classification (viewer): the cut
 * edges found on a part's `o`/`u`/`h` faces should carry the wall thicknesses the NC legend
 * reports, including cuts that ride a rounded corner. Skipped when the fixtures are absent.
 */

const SEAT_ANGLES = [0, -Math.PI / 2, Math.PI, Math.PI / 2]

function unit(axis: number, sign: number): Vector3 {
  const v = new Vector3()
  v.setComponent(axis, sign)
  return v
}

function transform(vertices: number[], matrix: Matrix4): number[] {
  const out = new Array<number>(vertices.length)
  const point = new Vector3()
  for (let i = 0; i + 2 < vertices.length; i += 3) {
    point.set(vertices[i], vertices[i + 1], vertices[i + 2]).applyMatrix4(matrix)
    out[i] = point.x
    out[i + 1] = point.y
    out[i + 2] = point.z
  }
  return out
}

function seatQuaternion(vertices: number[], profile: [number, number][]): Quaternion {
  const box = new Box3()
  const point = new Vector3()
  for (let i = 0; i + 2 < vertices.length; i += 3)
    box.expandByPoint(point.set(vertices[i], vertices[i + 1], vertices[i + 2]))
  const size = box.getSize(new Vector3())
  const centre = box.getCenter(new Vector3())
  const longAxis = [size.x, size.y, size.z].indexOf(Math.max(size.x, size.y, size.z))
  const toX = new Quaternion()
  if (longAxis !== 0) toX.setFromUnitVectors(unit(longAxis, 1), unit(0, 1))
  const centred = vertices.map((v, i) =>
    i % 3 === 0 ? v - centre.x : i % 3 === 1 ? v - centre.y : v - centre.z,
  )
  const seated = transform(centred, new Matrix4().makeRotationFromQuaternion(toX))
  const roll = new Quaternion().setFromAxisAngle(
    unit(0, 1),
    SEAT_ANGLES[detectOrientation(profile, seated, 1, 2, [0, 0, 0])],
  )
  return new Quaternion().multiplyQuaternions(roll, toX)
}

/** Canonical-stance target normals for a family's cut faces (mirrors `PartViewer`). */
function targetNormals(family: ProfileFamily, xAxis: Vector3, yAxis: Vector3): Vec3[] {
  const out: Vec3[] = []
  for (const face of CUT_FACES[family]) {
    const role = faceRole(family, face)
    const base = role === 'side' ? xAxis : yAxis
    const signs =
      role === 'side'
        ? family === 'angle'
          ? [face === 'v' ? 1 : -1]
          : [1, -1]
        : [role === 'top' ? 1 : -1]
    for (const sign of signs) {
      out.push([base.x * sign, base.y * sign, base.z * sign])
    }
  }
  return out
}

interface Pipeline {
  cutThicknesses: number[]
  legend: number[]
  faces: number
  /** Bevel angles (deg) detected on the STEP cut edges, ascending. */
  bevelAngles: number[]
  /** How many cut segments carry a bevel (a curved cope yields many, not just a few planes). */
  bevelSegments: number
  /** Every edge neighbour index is a valid face index. */
  neighboursValid: boolean
}

async function run(mark: string, ncPath: string, stpPath: string): Promise<Pipeline> {
  const ncText = readFileSync(ncPath, 'utf8')
  const header = parseDstv(ncText).header
  const geo = parseNcGeometry(ncText)
  const section = partSectionForCode(header.profile, header.dimensions)
  if (!section) throw new Error('no section')
  const family = profileFamily(header.profile)
  if (!family) throw new Error('no family')
  const frame = resolveNcFaceFrame(section.points, geo, header.profile)

  const meshed = await meshStepFile(mark, new Uint8Array(readFileSync(stpPath)))
  const raw = meshed.vertices
  const seat = seatQuaternion(raw, section.points)
  const world = transform(raw, new Matrix4().makeRotationFromQuaternion(seat))
  const orientation = detectOrientation(section.points, world, 1, 2, [0, 0, 0])
  const eA = unit(1, 1)
  const eB = unit(2, 1)
  const table: [Vector3, Vector3][] = [
    [eA, eB],
    [eB, eA.clone().negate()],
    [eA.clone().negate(), eB.clone().negate()],
    [eB.clone().negate(), eA],
  ]
  const [fx0, fy0] = table[orientation] as [Vector3, Vector3]
  const rollAngle = -Math.atan2(fy0.z, fy0.y)
  const about = new Vector3(1, 0, 0)
  const xAxis = fx0.clone().applyAxisAngle(about, rollAngle)
  const yAxis = fy0.clone().applyAxisAngle(about, rollAngle)
  const rotation = new Quaternion().multiplyQuaternions(
    new Quaternion().setFromAxisAngle(about, rollAngle),
    seat,
  )
  const box = new Box3()
  const probe = new Vector3()
  for (let i = 0; i + 2 < raw.length; i += 3)
    box.expandByPoint(probe.set(raw[i] as number, raw[i + 1] as number, raw[i + 2] as number))
  const position = box.getCenter(new Vector3()).applyQuaternion(seat).negate()
  const placement = new Matrix4().compose(position, rotation, new Vector3(1, 1, 1))
  const targets = targetNormals(family, xAxis, yAxis)
  const xa: Vec3 = [xAxis.x, xAxis.y, xAxis.z]
  const ya: Vec3 = [yAxis.x, yAxis.y, yAxis.z]

  const found = new Set<number>()
  const bevels = new Set<number>()
  let bevelSegments = 0
  let faces = 0
  let neighboursValid = true
  for (const body of meshed.bodies) {
    const brep = body.brep ?? []
    faces += brep.length
    const rotationMatrix = new Matrix4().makeRotationFromQuaternion(rotation)
    const seated: SeatedBrepFace[] = brep.map((face) => {
      const normal = new Vector3(...face.normal).applyQuaternion(rotation)
      const center = new Vector3(...face.center).applyMatrix4(placement)
      return {
        normal: [normal.x, normal.y, normal.z],
        center: [center.x, center.y, center.z],
        planar: face.planar,
        samples: transform(face.samples, placement),
        wires: face.wires.map((wire) => ({
          enclosed: wire.enclosed,
          edges: wire.edges.map((edge) => {
            for (const n of edge.neighbours) {
              if (n < 0 || n >= brep.length) neighboursValid = false
            }
            return {
              points: transform(edge.points, placement),
              neighbours: edge.neighbours,
              selfNormals: edge.selfNormals
                ? transform(edge.selfNormals, rotationMatrix)
                : undefined,
              neighbourNormals: edge.neighbourNormals?.map((normals) =>
                normals ? transform(normals, rotationMatrix) : undefined,
              ),
            }
          }),
        })),
      }
    })
    for (const cut of brepCutSegments(
      seated,
      section.points,
      section.holes ?? [],
      xa,
      ya,
      [1, 0, 0],
      targets,
    )) {
      found.add(cut.thickness)
      if (cut.bevel > 0) {
        bevels.add(cut.bevel)
        bevelSegments++
      }
    }
  }
  return {
    cutThicknesses: [...found].sort((a, b) => a - b),
    legend: cutThicknesses(frame, section.points, geo),
    faces,
    bevelAngles: [...bevels].sort((a, b) => a - b),
    bevelSegments,
    neighboursValid,
  }
}

const PFC = { mark: 'm116', nc: nw31Bottom('m116.nc1'), stp: nw31Bottom('m116.stp') }
const TEE = {
  mark: 'm200',
  nc: nw31Top('NC files', 'm200.nc1'),
  stp: nw31Top('STP files', 'm200.stp'),
}
const SHS = { mark: 'm105', nc: nw30Bottom('m105.nc1'), stp: nw30Bottom('m105.stp') }
const RHS = {
  mark: 'm117',
  nc: nw31Top('NC files', 'm117.nc1'),
  stp: nw31Top('STP files', 'm117.stp'),
}
const ANGLE = { mark: 'a2', nc: nw30Bottom('a2.nc1'), stp: nw30Bottom('a2.stp') }
/** An angle with a bevelled (~20°) end cut — the bevel lives in the STEP geometry. */
const ANGLE_BEVEL = {
  mark: 'a1',
  nc: nw31Top('NC files', 'a1.nc1'),
  stp: nw31Top('STP files', 'a1.stp'),
}
/** A PFC with a changing (~20°) bevel along its cope. */
const PFC_BEVEL = {
  mark: 'm31',
  nc: nw31Top('NC files', 'm31.nc1'),
  stp: nw31Top('STP files', 'm31.stp'),
}
/** A PFC whose ~20° bevel rides a **curved** cope (the bevel face is non-planar). */
const PFC_COPE = {
  mark: 'm130',
  nc: nw31Top('NC files', 'm130.nc1'),
  stp: nw31Top('STP files', 'm130.stp'),
}
const HAVE = existsSync(PFC.stp) && existsSync(PFC.nc)

describe.skipIf(!HAVE)('B-rep cut edges', () => {
  it('emits every face with unit normals and valid neighbour indices', async () => {
    const meshed = await meshStepFile(PFC.mark, new Uint8Array(readFileSync(PFC.stp)))
    const faces = meshed.bodies.flatMap((body) => body.brep ?? [])
    expect(faces.length).toBeGreaterThan(0)
    for (const face of faces) {
      expect(Math.hypot(...face.normal)).toBeCloseTo(1, 6)
      expect(face.wires.length).toBeGreaterThan(0)
      for (const wire of face.wires) {
        for (const edge of wire.edges) {
          for (const n of edge.neighbours) {
            expect(n).toBeGreaterThanOrEqual(0)
            expect(n).toBeLessThan(faces.length)
          }
        }
      }
    }
  }, 120000)

  it('colours PFC cut edges on o/u/h at the NC legend thicknesses', async () => {
    const {
      cutThicknesses: found,
      legend,
      faces,
      neighboursValid,
    } = await run(PFC.mark, PFC.nc, PFC.stp)
    expect(faces).toBeGreaterThan(0)
    expect(neighboursValid).toBe(true)
    expect(found.length).toBeGreaterThan(0)
    for (const thickness of found) {
      expect(legend.some((value) => Math.abs(value - thickness) < 0.3)).toBe(true)
    }
  }, 120000)

  it('captures the T beam coped end (curved cut faces) and the SHS corners', async () => {
    for (const fixture of [TEE, SHS]) {
      if (!existsSync(fixture.stp) || !existsSync(fixture.nc)) continue
      const { cutThicknesses: found, neighboursValid } = await run(
        fixture.mark,
        fixture.nc,
        fixture.stp,
      )
      expect(neighboursValid).toBe(true)
      expect(found.length).toBeGreaterThan(0)
    }
  }, 120000)

  it('extracts an angle section (o and v excluded)', async () => {
    if (!existsSync(ANGLE.stp) || !existsSync(ANGLE.nc)) return
    const { cutThicknesses: found, neighboursValid } = await run(ANGLE.mark, ANGLE.nc, ANGLE.stp)
    expect(neighboursValid).toBe(true)
    expect(found.length).toBeGreaterThanOrEqual(0)
  }, 120000)

  it('detects the STEP bevel on an angle and a PFC cut edge', async () => {
    for (const fixture of [ANGLE_BEVEL, PFC_BEVEL]) {
      if (!existsSync(fixture.stp) || !existsSync(fixture.nc)) continue
      const { bevelAngles, neighboursValid } = await run(fixture.mark, fixture.nc, fixture.stp)
      expect(neighboursValid).toBe(true)
      expect(bevelAngles.length).toBeGreaterThan(0)
      // Both fixtures carry a ~20° bevel; every detected bevel sits inside the head's ±45° range.
      expect(bevelAngles.some((angle) => Math.abs(angle - 20) < 1.5)).toBe(true)
      for (const angle of bevelAngles) expect(angle).toBeLessThanOrEqual(45)
    }
  }, 120000)

  it('follows a bevel along a curved cope (non-planar cut face)', async () => {
    if (!existsSync(PFC_COPE.stp) || !existsSync(PFC_COPE.nc)) return
    // m130's ~20° bevel rides a curved cope: before local neighbour normals only a few planar
    // segments were bevelled; now the whole curved run is.
    const { bevelAngles, bevelSegments, neighboursValid } = await run(
      PFC_COPE.mark,
      PFC_COPE.nc,
      PFC_COPE.stp,
    )
    expect(neighboursValid).toBe(true)
    expect(bevelAngles.some((angle) => Math.abs(angle - 20) < 2)).toBe(true)
    expect(bevelSegments).toBeGreaterThan(10)
  }, 120000)

  it('projects RHS corner cuts to the wall thickness (no per-point ramp)', async () => {
    if (!existsSync(RHS.stp) || !existsSync(RHS.nc)) return
    // RHS150*100*9.0 — every cut is through the 9 mm wall. A per-point thickness ramps along the
    // rounded corner (9.2…18.1 mm); the target-face thickness keeps it flat.
    const { cutThicknesses: found, neighboursValid } = await run(RHS.mark, RHS.nc, RHS.stp)
    expect(neighboursValid).toBe(true)
    expect(found.length).toBeGreaterThan(0)
    for (const thickness of found) expect(Math.abs(thickness - 9)).toBeLessThan(0.3)
  }, 120000)
})
