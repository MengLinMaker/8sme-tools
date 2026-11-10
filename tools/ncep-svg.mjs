#!/usr/bin/env node
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { strFromU8, unzipSync } from 'fflate'

const HELP = `
Extract the unrolled part SVG (the shape net) from NCEP packages for visual inspection.

Usage:
  pnpm ncep-svg -i <file.ncep|directory|pack.zip> [-o <directory>]

  -i, --input     .ncep, a directory of .ncep files, or a probe-pack .zip of .ncep files
  -o, --output    output directory (default: ncep-svgs)
  -h, --help

Writes one .svg per NCEP part plus index.html and manifest.csv.
`

const { values } = parseArgs({
  options: {
    input: { type: 'string', short: 'i' },
    output: { type: 'string', short: 'o' },
    help: { type: 'boolean', short: 'h' },
  },
})
if (values.help || !values.input) {
  process.stdout.write(HELP)
  process.exit(values.help ? 0 : 2)
}

const input = resolve(values.input)
const outDir = resolve(values.output ? values.output : 'ncep-svgs')

async function collect(dir) {
  const out = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await collect(path)))
    else if (/\.ncep$/i.test(entry.name)) out.push(path)
  }
  return out
}

function safeName(name) {
  return name.replace(/[^\w .()+-]+/g, '_')
}

function splitSvg(svg) {
  const part = svg.match(/<g\b[^>]*wh:class="cadpart"[^>]*>[\s\S]*?<\/g>/)?.[0] ?? ''
  const section = svg.match(/<g\b[^>]*wh:class="cadgroup"[^>]*>[\s\S]*?<\/g>/)?.[0] ?? ''
  return {
    net: part ? svg.replace(section, '') : svg,
    section: section ? svg.replace(part, '') : '',
  }
}

function partSvgs(bytes) {
  const files = unzipSync(bytes)
  const root = strFromU8(files['CAD/CadRoot.xml'] ?? new Uint8Array())
  const names = [...root.matchAll(/<Part\b[^>]*svgname="([^"]+)"/g)].map((m) => m[1])
  const out = []
  for (const name of names) {
    const data = files[`CAD/${name}`]
    if (data) out.push({ name, ...splitSvg(strFromU8(data)) })
  }
  return out
}

