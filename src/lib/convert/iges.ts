import { getOC } from 'replicad'
import { ensureOc } from '@/lib/step/occInit'

/**
 * IGES → STEP through the same OpenCASCADE kernel the app already uses.
 *
 * The stock `replicad-opencascadejs` build does not compile OCCT's IGES translator, so this module
 * is deliberately a thin wrapper around raw `getOC()` bindings: when the kernel is the IGES-enabled
 * build (`pnpm build-iges-kernel`), the classes are present and this works unchanged. When it is
 * not, the caller gets a typed error instead of a generic "undefined is not a constructor".
 *
 * The import keeps the real B-rep (lines, arcs, B-splines, trimmed surfaces), so the exported STEP
 * has true curves — it is not a triangulated mesh.
 */

export class IgesKernelMissingError extends Error {
  constructor() {
    super(
      'IGES support is not compiled into this OCCT kernel. Run `pnpm build-iges-kernel` once, then rebuild or reload the app.',
    )
    this.name = 'IgesKernelMissingError'
  }
}

interface IgesReader {
  ReadFile: (path: string) => string
  NbRootsForTransfer: () => number
  TransferRoots: () => number
  OneShape: () => unknown
  delete: () => void
}

interface StepWriter {
  Transfer: (shape: unknown, mode: unknown, name?: string) => unknown
  Write: (path: string) => unknown
}

interface IgesOc {
  IGESControl_Reader?: new () => IgesReader
  IFSelect_ReturnStatus?: { IFSelect_RetDone: string }
  STEPControl_Writer: new () => StepWriter
  STEPControl_AsIs: unknown
  Interface_Static: {
    SetCVal: (key: string, value: string) => void
    SetIVal: (key: string, value: number) => void
  }
  FS: {
    writeFile: (path: string, data: Uint8Array) => void
    readFile: (path: string, options?: unknown) => string | Uint8Array
    unlink?: (path: string) => void
  }
}

/** Whether the loaded kernel has the IGES translator compiled in. */
export function hasIgesSupport(): boolean {
  const oc = getOC() as unknown as IgesOc
  return typeof oc.IGESControl_Reader === 'function'
}

export interface IgesImportResult {
  step: string
  /** Root entities the reader found (products/surfaces). */
  roots: number
}

/**
 * Read an IGES file and write it back out as STEP (AP203, no assembly). Throws
 * {@link IgesKernelMissingError} when the kernel has no translator, and a plain `Error` when the
 * file cannot be translated.
 */
export async function igesToStep(
  bytes: Uint8Array,
  options: { schema?: 'AP203' | 'AP214IS' | 'AP242DIS'; name?: string } = {},
): Promise<IgesImportResult> {
  await ensureOc()
  const oc = getOC() as unknown as IgesOc
  if (typeof oc.IGESControl_Reader !== 'function') throw new IgesKernelMissingError()

  const inputPath = '/iges-input.igs'
  const outputPath = '/iges-output.step'
  oc.FS.writeFile(inputPath, new Uint8Array(bytes))

  const reader = new oc.IGESControl_Reader()
  try {
    const status = reader.ReadFile(inputPath)
    const done = oc.IFSelect_ReturnStatus?.IFSelect_RetDone ?? 'IFSelect_RetDone'
    if (status !== done) {
      throw new Error(`IGES reader could not load the file (status ${status})`)
    }
    const roots = reader.NbRootsForTransfer()
    if (roots === 0) throw new Error('IGES file carries no transferable roots')
    reader.TransferRoots()
    const shape = reader.OneShape()
    if (!shape) throw new Error('IGES reader produced no shape')

    const writer = new oc.STEPControl_Writer()
    oc.Interface_Static.SetCVal('write.step.schema', options.schema ?? 'AP203')
    oc.Interface_Static.SetIVal('write.step.assembly', 0)
    writer.Transfer(shape, oc.STEPControl_AsIs, options.name ?? '')
    writer.Write(outputPath)
    const content = oc.FS.readFile(outputPath, { encoding: 'utf8' })
    const step = typeof content === 'string' ? content : new TextDecoder().decode(content)
    return { step, roots }
  } finally {
    reader.delete()
    oc.FS.unlink?.(inputPath)
    oc.FS.unlink?.(outputPath)
  }
}
