import type {
  ReplicadMesh,
  ReplicadMeshedEdges,
  ReplicadMeshedFaces,
} from 'replicad-threejs-helper'
import { ensureOc } from './occInit'

/**
 * Tessellates a STEP file into triangle/edge meshes ready for three.js.
 *
 * The OpenCASCADE kernel is shared through {@link ensureOc}; the returned meshes
 * are plain arrays so the OCC shape can be freed immediately afterwards.
 */

interface MeshableShape {
  mesh(options?: { tolerance?: number; angularTolerance?: number }): ReplicadMeshedFaces
  meshEdges(options?: { tolerance?: number; angularTolerance?: number }): ReplicadMeshedEdges
  delete(): void
}

interface CompoundShape extends MeshableShape {
  solids: MeshableShape[]
}

const MESH_OPTIONS = { tolerance: 0.1, angularTolerance: 20 }

function meshShape(name: string, shape: MeshableShape): ReplicadMesh {
  return {
    name,
    faces: shape.mesh(MESH_OPTIONS),
    edges: shape.meshEdges(MESH_OPTIONS),
  }
}

/** A single solid body meshed for three.js, flagged as stray or the real part. */
export interface MeshedBody {
  mesh: ReplicadMesh
  /** true when this body is a floating stray — i.e. not the main (largest) part */
  stray: boolean
}

export interface MeshedStep {
  bodies: MeshedBody[]
  /** every body's vertices concatenated, for seating / centring / framing */
  vertices: number[]
}

/**
 * Tessellates a STEP file per solid body. A clean single-body part comes back as one body; a
 * part carrying stray floating solids comes back as several, with every body except the largest
 * (the real part) flagged `stray` so the viewer can colour the problem pieces apart.
 */
export async function meshStepFile(name: string, bytes: Uint8Array): Promise<MeshedStep> {
  await ensureOc()
  const { importSTEP, measureVolume } = await import('replicad')
  const blob = new Blob([new Uint8Array(bytes)], { type: 'model/step' })
  const shape = (await importSTEP(blob)) as unknown as CompoundShape
  try {
    const solids = shape.solids ?? []
    let bodies: MeshedBody[]
    if (solids.length <= 1) {
      bodies = [{ mesh: meshShape(name, shape), stray: false }]
    } else {
      let mainIndex = 0
      let mainVolume = Number.NEGATIVE_INFINITY
      for (let i = 0; i < solids.length; i++) {
        const volume = measureVolume(solids[i] as never)
        if (volume > mainVolume) {
          mainVolume = volume
          mainIndex = i
        }
      }
      bodies = solids.map((solid, index) => ({
        mesh: meshShape(`${name}·body${index}`, solid),
        stray: index !== mainIndex,
      }))
    }
    return { bodies, vertices: bodies.flatMap((body) => body.mesh.faces.vertices) }
  } finally {
    shape.delete()
  }
}