async function main() {
  const inputStat = await stat(input)
  const sources = []
  if (inputStat.isDirectory()) {
    sources.push(
      ...(await collect(input)).map((path) => ({ path, label: basename(path, extname(path)) })),
    )
  } else if (/\.zip$/i.test(input) && !/\.ncep$/i.test(input)) {
    const pack = unzipSync(new Uint8Array(await readFile(input)))
    for (const [name, bytes] of Object.entries(pack)) {
      if (/\.ncep$/i.test(name)) sources.push({ bytes, label: basename(name, extname(name)) })
    }
  } else if (/\.ncep$/i.test(input)) {
    sources.push({ path: input, label: basename(input, extname(input)) })
  } else {
    throw new Error('input must be .ncep, a directory, or a .zip probe pack')
  }
  if (sources.length === 0) throw new Error('no .ncep files found')

  await mkdir(outDir, { recursive: true })
  const rows = []
  for (const source of sources) {
    const bytes = source.bytes ?? new Uint8Array(await readFile(source.path))
    const parts = partSvgs(bytes)
    if (parts.length === 0) {
      console.error(`SKIP ${source.label} (no part SVG)`)
      continue
    }
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const suffix = parts.length > 1 ? `-part${i + 1}` : ''
      const stem = `${safeName(source.label)}${suffix}`
      const netFile = `${stem}-net.svg`
      await writeFile(join(outDir, netFile), part.net)
      rows.push({
        source: source.label,
        part: part.name,
        kind: 'net / wrap',
        svg: netFile,
        content: part.net,
      })
      console.log(`OK   ${source.label} -> ${netFile}`)
      if (part.section) {
        const sectionFile = `${stem}-section.svg`
        await writeFile(join(outDir, sectionFile), part.section)
        rows.push({
          source: source.label,
          part: part.name,
          kind: 'section',
          svg: sectionFile,
          content: part.section,
        })
        console.log(`OK   ${source.label} -> ${sectionFile}`)
      }
    }
  }
  await writeFile(
    join(outDir, 'manifest.csv'),
    [
      'source,part,kind,svg',
      ...rows.map((r) => `"${r.source}","${r.part}","${r.kind}","${r.svg}"`),
    ].join('\n') + '\n',
  )
  const htmlEscape = (value) =>
    value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  const inline = (svg) => svg.replace(/^<\?xml[^>]*>\s*/, '')
  const cardRows = []
  for (let i = 0; i < rows.length; i += 2) {
    const net = rows[i]
    const section = rows[i + 1]?.kind === 'section' ? rows[i + 1] : null
    if (!net) continue
    cardRows.push(
      `<figure><figcaption><span>${htmlEscape(net.source)}</span><span><a href="${encodeURI(net.svg)}" target="_blank">open net</a>${section ? `<a href="${encodeURI(section.svg)}" target="_blank">open section</a>` : ''}<button data-zoom>2×</button></span></figcaption><div class="panels"><section><h3>Part net / wrap</h3><div class="net">${inline(net.content)}</div></section>${section ? `<section><h3>Section</h3><div class="net">${inline(section.content)}</div></section>` : ''}</div></figure>`,
    )
  }
  const cards = cardRows.join('\n')
  await writeFile(
    join(outDir, 'index.html'),
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NCEP shape nets</title>
<style>
:root{color-scheme:light}
body{font:14px system-ui,sans-serif;margin:0;background:#e9edf2;color:#101418}
header{position:sticky;top:0;z-index:10;background:#101418;color:#fff;padding:10px 18px;box-shadow:0 2px 8px #0004}
header h1{margin:0;font-size:17px}header p{margin:4px 0 0;color:#cbd5e1}
main{display:flex;flex-direction:column;gap:18px;padding:18px;max-width:1900px;margin:auto}
figure{margin:0;background:#fff;border:1px solid #c5ced8;border-radius:6px;padding:10px;box-shadow:0 1px 2px #0001}
figcaption{display:flex;justify-content:space-between;align-items:center;gap:12px;font-weight:650;margin-bottom:8px}
figcaption span:last-child{display:flex;gap:10px;align-items:center;font-weight:400}
a{color:#0b57d0}button{font:inherit;padding:4px 10px;border:1px solid #9aa8b8;background:#f6f8fa;border-radius:4px;cursor:pointer}
button.active{background:#101418;color:#fff;border-color:#101418}
.panels{display:grid;grid-template-columns:minmax(0,2fr) minmax(280px,1fr);gap:12px}
.panels section{min-width:0}
.panels h3{margin:0 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#475569}
.net{height:clamp(220px,35vh,460px);background:#fff;border:1px solid #dde3ea;border-radius:4px;overflow:hidden;display:flex;align-items:center;justify-content:center;padding:8px}
@media (max-width:900px){.panels{grid-template-columns:1fr}}
.net > svg{display:block;width:100%;height:100%;max-width:100%;max-height:100%}
.net > svg *{stroke:#000 !important;stroke-width:1.4 !important;vector-effect:non-scaling-stroke}
.net > svg text{fill:#000 !important;stroke:none !important;font-weight:700 !important}
figure.zoomed .net{height:70vh;overflow:auto;display:block}
figure.zoomed .net > svg{width:200%;height:auto;max-width:none;max-height:none}
</style>
<header><h1>NCEP shape nets</h1><p>Whole nets are scaled to fit. Use 2× for detail and horizontal scroll.</p></header>
<main>${cards}</main>
<script>
// The NCEP part SVGs have no viewBox. Derive it from the real geometry, then fit the net.
for (const svg of document.querySelectorAll('.net > svg')) {
  try {
    const box = svg.getBBox();
    const pad = 20;
    svg.setAttribute('viewBox', (box.x - pad) + ' ' + (box.y - pad) + ' ' + (box.width + pad * 2) + ' ' + (box.height + pad * 2));
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.removeAttribute('width');
    svg.removeAttribute('height');
  } catch {}
}
for (const button of document.querySelectorAll('[data-zoom]')) {
  button.addEventListener('click', () => {
    const figure = button.closest('figure');
    figure.classList.toggle('zoomed');
    button.classList.toggle('active');
    button.textContent = figure.classList.contains('zoomed') ? 'fit' : '2×';
  });
}
</script>`,
  )
  console.log(`\n${rows.length} SVGs -> ${outDir}`)
}

await main()
