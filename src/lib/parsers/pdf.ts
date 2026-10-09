import type { PdfFile } from '@/lib/audit/types'

function latin1(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i])
  return out
}

export function parsePdfFile(path: string, bytes: Uint8Array): PdfFile {
  const problems: string[] = []
  const head = latin1(bytes.subarray(0, Math.min(1024, bytes.length)))
  const tail = latin1(bytes.subarray(Math.max(0, bytes.length - 2048)))

  if (!head.includes('%PDF-')) problems.push('missing %PDF header')
  if (!tail.includes('%%EOF')) problems.push('missing %%EOF trailer (possibly truncated)')
  if (bytes.length < 128) problems.push('file too small to be a valid PDF')

  return { path, valid: problems.length === 0, problems }
}
