import { BoxGeometry, BufferGeometry, Float32BufferAttribute, Matrix4 } from 'three'
import { describe, expect, it } from 'vitest'
import {
  booleanDiff,
  cachedBooleanDiff,
  type DiffSoup,
  diffAlpha,
  extractComponents,
  toWorldSoup,
} from './booleanDiff'

const IDENTITY = new Matrix4()

/** A box soup centred on (cx, cy, cz) — outward winding, like an OCC tessellation. */
function boxSoup(w: number, h: number, d: number, cx = 0, cy = 0, cz = 0): DiffSoup {
  const geometry = new BoxGeometry(w, h, d)
  geometry.translate(cx, cy, cz)
  const position = geometry.getAttribute('position')
  const index = geometry.getIndex()
  return {
    vertices: Array.from(position.array as Float32Array),
    triangles: index ? Array.from(index.array as Uint16Array | Uint32Array) : [],
  }
}

describe('boolean diff (STEP is ideal)', () => {
  it('is empty for identical models', () => {
    const result = booleanDiff([boxSoup(10, 10, 10)], [boxSoup(10, 10, 10)], IDENTITY, IDENTITY)
    expect(result).not.toBeNull()
    expect(result?.over).toBeNull()
    expect(result?.under).toBeNull()
    expect(result?.primaryVolume).toBeCloseTo(1000, 0)
  })

  it('finds undercut (leftover) around a smaller STEP ideal', () => {
    // Manufactured 10³, STEP ideal 7³ centred inside. The hollow boolean is two
    // shells: the outer boundary stands 1.5 mm clear and renders (as a 10³ skin),
    // while the cavity walls lie exactly on the ideal and drop.
    const result = booleanDiff([boxSoup(10, 10, 10)], [boxSoup(7, 7, 7)], IDENTITY, IDENTITY)
    expect(result?.under).not.toBeNull()
    expect(result?.over).toBeNull()
    expect(result?.underVolume ?? 0).toBeCloseTo(1000, -1)
  })

  it('finds overcut when the STEP ideal is bigger', () => {
    // Manufactured 7³, STEP ideal 10³: mirrors the undercut case.
    const result = booleanDiff([boxSoup(7, 7, 7)], [boxSoup(10, 10, 10)], IDENTITY, IDENTITY)
    expect(result?.under).toBeNull()
    expect(result?.over).not.toBeNull()
    expect(result?.overVolume ?? 0).toBeCloseTo(1000, -1)
  })

  it('splits a half-overlap into over and under', () => {
    // Two 10³ boxes offset 5 along x: overlap is 5×10×10 = 500 each way.
    const result = booleanDiff(
      [boxSoup(10, 10, 10, 0, 0, 0)],
      [boxSoup(10, 10, 10, 5, 0, 0)],
      IDENTITY,
      IDENTITY,
    )
    expect(result?.overVolume ?? 0).toBeCloseTo(500, -1)
    expect(result?.underVolume ?? 0).toBeCloseTo(500, -1)
  })

  it('hides sub-tolerance skins', () => {
    // 9.5³ inside 10³: faces sit 0.25 mm out — below laser discernment, not drawn.
    const result = booleanDiff([boxSoup(10, 10, 10)], [boxSoup(9.5, 9.5, 9.5)], IDENTITY, IDENTITY)
    expect(result?.under).toBeNull()
    expect(result?.underVolume ?? -1).toBe(0)
    expect(result?.over).toBeNull()
  })

  it('drops a far-but-tiny crumb yet keeps a chunky small leftover', () => {
    const big = boxSoup(10, 10, 10)
    const crumb = boxSoup(1, 1, 1, 20, 0, 0) // disjoint 1 mm³ flake, far off the surface
    const knob = boxSoup(5, 5, 5, -30, 0, 0) // 125 mm³ and chunky
    const merged = toWorldSoup([big, crumb, knob], IDENTITY)
    const result = booleanDiff([merged], [big], IDENTITY, IDENTITY)
    expect(result?.underVolume ?? 0).toBeCloseTo(125, 0)
  })

  it('ignores a skin rescued by a lone spike', () => {
    // A 20×20×0.1 closed plate (~3k tris) hovering 0.02 over a table, with one
    // corner column pulled 2 mm out: only the spike's handful of triangles stand
    // clear (<1 % share), so the whole skin drops.
    const table = boxSoup(100, 100, 10)
    const plate = new BoxGeometry(20, 20, 0.1, 16, 16, 1)
    plate.translate(0, 0, 5.07)
    const position = plate.getAttribute('position')
    for (let v = 0; v < position.count; v++) {
      if (position.getX(v) > 9.9 && position.getY(v) > 9.9) {
        position.setZ(v, position.getZ(v) + 2)
      }
    }
    const index = plate.getIndex()
    const plateSoup: DiffSoup = {
      vertices: Array.from(position.array as Float32Array),
      triangles: index ? Array.from(index.array as Uint16Array | Uint32Array) : [],
    }
    const merged = toWorldSoup([table, plateSoup], IDENTITY)
    const result = booleanDiff([merged], [table], IDENTITY, IDENTITY)
    expect(result?.under).toBeNull()
    expect(result?.underVolume ?? -1).toBe(0)
  })

  it('keeps a tilted plate', () => {
    // Same plate tipped ~8° and 2 mm thick: a large share stands over 1 mm
    // clear and the plate is chunky, so it renders whole.
    const table = boxSoup(100, 100, 10)
    const plate = new BoxGeometry(20, 20, 2, 16, 16, 1)
    plate.translate(0, 0, 6.07)
    plate.rotateX((8 * Math.PI) / 180)
    const position = plate.getAttribute('position')
    const index = plate.getIndex()
    const plateSoup: DiffSoup = {
      vertices: Array.from(position.array as Float32Array),
      triangles: index ? Array.from(index.array as Uint16Array | Uint32Array) : [],
    }
    const merged = toWorldSoup([table, plateSoup], IDENTITY)
    const result = booleanDiff([merged], [table], IDENTITY, IDENTITY)
    expect(result?.under).not.toBeNull()
    expect(result?.underVolume ?? 0).toBeGreaterThan(100)
  })

  it('trims a thin sheet to its far faces instead of drawing it whole', () => {
    // Closed 20×20×0.2 box hovering over a table, one third lifted 2 mm: the
    // sheet is thin, so only the lifted share renders — but the volume stays
    // the component's own (signed sums over open patch shells are meaningless).
    const table = boxSoup(100, 100, 10)
    const plate = new BoxGeometry(20, 20, 0.2, 16, 16, 1)
    plate.translate(0, 0, 5.12)
    const position = plate.getAttribute('position')
    for (let v = 0; v < position.count; v++) {
      if (position.getY(v) > 5) position.setZ(v, position.getZ(v) + 2)
    }
    const index = plate.getIndex()
    const plateSoup: DiffSoup = {
      vertices: Array.from(position.array as Float32Array),
      triangles: index ? Array.from(index.array as Uint16Array | Uint32Array) : [],
    }
    const fullTris = Math.floor(plateSoup.triangles.length / 3)
    const merged = toWorldSoup([table, plateSoup], IDENTITY)
    const result = booleanDiff([merged], [table], IDENTITY, IDENTITY)
    expect(result?.under).not.toBeNull()
    expect(result?.underVolume ?? 0).toBeCloseTo(80, 0)
    const drawnTris = Math.floor((result?.under?.getAttribute('position')?.count ?? 0) / 3)
    expect(drawnTris).toBeGreaterThan(0)
    expect(drawnTris).toBeLessThan(fullTris)
  })

  it('bails out over the triangle budget', () => {
    const big = boxSoup(10, 10, 10)
    const huge: DiffSoup = {
      vertices: big.vertices,
      // Far more triangles than the budget allows (indices cycle the 8 vertices).
      triangles: Array.from({ length: 3_000_000 }, (_, i) => i % 8),
    }
    expect(booleanDiff([huge], [big], IDENTITY, IDENTITY)).toBeNull()
  })

  it('serves repeat mounts from the cache', () => {
    const primaryBytes = new Uint8Array([1, 2, 3])
    const compareBytes = new Uint8Array([4, 5, 6])
    const a = [boxSoup(10, 10, 10, 0, 0, 0)]
    const b = [boxSoup(10, 10, 10, 5, 0, 0)]
    const first = cachedBooleanDiff(a, b, IDENTITY, IDENTITY, primaryBytes, compareBytes)
    const second = cachedBooleanDiff(a, b, IDENTITY, IDENTITY, primaryBytes, compareBytes)
    expect(first).not.toBeNull()
    expect(second?.overVolume).toBe(first?.overVolume)
    expect(second?.underVolume).toBe(first?.underVolume)
    // Fresh geometries each call (caller-disposed), same content.
    expect(second?.over).not.toBe(first?.over)
    expect(second?.under?.getAttribute('position')?.count).toBe(
      first?.under?.getAttribute('position')?.count,
    )
  })
})

