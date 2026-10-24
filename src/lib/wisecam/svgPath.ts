export type SvgPoint = [number, number]

export interface SvgSubpath {
  points: SvgPoint[]
  closed: boolean
}

export class SvgPathError extends Error {
  readonly offset: number

  constructor(message: string, offset: number) {
    super(`${message} at ${offset}`)
    this.name = 'SvgPathError'
    this.offset = offset
  }
}

const COMMANDS = new Set(['M', 'm', 'L', 'l', 'H', 'h', 'V', 'v', 'A', 'a', 'Z', 'z'])
const SEPARATORS = new Set([' ', '\t', '\n', '\r', ','])

class Scanner {
  index = 0

  constructor(private readonly text: string) {}

  get done(): boolean {
    this.skip()
    return this.index >= this.text.length
  }

  peek(): string {
    return this.text[this.index] ?? ''
  }

  skip(): void {
    while (this.index < this.text.length && SEPARATORS.has(this.text[this.index] as string)) {
      this.index++
    }
  }

  readCommand(): string {
    this.skip()
    const char = this.peek()
    if (!COMMANDS.has(char)) throw new SvgPathError(`expected a command, got "${char}"`, this.index)
    this.index++
    return char
  }

  readNumber(): number {
    this.skip()
    const start = this.index
    const text = this.text
    let char = text[this.index]
    if (char === '+' || char === '-') this.index++
    let digits = 0
    while (this.index < text.length) {
      char = text[this.index]
      if (char >= '0' && char <= '9') {
        digits++
        this.index++
      } else {
        break
      }
    }
    if (text[this.index] === '.') {
      this.index++
      while (this.index < text.length) {
        char = text[this.index]
        if (char >= '0' && char <= '9') {
          digits++
          this.index++
        } else {
          break
        }
      }
    }
    if (digits === 0) throw new SvgPathError('expected a number', start)
    char = text[this.index]
    if (char === 'e' || char === 'E') {
      this.index++
      char = text[this.index]
      if (char === '+' || char === '-') this.index++
      let exponentDigits = 0
      while (this.index < text.length) {
        char = text[this.index]
        if (char >= '0' && char <= '9') {
          exponentDigits++
          this.index++
        } else {
          break
        }
      }
      if (exponentDigits === 0) throw new SvgPathError('expected an exponent', this.index)
    }
    const value = Number(text.slice(start, this.index))
    if (!Number.isFinite(value)) throw new SvgPathError('invalid number', start)
    return value
  }

  readFlag(): 0 | 1 {
    this.skip()
    const char = this.peek()
    if (char !== '0' && char !== '1') {
      throw new SvgPathError(`expected an arc flag (0/1), got "${char}"`, this.index)
    }
    this.index++
    return char === '1' ? 1 : 0
  }
}

function vectorAngle(ux: number, uy: number, vx: number, vy: number): number {
  const dot = ux * vx + uy * vy
  const length = Math.hypot(ux, uy) * Math.hypot(vx, vy)
  if (length === 0) return 0
  const angle = Math.acos(Math.min(1, Math.max(-1, dot / length)))
  return ux * vy - uy * vx < 0 ? -angle : angle
}

function arcPoints(
  from: SvgPoint,
  rx: number,
  ry: number,
  rotation: number,
  largeArc: boolean,
  sweep: boolean,
  to: SvgPoint,
): SvgPoint[] {
  const [x1, y1] = from
  const [x2, y2] = to
  if (Math.abs(x1 - x2) < 1e-12 && Math.abs(y1 - y2) < 1e-12) return []
  rx = Math.abs(rx)
  ry = Math.abs(ry)
  if (rx < 1e-12 || ry < 1e-12) return [to]

  const phi = (rotation * Math.PI) / 180
  const cosPhi = Math.cos(phi)
  const sinPhi = Math.sin(phi)
  const dx = (x1 - x2) / 2
  const dy = (y1 - y2) / 2
  const x1p = cosPhi * dx + sinPhi * dy
  const y1p = -sinPhi * dx + cosPhi * dy

  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
  if (lambda > 1) {
    const scale = Math.sqrt(lambda)
    rx *= scale
    ry *= scale
  }

  const rx2 = rx * rx
  const ry2 = ry * ry
  const x1p2 = x1p * x1p
  const y1p2 = y1p * y1p
  const denominator = rx2 * y1p2 + ry2 * x1p2
  const numerator = rx2 * ry2 - rx2 * y1p2 - ry2 * x1p2
  const factor =
    (largeArc === sweep ? -1 : 1) *
    Math.sqrt(Math.max(0, denominator === 0 ? 0 : numerator / denominator))
  const cxp = (factor * rx * y1p) / ry
  const cyp = (-factor * ry * x1p) / rx
  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2

  const startVectorX = (x1p - cxp) / rx
  const startVectorY = (y1p - cyp) / ry
  const endVectorX = (-x1p - cxp) / rx
  const endVectorY = (-y1p - cyp) / ry
  const startAngle = vectorAngle(1, 0, startVectorX, startVectorY)
  let delta = vectorAngle(startVectorX, startVectorY, endVectorX, endVectorY)
  if (!sweep && delta > 0) delta -= Math.PI * 2
  if (sweep && delta < 0) delta += Math.PI * 2

  const segments = Math.max(2, Math.ceil((Math.abs(delta) / (Math.PI / 2)) * 16))
  const points: SvgPoint[] = []
  for (let i = 1; i <= segments; i++) {
    const angle = startAngle + (delta * i) / segments
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    points.push([
      cosPhi * rx * cos - sinPhi * ry * sin + cx,
      sinPhi * rx * cos + cosPhi * ry * sin + cy,
    ])
  }
  return points
}

