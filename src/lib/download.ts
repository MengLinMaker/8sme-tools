export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

export function downloadText(filename: string, text: string, mime = 'text/csv'): void {
  downloadBlob(filename, new Blob([text], { type: `${mime};charset=utf-8` }))
}
