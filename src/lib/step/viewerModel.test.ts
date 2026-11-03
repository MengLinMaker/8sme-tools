import { beforeEach, describe, expect, it, vi } from 'vitest'

const { reconstruct } = vi.hoisted(() => ({ reconstruct: vi.fn() }))

vi.mock('./stepPool', () => ({
  getStepWorkerPool: () => ({ reconstruct }),
  PRIORITY_FOREGROUND: 10,
}))

import {
  clearViewerModels,
  peekReconstructForViewer,
  reconstructForViewer,
  reconstructViewerWithSabre,
  sabreForViewer,
} from './viewerModel'

describe('viewerModel reconstruction cache', () => {
  beforeEach(() => {
    clearViewerModels()
    reconstruct.mockReset()
    reconstruct.mockResolvedValue({
      step: 'ISO-10303-21;',
      measure: null,
      sabre: [],
    })
  })

  it('builds the viewer STEP + sabre once and serves the viewer from that build', async () => {
    const combined = await reconstructViewerWithSabre('NC-TEXT')
    expect(combined.bytes).not.toBeNull()
    expect(reconstruct).toHaveBeenCalledTimes(1)
    expect(reconstruct.mock.calls[0]?.[1]).toMatchObject({ sabre: true })

    // The probe does not change the solid, so the same build primes the plain viewer key.
    expect(peekReconstructForViewer('NC-TEXT')).toBe(combined.bytes)
    const viewer = await reconstructForViewer('NC-TEXT')
    expect(viewer).toBe(combined.bytes)
    expect(reconstruct).toHaveBeenCalledTimes(1)
  })

  it('keeps a probe-only (measureOnly) build on its own cache key', async () => {
    await reconstructViewerWithSabre('NC-TEXT')
    await sabreForViewer('NC-TEXT', { measureOnly: true })
    expect(reconstruct).toHaveBeenCalledTimes(2)
  })
})