export function parseSvgPath(data: string): SvgSubpath[] {
  const scanner = new Scanner(data)
  const subpaths: SvgSubpath[] = []
  let points: SvgPoint[] = []
  let current: SvgPoint = [0, 0]
  let start: SvgPoint = [0, 0]
  let closed = false
  let command: string | null = null
  let pendingMove = false

  const flush = (): void => {
    if (points.length >= 2) subpaths.push({ points, closed })
    points = []
    closed = false
  }

  while (!scanner.done) {
    const char = scanner.peek()
    if (COMMANDS.has(char)) {
      command = scanner.readCommand()
      pendingMove = command === 'M' || command === 'm'
      if (command === 'Z' || command === 'z') {
        closed = points.length >= 2
        flush()
        current = start
        command = null
        continue
      }
    } else if (!command) {
      throw new SvgPathError('path data must start with a command', scanner.index)
    }

    const cmd = command as string
    const relative = cmd === cmd.toLowerCase()
    const upper = cmd.toUpperCase()

    if (upper === 'M') {
      const x = scanner.readNumber()
      const y = scanner.readNumber()
      const point: SvgPoint = relative ? [current[0] + x, current[1] + y] : [x, y]
      if (pendingMove) {
        flush()
        points = [point]
        start = point
        pendingMove = false
      } else {
        points.push(point)
      }
      current = point
      continue
    }

    if (upper === 'L') {
      const x = scanner.readNumber()
      const y = scanner.readNumber()
      const point: SvgPoint = relative ? [current[0] + x, current[1] + y] : [x, y]
      points.push(point)
      current = point
      continue
    }

    if (upper === 'H') {
      const x = scanner.readNumber()
      const point: SvgPoint = [relative ? current[0] + x : x, current[1]]
      points.push(point)
      current = point
      continue
    }

    if (upper === 'V') {
      const y = scanner.readNumber()
      const point: SvgPoint = [current[0], relative ? current[1] + y : y]
      points.push(point)
      current = point
      continue
    }

    if (upper === 'A') {
      const rx = scanner.readNumber()
      const ry = scanner.readNumber()
      const rotation = scanner.readNumber()
      const largeArc = scanner.readFlag() === 1
      const sweep = scanner.readFlag() === 1
      const x = scanner.readNumber()
      const y = scanner.readNumber()
      const to: SvgPoint = relative ? [current[0] + x, current[1] + y] : [x, y]
      points.push(...arcPoints(current, rx, ry, rotation, largeArc, sweep, to))
      current = to
      continue
    }

    throw new SvgPathError(`unsupported command "${command}"`, scanner.index)
  }

  flush()
  return subpaths
}

export function pointsToSubpath(points: SvgPoint[], closed = false): SvgSubpath {
  return { points, closed }
}

export function rotatePoints(points: SvgPoint[], angle: number, cx = 0, cy = 0): SvgPoint[] {
  const radians = (angle * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return points.map(([x, y]) => {
    const dx = x - cx
    const dy = y - cy
    return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos]
  })
}

export interface RotateTransform {
  angle: number
  cx: number
  cy: number
}

export function parseRotateTransform(transform: string | undefined): RotateTransform | null {
  if (!transform) return null
  const match = /rotate\(\s*(-?[\d.]+)(?:[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+))?\s*\)/.exec(transform)
  if (!match) return null
  const angle = Number(match[1])
  const cx = match[2] == null ? 0 : Number(match[2])
  const cy = match[3] == null ? 0 : Number(match[3])
  if (![angle, cx, cy].every(Number.isFinite)) return null
  return { angle, cx, cy }
}
