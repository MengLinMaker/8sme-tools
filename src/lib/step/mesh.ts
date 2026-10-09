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

export async function meshStepFile(name: string, bytes: Uint8Array): Promise<ReplicadMesh[]> {
  await ensureOc()
  const { importSTEP } = await import('replicad')
  const blob = new Blob([new Uint8Array(bytes)], { type: 'model/step' })
  const shape = (await importSTEP(blob)) as unknown as MeshableShape
  try {
    return [
      {
        name,
        faces: shape.mesh({ tolerance: 0.1, angularTolerance: 20 }),
        edges: shape.meshEdges({ tolerance: 0.1, angularTolerance: 20 }),
      },
    ]
  } finally {
    shape.delete()
  }
}
