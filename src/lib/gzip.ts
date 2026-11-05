/**
 * Browser-side helpers for the embedded assets used by the single-file build.
 * The assets are stored gzip-compressed + base64 encoded so the portable HTML stays as small as
 * possible; they are inflated only when a feature first needs them.
 */

export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export async function gunzipBase64(base64: string): Promise<Uint8Array> {
  const compressed = base64ToBytes(base64)
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

export async function gunzipBase64ToArrayBuffer(base64: string): Promise<ArrayBuffer> {
  const bytes = await gunzipBase64(base64)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