function soupGeometry(soup: DiffSoup): BufferGeometry {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(soup.vertices, 3))
  geometry.setIndex(soup.triangles)
  return geometry
}

describe('extractComponents', () => {
  it('splits disjoint boxes into components with volumes', () => {
    const merged = toWorldSoup([boxSoup(10, 10, 10), boxSoup(5, 5, 5, 30, 0, 0)], IDENTITY)
    const components = extractComponents(soupGeometry(merged)).sort((a, b) => b.volume - a.volume)
    expect(components.length).toBe(2)
    expect(components[0]?.volume ?? 0).toBeCloseTo(1000, 0)
    expect(components[1]?.volume ?? 0).toBeCloseTo(125, 0)
  })

  it('keeps an open sheet as one component', () => {
    const grid = new BoxGeometry(20, 20, 0.2, 4, 4, 1)
    const position = grid.getAttribute('position')
    const index = grid.getIndex()
    // Drop the bottom face group (+x, -x, +y, -y, +z, -z order in BoxGeometry).
    const bottom = grid.groups[5]
    const full = Array.from(index?.array as Uint16Array | Uint32Array)
    const open: DiffSoup = {
      vertices: Array.from(position.array as Float32Array),
      triangles: [
        ...full.slice(0, bottom?.start ?? 0),
        ...full.slice((bottom?.start ?? 0) + (bottom?.count ?? 0)),
      ],
    }
    const components = extractComponents(soupGeometry(open))
    expect(components.length).toBe(1)
    // Union holds on open geometry (exact signed sum depends on group surgery).
    expect(components[0]?.volume ?? 0).toBeGreaterThan(0)
  })
})

describe('diffAlpha', () => {
  it('hides the thinnest fringe and saturates real cuts', () => {
    expect(diffAlpha(0)).toBe(0)
    expect(diffAlpha(1)).toBe(0)
    const mid = diffAlpha(1.5)
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(1)
    expect(diffAlpha(2)).toBe(1)
    expect(diffAlpha(100)).toBe(1)
    // Monotonic: nearer never renders stronger than farther.
    let last = -1
    for (let d = 0; d <= 5; d += 0.25) {
      const a = diffAlpha(d)
      expect(a).toBeGreaterThanOrEqual(last)
      last = a
    }
  })
})
